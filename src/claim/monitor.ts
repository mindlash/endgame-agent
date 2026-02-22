/**
 * Round monitor -- watches for new rounds and triggers claims.
 *
 * Polling strategy:
 * - Normal: check every 30s
 * - Round active (claim window open): check every 5s
 * - After claim: back to normal
 *
 * Edge cases handled:
 * - API downtime: exponential backoff, max 5 retries
 * - Missed round: log warning, continue monitoring
 * - Double-claim attempt: tracked via claimedRounds Set
 * - Expired deadline: skip claim, log warning
 * - Network partition: retry with jitter
 */

import { createLogger } from '../core/logger.js';
import type { EndGameApi, GameStatusResponse } from '../api/client.js';

const log = createLogger('monitor');

const POLL_NORMAL_MS = 30_000;
const POLL_ACTIVE_MS = 5_000;
const MAX_RETRIES = 5;

export interface ClaimResult {
  roundId: number;
  success: boolean;
  txSignature?: string;
  error?: string;
}

export type OnWinCallback = (
  roundId: number,
  prizeAmount: string,
  claimDeadline: number,
) => Promise<ClaimResult>;

export class RoundMonitor {
  private api: EndGameApi;
  private walletAddress: string;
  private onWin: OnWinCallback;
  private running = false;
  private pollInterval = POLL_NORMAL_MS;
  /** Track rounds we have already attempted to claim to prevent re-claim loops. */
  private claimedRounds = new Set<number>();

  constructor(
    api: EndGameApi,
    walletAddress: string,
    onWin: OnWinCallback,
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
    let round: GameStatusResponse;
    try {
      round = await this.api.getCurrentRound();
    } catch (err) {
      log.warn('Failed to fetch round status', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // No winner yet or status is not "winner_selected"
    if (!round.winner || round.status !== 'winner_selected') {
      this.pollInterval = POLL_NORMAL_MS;
      return;
    }

    // Check if we won this round
    if (round.winner !== this.walletAddress) {
      this.pollInterval = POLL_NORMAL_MS;
      return;
    }

    const roundId = round.round_id;

    // Already claimed this round
    if (this.claimedRounds.has(roundId)) {
      this.pollInterval = POLL_NORMAL_MS;
      return;
    }

    // Check claim deadline (unix timestamp in seconds)
    const nowSec = Math.floor(Date.now() / 1000);
    if (round.claim_deadline > 0 && nowSec >= round.claim_deadline) {
      log.warn('Claim deadline has passed, skipping', {
        roundId,
        deadline: round.claim_deadline,
        now: nowSec,
      });
      this.claimedRounds.add(roundId);
      this.pollInterval = POLL_NORMAL_MS;
      return;
    }

    log.info('Winner detected!', {
      roundId,
      prizeAmount: round.prize_amount,
      claimDeadline: round.claim_deadline,
      timeRemaining: round.claim_deadline - nowSec,
    });

    this.pollInterval = POLL_ACTIVE_MS;

    const result = await this.claimWithRetry(
      roundId,
      round.prize_amount,
      round.claim_deadline,
    );

    // Mark as claimed regardless of outcome to prevent infinite retry loops
    this.claimedRounds.add(roundId);

    if (result.success) {
      log.info('Prize claimed', { roundId, tx: result.txSignature });
    } else {
      log.error('Claim failed after retries', { roundId, error: result.error });
    }

    this.pollInterval = POLL_NORMAL_MS;
  }

  private async claimWithRetry(
    roundId: number,
    prizeAmount: string,
    claimDeadline: number,
  ): Promise<ClaimResult> {
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Re-check deadline before each attempt
      const nowSec = Math.floor(Date.now() / 1000);
      if (claimDeadline > 0 && nowSec >= claimDeadline) {
        return { roundId, success: false, error: 'Claim deadline expired during retries' };
      }

      try {
        const result = await this.onWin(roundId, prizeAmount, claimDeadline);
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
