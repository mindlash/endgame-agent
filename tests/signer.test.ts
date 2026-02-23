/**
 * Tests for signer transaction validation (Phase 2 security fix).
 *
 * Verifies that the signer enforces policy:
 * - Only EndGame claim transactions are signed
 * - Fee payer must be the agent's wallet
 * - No SOL transfers allowed
 * - Unknown programs are rejected
 */
import { describe, it, expect } from 'vitest';
import { validateClaimTransaction, parseTransactionMessage, ENDGAME_PROGRAM_ID } from '../src/security/signer.js';
import nacl from 'tweetnacl';

// ── Helpers ──────────────────────────────────────────────────────

/** Encode a compact u16 value as bytes. */
function encodeCompactU16(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

/** Generate a random 32-byte key. */
function randomKey(): Uint8Array {
  return nacl.randomBytes(32);
}

/** System Program ID (all zeros). */
const SYSTEM_PROGRAM = new Uint8Array(32);

/** Token-2022 program ID. */
const TOKEN_2022 = Uint8Array.from(
  Buffer.from('06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc', 'hex'),
);

/** Associated Token Program ID. */
const ATA_PROGRAM = Uint8Array.from(
  Buffer.from('8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859', 'hex'),
);

/**
 * Build a minimal valid Solana legacy transaction message.
 *
 * Format:
 *   header (3 bytes): numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts
 *   compact_array<pubkey> accountKeys
 *   blockhash (32 bytes)
 *   compact_array<instruction> instructions
 *     each instruction: programIdIndex (1 byte), compact_array<u8> accounts, compact_array<u8> data
 */
function buildMessage(opts: {
  numRequiredSignatures?: number;
  accountKeys: Uint8Array[];
  instructions: Array<{
    programIdIndex: number;
    accountIndices: number[];
    data: Uint8Array;
  }>;
}): Uint8Array {
  const parts: Uint8Array[] = [];

  // Header
  parts.push(Uint8Array.from([opts.numRequiredSignatures ?? 1, 0, 0]));

  // Account keys
  parts.push(encodeCompactU16(opts.accountKeys.length));
  for (const key of opts.accountKeys) {
    parts.push(key);
  }

  // Blockhash (32 random bytes)
  parts.push(nacl.randomBytes(32));

  // Instructions
  parts.push(encodeCompactU16(opts.instructions.length));
  for (const ix of opts.instructions) {
    parts.push(Uint8Array.from([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndices.length));
    parts.push(Uint8Array.from(ix.accountIndices));
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ── parseTransactionMessage ──────────────────────────────────────

describe('parseTransactionMessage', () => {
  it('parses a simple message with one instruction', () => {
    const feePayer = randomKey();
    const programId = randomKey();

    const msg = buildMessage({
      accountKeys: [feePayer, programId],
      instructions: [{
        programIdIndex: 1,
        accountIndices: [0],
        data: new Uint8Array([1, 2, 3]),
      }],
    });

    const parsed = parseTransactionMessage(msg);
    expect(parsed.numRequiredSignatures).toBe(1);
    expect(parsed.accountKeys).toHaveLength(2);
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0]!.programIdIndex).toBe(1);
    expect(parsed.instructions[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects too-short messages', () => {
    expect(() => parseTransactionMessage(new Uint8Array([1, 2]))).toThrow('Message too short');
  });
});

// ── validateClaimTransaction ─────────────────────────────────────

describe('validateClaimTransaction', () => {
  const keypair = nacl.sign.keyPair();
  const signerPubkey = keypair.publicKey; // 32 bytes

  it('accepts a valid EndGame claim transaction', () => {
    const gameState = randomKey();
    const roundPda = randomKey();
    const vault = randomKey();
    const winnerAta = randomKey();
    const tokenMint = randomKey();

    const msg = buildMessage({
      accountKeys: [
        signerPubkey,    // 0: fee payer / winner
        gameState,       // 1: game state
        roundPda,        // 2: round PDA
        vault,           // 3: vault
        winnerAta,       // 4: winner ATA
        TOKEN_2022,      // 5: Token-2022
        tokenMint,       // 6: token mint
        ENDGAME_PROGRAM_ID, // 7: EndGame program
      ],
      instructions: [{
        programIdIndex: 7,  // EndGame program
        accountIndices: [1, 2, 3, 4, 0, 5, 6],
        data: new Uint8Array(8), // 8-byte discriminator
      }],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toBeNull();
  });

  it('accepts claim with ATA creation instruction', () => {
    const msg = buildMessage({
      accountKeys: [
        signerPubkey,
        randomKey(),        // game state
        randomKey(),        // round PDA
        randomKey(),        // vault
        randomKey(),        // winner ATA
        TOKEN_2022,         // Token-2022
        randomKey(),        // token mint
        ENDGAME_PROGRAM_ID, // EndGame
        ATA_PROGRAM,        // ATA program
        SYSTEM_PROGRAM,     // System program (for rent)
      ],
      instructions: [
        {
          // ATA creation instruction
          programIdIndex: 8, // ATA program
          accountIndices: [0, 4, 0, 6, 5, 9],
          data: new Uint8Array(0),
        },
        {
          // Claim instruction
          programIdIndex: 7, // EndGame program
          accountIndices: [1, 2, 3, 4, 0, 5, 6],
          data: new Uint8Array(8),
        },
      ],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toBeNull();
  });

  it('rejects transaction with wrong fee payer', () => {
    const wrongPayer = randomKey();

    const msg = buildMessage({
      accountKeys: [wrongPayer, ENDGAME_PROGRAM_ID],
      instructions: [{
        programIdIndex: 1,
        accountIndices: [0],
        data: new Uint8Array(8),
      }],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toBe('Fee payer is not the agent wallet');
  });

  it('rejects transaction with no EndGame instruction', () => {
    const msg = buildMessage({
      accountKeys: [signerPubkey, TOKEN_2022],
      instructions: [{
        programIdIndex: 1,
        accountIndices: [0],
        data: new Uint8Array(8),
      }],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toBe('Transaction does not include an EndGame program instruction');
  });

  it('rejects transaction with unauthorized program', () => {
    const unknownProgram = randomKey();

    const msg = buildMessage({
      accountKeys: [signerPubkey, ENDGAME_PROGRAM_ID, unknownProgram],
      instructions: [
        { programIdIndex: 1, accountIndices: [0], data: new Uint8Array(8) },
        { programIdIndex: 2, accountIndices: [0], data: new Uint8Array(8) },
      ],
    });

    const result = validateClaimTransaction(msg, signerPubkey);
    expect(result).toContain('uses unauthorized program');
  });

  it('rejects SOL transfer via System Program', () => {
    // System Transfer: discriminator LE u32 = 2, then 8 bytes lamports = 12 bytes total
    const transferData = new Uint8Array(12);
    transferData[0] = 2; // System.Transfer discriminator

    const msg = buildMessage({
      accountKeys: [signerPubkey, ENDGAME_PROGRAM_ID, SYSTEM_PROGRAM],
      instructions: [
        { programIdIndex: 1, accountIndices: [0], data: new Uint8Array(8) },
        { programIdIndex: 2, accountIndices: [0], data: transferData },
      ],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toContain('SOL transfer');
  });

  it('rejects transaction with too many instructions', () => {
    const msg = buildMessage({
      accountKeys: [signerPubkey, ENDGAME_PROGRAM_ID, TOKEN_2022, ATA_PROGRAM],
      instructions: [
        { programIdIndex: 1, accountIndices: [0], data: new Uint8Array(8) },
        { programIdIndex: 2, accountIndices: [0], data: new Uint8Array(8) },
        { programIdIndex: 3, accountIndices: [0], data: new Uint8Array(0) },
        { programIdIndex: 1, accountIndices: [0], data: new Uint8Array(8) },
      ],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toContain('4 instructions');
  });

  it('rejects empty transaction', () => {
    const msg = buildMessage({
      accountKeys: [signerPubkey],
      instructions: [],
    });

    expect(validateClaimTransaction(msg, signerPubkey)).toBe('Transaction has no instructions');
  });

  it('handles malformed message gracefully', () => {
    const result = validateClaimTransaction(new Uint8Array([0, 0, 0, 5]), signerPubkey);
    expect(result).toContain('Failed to parse');
  });
});
