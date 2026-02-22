/**
 * Claim executor — signs and submits prize claims.
 *
 * Flow:
 * 1. Build claim message from round data
 * 2. Send to isolated signer subprocess via IPC (ed25519)
 * 3. Submit signed claim to EndGame API
 * 4. Log result to persistent claim history
 *
 * The private key NEVER enters this process. All signing
 * happens in the forked signer subprocess.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createLogger } from '../core/logger.js';
import type { EndGameApi } from '../api/client.js';
import type { ClaimResult } from './monitor.js';

const log = createLogger('claim');

const SIGN_TIMEOUT_MS = 10_000;
const CLAIMS_FILE = join(process.cwd(), '.agent-data', 'claims.json');

interface ClaimRecord {
  roundId: string;
  prizeTokens: number;
  txSignature: string;
  claimedAt: string;
  latencyMs: number;
}

interface SignerResponse {
  type: 'signature' | 'error';
  signature?: string;
  message?: string;
}

export class ClaimExecutor {
  private api: EndGameApi;
  private walletAddress: string;
  private signerProcess: ChildProcess;

  constructor(api: EndGameApi, walletAddress: string, signerProcess: ChildProcess) {
    this.api = api;
    this.walletAddress = walletAddress;
    this.signerProcess = signerProcess;
  }

  /**
   * The onWin callback for RoundMonitor.
   * Signs the claim message via IPC, submits to API, logs the result.
   */
  async claim(roundId: string, prize: number, claimDeadline: string): Promise<ClaimResult> {
    const start = Date.now();

    try {
      log.info('Claiming prize', { roundId, prize, claimDeadline });

      // 1. Build claim message
      const claimMessage = Buffer.from(
        JSON.stringify({
          action: 'claim',
          round_id: roundId,
          wallet: this.walletAddress,
          timestamp: Date.now(),
        }),
      );

      // 2. Request signature from isolated signer
      const signatureBase64 = await this.requestSignature(claimMessage.toString('base64'));

      // 3. Submit to API
      const result = await this.api.submitClaim({
        round_id: roundId,
        wallet: this.walletAddress,
        signature: signatureBase64,
      });

      const latencyMs = Date.now() - start;
      log.info('Claim submitted', { roundId, tx: result.tx_signature, latencyMs });

      // 4. Persist to claim history
      this.appendClaimRecord({
        roundId,
        prizeTokens: prize,
        txSignature: result.tx_signature,
        claimedAt: new Date().toISOString(),
        latencyMs,
      });

      return { roundId, success: true, txSignature: result.tx_signature };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Claim failed', { roundId, error: message });
      return { roundId, success: false, error: message };
    }
  }

  /**
   * Send message to signer subprocess and wait for signature.
   * Rejects after SIGN_TIMEOUT_MS to prevent hanging.
   */
  private requestSignature(messageBase64: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Signer timeout — no response within 10s'));
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
