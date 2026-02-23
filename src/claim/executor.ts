/**
 * Claim executor -- builds and submits on-chain Solana transactions to claim prizes.
 *
 * Flow:
 * 1. Verify claimability via REST API (/api/claims/verify)
 * 2. Build Solana transaction with the program's claim instruction
 * 3. Sign the serialized transaction message via isolated signer subprocess (IPC)
 * 4. Submit the signed transaction to Solana RPC with retry logic
 * 5. Log result to persistent claim history
 *
 * The private key NEVER enters this process. All signing happens in the
 * forked signer subprocess via nacl.sign.detached.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createLogger } from '../core/logger.js';
import { resolveDataDir } from '../core/config.js';
import type { EndGameApi } from '../api/client.js';
import type { ClaimResult } from './monitor.js';

const log = createLogger('claim');

// ── Constants ──────────────────────────────────────────────────────

const SIGN_TIMEOUT_MS = 10_000;
const CLAIMS_FILE = join(resolveDataDir(), 'claims.json');

/** The EndGame program on Solana mainnet. */
const PROGRAM_ID = new PublicKey('pjMUjMjHTHot5bYrBu9qd4cRaNKdK1eTR8iVYouQzDo');

/** END token mint (Token-2022 program, 9 decimals, 100bps transfer fee). */
const TOKEN_MINT = new PublicKey('2B8LYcPoGn1SmigGtvUSCTDtmGRZxZXVEouYu4RyfEDb');

/** Game state PDA derived from ["game_state"] seed. */
const GAME_STATE_PDA = new PublicKey('Ee8StbWk4TxcbUM1XZRJ18RgxyycGBZhdCFrPDuV62P1');

/** Vault token account (read from game state bytes 32-64). */
const VAULT_ADDRESS = new PublicKey('9JuE3Pip7gnA4vVRWNNMzidsKkUJ5LRbnaUWToswVpNF');

/** Number of times to retry sendRawTransaction (matches website behavior). */
const SEND_RETRIES = 12;

/** Delay between send retries in milliseconds. */
const SEND_RETRY_DELAY_MS = 1_500;

// ── Types ──────────────────────────────────────────────────────────

interface ClaimRecord {
  roundId: number;
  prizeAmount: string;
  txSignature: string;
  claimedAt: string;
  latencyMs: number;
}

interface SignerResponse {
  type: 'signature' | 'error';
  signature?: string;
  message?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Derive the round PDA from the round ID.
 * Seeds: ["round", <round_id as 8-byte little-endian u64>]
 */
function deriveRoundPda(roundId: number): PublicKey {
  const roundIdBuffer = Buffer.alloc(8);
  roundIdBuffer.writeBigUInt64LE(BigInt(roundId), 0);

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('round'), roundIdBuffer],
    PROGRAM_ID,
  );
  return pda;
}

// ── Executor ───────────────────────────────────────────────────────

export class ClaimExecutor {
  private api: EndGameApi;
  private walletAddress: string;
  private walletPubkey: PublicKey;
  private signerProcess: ChildProcess;
  private connection: Connection;
  private _sv: { v: bigint; k: number };

  constructor(
    api: EndGameApi,
    walletAddress: string,
    signerProcess: ChildProcess,
    rpcEndpoint: string,
    sessionVector: { v: bigint; k: number },
  ) {
    this.api = api;
    this.walletAddress = walletAddress;
    this.walletPubkey = new PublicKey(walletAddress);
    this.signerProcess = signerProcess;
    this.connection = new Connection(rpcEndpoint, 'confirmed');
    this._sv = sessionVector;
  }

  /**
   * Update the signer subprocess reference after crash recovery.
   */
  updateSigner(proc: ChildProcess): void {
    this.signerProcess = proc;
  }

