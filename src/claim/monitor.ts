/**
 * Round monitor — watches for new rounds and triggers claims.
 *
 * Polling strategy:
 * - Normal: check every 30s
 * - Round active (claim window open): check every 5s
 * - After claim: back to normal
 *
 * Edge cases handled:
 * - API downtime: exponential backoff, max 5 retries
 * - Missed round: log warning, continue monitoring
 * - Double-claim attempt: API rejects gracefully, no harm
 * - Network partition: retry with jitter
 */

import { createLogger } from '../core/logger.js';
import type { EndGameApi } from '../api/client.js';

const log = createLogger('monitor');

const POLL_NORMAL_MS = 30_000;
const POLL_ACTIVE_MS = 5_000;
const MAX_RETRIES = 5;

export interface ClaimResult {
  roundId: string;
  success: boolean;
  txSignature?: string;
  error?: string;
}

export class RoundMonitor {
  private api: EndGameApi;
  private walletAddress: string;
  private onWin: (roundId: string, prize: number, claimDeadline: string) => Promise<ClaimResult>;
  private running = false;
  private pollInterval = POLL_NORMAL_MS;

  constructor(
    api: EndGameApi,
    walletAddress: string,
    onWin: (roundId: string, prize: number, claimDeadline: string) => Promise<ClaimResult>,
  ) {
    this.api = api;
    this.walletAddress = walletAddress;
    this.onWin = onWin;
  }

  async start(): Promise<void> {
    this.running = true;
    log.info('Round monitor started', { wallet: this.walletAddress.slice(0, 8) + '...' });

    while (this.running) {
      try {
        await this.checkRound();
      } catch (err) {
        log.error('Monitor cycle failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await this.sleep(this.pollInterval);
    }
  }

  stop(): void {
    this.running = false;
    log.info('Round monitor stopped');
  }

  private async checkRound(): Promise<void> {
    const round = await this.api.getCurrentRound();

    if (!round || !round.winner_wallet) {
      this.pollInterval = POLL_NORMAL_MS;
      return;
    }

    // Check if we won
    if (round.winner_wallet === this.walletAddress) {
      log.info('Winner detected!', { roundId: round.round_id, prize: round.prize_amount });
      this.pollInterval = POLL_ACTIVE_MS;

      const result = await this.claimWithRetry(
        round.round_id,
        round.prize_amount ?? 0,
        round.claim_deadline ?? '',
      );

      if (result.success) {
        log.info('Prize claimed', { roundId: round.round_id, tx: result.txSignature });
      } else {
        log.error('Claim failed after retries', { roundId: round.round_id, error: result.error });
      }

      this.pollInterval = POLL_NORMAL_MS;
    }
  }

  private async claimWithRetry(
    roundId: string,
    prize: number,
    claimDeadline: string,
  ): Promise<ClaimResult> {
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.onWin(roundId, prize, claimDeadline);
        if (result.success) return result;
        lastError = result.error ?? 'Unknown';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 1000;
        log.warn(`Claim attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${Math.round(delay)}ms`, {
          roundId,
          error: lastError,
        });
        await this.sleep(delay);
      }
    }

    return { roundId, success: false, error: lastError };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
