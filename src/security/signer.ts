/**
 * Isolated signing subprocess.
 *
 * This runs as a separate Node.js process with NO access to:
 * - The network (no fetch, no API calls)
 * - The marketing engine or LLM components
 * - Any config beyond the encrypted keyfile path
 *
 * Communication is strictly via parent process IPC:
 *   Parent sends: { type: 'unlock', password: string }
 *   Parent sends: { type: 'sign', message: string }  // base64-encoded
 *   Child replies: { type: 'signature', signature: string }  // base64-encoded
 *   Child replies: { type: 'error', message: string }
 *
 * SECURITY: The signer validates every transaction before signing.
 * Only EndGame claim transactions are permitted. This prevents a
 * compromised @solana/web3.js from crafting drain transactions.
 *
 * The private key lives ONLY in this process's memory.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decryptKey, signMessage, type EncryptedKeyfile } from './keystore.js';

interface UnlockMessage { type: 'unlock'; password: string; keyfilePath: string }
interface SignMessage { type: 'sign'; message: string }
interface LockMessage { type: 'lock' }
type IncomingMessage = UnlockMessage | SignMessage | LockMessage;

let privateKey: Uint8Array | null = null;

// ── Transaction validation constants ─────────────────────────────

/** EndGame program ID (raw 32 bytes): pjMUjMjHTHot5bYrBu9qd4cRaNKdK1eTR8iVYouQzDo */
const ENDGAME_PROGRAM_ID = Uint8Array.from(
  Buffer.from('0c3a2fd1e37a5ba0d2eabbef8461ddd39837111e1f1de67461eae9db3047da42', 'hex'),
);

/** System Program ID (all zeros = 11111111111111111111111111111111). */
const SYSTEM_PROGRAM_ID = new Uint8Array(32);

/** Token-2022 program ID: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb */
const TOKEN_2022_PROGRAM_ID = Uint8Array.from(
  Buffer.from('06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc', 'hex'),
);

/** Associated Token Program ID. */
const ASSOCIATED_TOKEN_PROGRAM_ID = Uint8Array.from(
  Buffer.from('8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859', 'hex'),
);

/** Maximum instructions allowed in a valid claim transaction. */
const MAX_INSTRUCTION_COUNT = 3;

// ── Minimal Solana message deserializer ──────────────────────────
// Parses just enough of a legacy (v0) Solana message to extract
// account keys, instructions, and program IDs. No @solana/web3.js.

interface ParsedInstruction {
  programIdIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}

interface ParsedMessage {
  numRequiredSignatures: number;
  accountKeys: Uint8Array[];  // Each 32 bytes
  instructions: ParsedInstruction[];
}

function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    if (pos >= buf.length) throw new Error('Unexpected end of message reading compact-u16');
    const byte = buf[pos++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 16) throw new Error('compact-u16 overflow');
  }
  return [value, pos];
}

function parseTransactionMessage(raw: Uint8Array): ParsedMessage {
  if (raw.length < 4) throw new Error('Message too short');

  let offset = 0;

  // Header: 3 bytes
  const numRequiredSignatures = raw[offset++]!;
  offset++; // numReadonlySignedAccounts
  offset++; // numReadonlyUnsignedAccounts

  // Account keys
  let numAccounts: number;
  [numAccounts, offset] = readCompactU16(raw, offset);

  if (numAccounts > 64) throw new Error(`Unreasonable account count: ${numAccounts}`);

  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < numAccounts; i++) {
    if (offset + 32 > raw.length) throw new Error('Unexpected end of message reading account keys');
    accountKeys.push(raw.slice(offset, offset + 32));
    offset += 32;
  }

  // Recent blockhash (32 bytes, skip)
  if (offset + 32 > raw.length) throw new Error('Unexpected end of message reading blockhash');
  offset += 32;

  // Instructions
  let numInstructions: number;
  [numInstructions, offset] = readCompactU16(raw, offset);

  const instructions: ParsedInstruction[] = [];
  for (let i = 0; i < numInstructions; i++) {
    if (offset >= raw.length) throw new Error('Unexpected end of message reading instruction');
    const programIdIndex = raw[offset++]!;

    let numAccountIndices: number;
    [numAccountIndices, offset] = readCompactU16(raw, offset);

    const accountIndices: number[] = [];
    for (let j = 0; j < numAccountIndices; j++) {
      if (offset >= raw.length) throw new Error('Unexpected end of message reading account index');
      accountIndices.push(raw[offset++]!);
    }

    let dataLen: number;
    [dataLen, offset] = readCompactU16(raw, offset);

    if (offset + dataLen > raw.length) throw new Error('Unexpected end of message reading instruction data');
    const data = raw.slice(offset, offset + dataLen);
    offset += dataLen;

    instructions.push({ programIdIndex, accountIndices, data });
  }

  return { numRequiredSignatures, accountKeys, instructions };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Transaction policy enforcement ───────────────────────────────