  private buildClaimDiscriminator(): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(this._sv.v, 0);
    return buf;
  }

  /**
   * The onWin callback for RoundMonitor.
   * Verifies claimability, builds + signs the Solana transaction, submits it on-chain.
   */
  async claim(roundId: number, prizeAmount: string, claimDeadline: number): Promise<ClaimResult> {
    const start = Date.now();

    try {
      log.info('Starting claim process', { roundId, prizeAmount, claimDeadline });

      // 1. Verify claimability via REST API
      const verification = await this.api.verifyClaims([roundId], this.walletAddress);
      const roundResult = verification.results?.find(r => r.roundId === roundId);

      if (roundResult && !roundResult.claimable) {
        log.warn('Round not claimable', { roundId, reason: roundResult.reason });
        return { roundId, success: false, error: `Not claimable: ${roundResult.reason ?? 'unknown'}` };
      }

      log.info('Round verified as claimable', { roundId });

      // 2. Build the Solana transaction
      const { transaction, blockhash, lastValidBlockHeight } = await this.buildClaimTransaction(roundId);

      // 3. Sign via IPC to isolated signer subprocess
      const serializedMessage = transaction.serializeMessage();
      const signatureBase64 = await this.requestSignature(
        Buffer.from(serializedMessage).toString('base64'),
      );
      const signatureBytes = Buffer.from(signatureBase64, 'base64');

      // Set the signature on the transaction
      transaction.addSignature(this.walletPubkey, signatureBytes);

      // Verify the transaction is properly signed
      if (!transaction.verifySignatures()) {
        throw new Error('Transaction signature verification failed');
      }

      // 4. Submit with retry logic
      const rawTransaction = transaction.serialize();
      const txSignature = await this.sendWithRetry(rawTransaction, blockhash, lastValidBlockHeight);

      const latencyMs = Date.now() - start;
      log.info('Claim transaction confirmed', { roundId, txSignature, latencyMs });

      // 5. Persist to claim history
      this.appendClaimRecord({
        roundId,
        prizeAmount,
        txSignature,
        claimedAt: new Date().toISOString(),
        latencyMs,
      });

      return { roundId, success: true, txSignature };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Claim failed', { roundId, error: message });
      return { roundId, success: false, error: message };
    }
  }

  /**
   * Build the claim transaction with the correct instruction and accounts.
   * If the winner does not have a Token-2022 ATA, creates one first.
   */
  private async buildClaimTransaction(roundId: number): Promise<{ transaction: Transaction; blockhash: string; lastValidBlockHeight: number }> {
    const roundPda = deriveRoundPda(roundId);

    // Get the winner's associated token account for the Token-2022 mint
    const winnerAta = getAssociatedTokenAddressSync(
      TOKEN_MINT,
      this.walletPubkey,
      false, // allowOwnerOffCurve
      TOKEN_2022_PROGRAM_ID,
    );

    const transaction = new Transaction();

    // Check if the ATA exists; if not, create it first
    const ataInfo = await this.connection.getAccountInfo(winnerAta);
    if (!ataInfo) {
      log.info('Creating associated token account for winner', {
        ata: winnerAta.toBase58(),
      });
      transaction.add(
        createAssociatedTokenAccountInstruction(
          this.walletPubkey,     // payer
          winnerAta,             // ata
          this.walletPubkey,     // owner
          TOKEN_MINT,            // mint
          TOKEN_2022_PROGRAM_ID, // token program
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    // Build the claim instruction
    const claimInstruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: GAME_STATE_PDA, isSigner: false, isWritable: true },   // 1. gameState PDA
        { pubkey: roundPda,        isSigner: false, isWritable: true },   // 2. round PDA
        { pubkey: VAULT_ADDRESS,   isSigner: false, isWritable: true },   // 3. vault
        { pubkey: winnerAta,       isSigner: false, isWritable: true },   // 4. winner ATA
        { pubkey: this.walletPubkey, isSigner: true,  isWritable: false }, // 5. winner (signer)
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 6. Token-2022 program
        { pubkey: TOKEN_MINT,      isSigner: false, isWritable: false },  // 7. token mint
      ],
      data: this.buildClaimDiscriminator(),
    });

    transaction.add(claimInstruction);

    // Set recent blockhash and fee payer
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = this.walletPubkey;

    return { transaction, blockhash, lastValidBlockHeight };
  }

  /**
   * Submit a signed raw transaction with retry logic.
   * Retries up to SEND_RETRIES times (matching the website's behavior of 12 retries).
   */
  private async sendWithRetry(rawTransaction: Buffer, blockhash: string, lastValidBlockHeight: number): Promise<string> {
    let lastError = '';

    for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
      try {
        const txSignature = await this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0, // We handle retries ourselves
        });

        // Wait for confirmation
        const confirmation = await this.connection.confirmTransaction(
          { signature: txSignature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return txSignature;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        // If this is an already-processed error, the claim went through
        if (lastError.includes('already been processed')) {
          log.info('Transaction already processed (likely succeeded on a previous attempt)');
          // Try to extract the signature from a prior attempt
          // This is a success case -- the transaction landed
          throw new Error('Transaction already processed but signature unknown');
        }

        if (attempt < SEND_RETRIES) {
          log.warn(`Send attempt ${attempt}/${SEND_RETRIES} failed, retrying`, {
            error: lastError,
          });
          await new Promise(r => setTimeout(r, SEND_RETRY_DELAY_MS));
        }
      }
    }

    throw new Error(`Failed to send transaction after ${SEND_RETRIES} attempts: ${lastError}`);
  }

  /**
   * Send message to signer subprocess and wait for ed25519 signature.
   * The signer receives base64-encoded transaction message bytes and returns
   * the nacl.sign.detached signature as base64.
   */
  private requestSignature(messageBase64: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Signer timeout -- no response within 10s'));
      }, SIGN_TIMEOUT_MS);

      const onMessage = (msg: SignerResponse) => {
        if (msg.type === 'signature' && msg.signature) {
          cleanup();
          resolve(msg.signature);
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(`Signer error: ${msg.message ?? 'unknown'}`));
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.signerProcess.removeListener('message', onMessage);
      };

      this.signerProcess.on('message', onMessage);
      this.signerProcess.send({ type: 'sign', message: messageBase64 });
    });
  }

  /**
   * Append a claim record to .agent-data/claims.json.
   * Creates the file and directory if they don't exist.
   */
  private appendClaimRecord(record: ClaimRecord): void {
    try {
      mkdirSync(dirname(CLAIMS_FILE), { recursive: true });

      const history: ClaimRecord[] = existsSync(CLAIMS_FILE)
        ? JSON.parse(readFileSync(CLAIMS_FILE, 'utf-8'))
        : [];

      history.push(record);
      writeFileSync(CLAIMS_FILE, JSON.stringify(history, null, 2) + '\n');
      log.info('Claim recorded', { file: CLAIMS_FILE, total: history.length });
    } catch (err) {
      log.error('Failed to write claim history', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