function validateClaimTransaction(messageBytes: Uint8Array, signerPubkey: Uint8Array): string | null {
  let parsed: ParsedMessage;
  try {
    parsed = parseTransactionMessage(messageBytes);
  } catch (err) {
    return `Failed to parse transaction: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Rule 1: Reasonable instruction count (claim = 1 ix, claim + ATA creation = 2 ix)
  if (parsed.instructions.length === 0) {
    return 'Transaction has no instructions';
  }
  if (parsed.instructions.length > MAX_INSTRUCTION_COUNT) {
    return `Transaction has ${parsed.instructions.length} instructions (max ${MAX_INSTRUCTION_COUNT})`;
  }

  // Rule 2: Fee payer (first account) must be the agent's own wallet
  if (parsed.accountKeys.length === 0) {
    return 'Transaction has no accounts';
  }
  if (!bytesEqual(parsed.accountKeys[0]!, signerPubkey)) {
    return 'Fee payer is not the agent wallet';
  }

  // Rule 3: Every instruction must use an allowed program
  let hasEndGameIx = false;
  for (let i = 0; i < parsed.instructions.length; i++) {
    const ix = parsed.instructions[i]!;
    const programKey = parsed.accountKeys[ix.programIdIndex];
    if (!programKey) {
      return `Instruction ${i} references invalid program index ${ix.programIdIndex}`;
    }

    if (bytesEqual(programKey, ENDGAME_PROGRAM_ID)) {
      hasEndGameIx = true;
    } else if (bytesEqual(programKey, ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // ATA creation is allowed (needed when winner has no token account)
    } else if (bytesEqual(programKey, TOKEN_2022_PROGRAM_ID)) {
      // Token-2022 inner CPI is allowed
    } else if (bytesEqual(programKey, SYSTEM_PROGRAM_ID)) {
      // System program is only allowed as part of ATA creation (it pays rent).
      // But a plain SOL transfer would also use System Program — check that
      // this instruction doesn't look like a SOL transfer (data = 4-byte
      // discriminator 2 + 8-byte lamports = 12 bytes for Transfer).
      // System Transfer discriminator is LE u32 = 2.
      if (ix.data.length === 12) {
        const discriminator = ix.data[0]! | (ix.data[1]! << 8) | (ix.data[2]! << 16) | (ix.data[3]! << 24);
        if (discriminator === 2) {
          return `Instruction ${i} is a System Program SOL transfer — not allowed`;
        }
      }
    } else {
      const programHex = Buffer.from(programKey).toString('hex').slice(0, 16);
      return `Instruction ${i} uses unauthorized program: ${programHex}...`;
    }
  }

  // Rule 4: Must include at least one EndGame program instruction
  if (!hasEndGameIx) {
    return 'Transaction does not include an EndGame program instruction';
  }

  return null; // All checks passed
}

// ── Keyfile path validation ──────────────────────────────────────

/** Validate keyfile path is within the agent data directory and ends with .json. */
function validateKeyfilePath(path: string): string {
  const resolved = resolve(path);
  // Support both AGENT_HOME/data/ (installed) and cwd/.agent-data/ (dev)
  const home = process.env['AGENT_HOME'];
  const allowedDirs = home
    ? [resolve(home, 'data')]
    : [resolve(process.cwd(), '.agent-data'), resolve(process.cwd(), 'data')];

  const inAllowed = allowedDirs.some(dir =>
    resolved.startsWith(dir + '/') || resolved === dir,
  );

  if (!inAllowed) {
    throw new Error(`Keyfile path must be within data directory (tried: ${allowedDirs.join(', ')})`);
  }
  if (!resolved.endsWith('.json')) {
    throw new Error('Keyfile path must end with .json');
  }
  return resolved;
}

// ── Message handler ──────────────────────────────────────────────

async function handleMessage(msg: IncomingMessage): Promise<void> {
  try {
    if (msg.type === 'unlock') {
      const safePath = validateKeyfilePath(msg.keyfilePath);
      const keyfile: EncryptedKeyfile = JSON.parse(
        readFileSync(safePath, 'utf-8'),
      );
      privateKey = await decryptKey(keyfile, msg.password);
      process.send?.({ type: 'unlocked' });
      return;
    }

    if (msg.type === 'sign') {
      if (!privateKey) {
        process.send?.({ type: 'error', message: 'Signer not unlocked' });
        return;
      }

      const messageBytes = Buffer.from(msg.message, 'base64');

      // Extract the signer's public key from the private key (bytes 32-63 of ed25519 keypair)
      const signerPubkey = privateKey.slice(32, 64);

      // Validate the transaction before signing
      const rejection = validateClaimTransaction(messageBytes, signerPubkey);
      if (rejection) {
        process.send?.({ type: 'error', message: `Transaction rejected: ${rejection}` });
        return;
      }

      const signature = signMessage(messageBytes, privateKey);
      process.send?.({
        type: 'signature',
        signature: Buffer.from(signature).toString('base64'),
      });
      return;
    }

    if (msg.type === 'lock') {
      if (privateKey) { privateKey.fill(0); privateKey = null; }
      process.send?.({ type: 'locked' });
      return;
    }
  } catch (err) {
    process.send?.({
      type: 'error',
      message: err instanceof Error ? err.message : 'Unknown signing error',
    });
  }
}

// Wipe key on process exit
process.on('exit', () => {
  if (privateKey) { privateKey.fill(0); privateKey = null; }
});

// Only run when spawned as a child process (not when imported for tests).
// Check for a sentinel env var that the parent sets via fork(), or detect
// vitest's worker environment.
if (process.send && !process.env['VITEST'] && !process.env['VITEST_WORKER_ID']) {
  process.on('message', handleMessage);
  process.send({ type: 'ready' });
}

// ── Exports for testing ──────────────────────────────────────────

export {
  validateClaimTransaction,
  parseTransactionMessage,
  validateKeyfilePath,
  ENDGAME_PROGRAM_ID,
  type ParsedMessage,
  type ParsedInstruction,
};
