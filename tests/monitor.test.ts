/**
 * Tests for the round monitor logic: winner detection, duplicate claim prevention,
 * claim deadline validation, and retry with exponential backoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoundMonitor, type ClaimResult, type OnWinCallback } from '../src/claim/monitor.js';
import type { EndGameApi, GameStatusResponse } from '../src/api/client.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeRoundResponse(overrides: Partial<GameStatusResponse> = {}): GameStatusResponse {
  return {
    round_id: 42,
    current_round: 42,
    winner: '',
    prize_amount: '1000000',
    claim_deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    status: 'active',
    time_remaining_seconds: 3600,
    vault_balance: '500000000',
    ...overrides,
  };
}

function createMockApi(roundResponse: GameStatusResponse): EndGameApi {
  return {
    getCurrentRound: vi.fn().mockResolvedValue(roundResponse),
    getGameStatus: vi.fn().mockResolvedValue(roundResponse),
    verifyClaims: vi.fn(),
    getVaultProjection: vi.fn(),
    getPrice: vi.fn(),
    getRankings: vi.fn(),
    getWeightBreakdown: vi.fn(),
    getDiamondHands: vi.fn(),
    getCombatFortune: vi.fn(),
    getDonorBoost: vi.fn(),
    getPotionStatus: vi.fn(),
    getChallengeStats: vi.fn(),
    getActiveChallenges: vi.fn(),
    getStatsDigest: vi.fn(),
    getLevelRequirements: vi.fn(),
  } as unknown as EndGameApi;
}

const TEST_WALLET = 'TestWalletAddress1234567890abcdef';

// ── Monitor Tests ───────────────────────────────────────────────────

describe('RoundMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects winner correctly and calls onWin', async () => {
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'winner_selected',
      round_id: 42,
      prize_amount: '5000000',
    });
    const mockApi = createMockApi(roundData);
    const onWin: OnWinCallback = vi.fn().mockResolvedValue({
      roundId: 42,
      success: true,
      txSignature: 'tx_abc123',
    } satisfies ClaimResult);

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);

    // Start monitor, let it run one cycle, then stop
    const startPromise = monitor.start();

    // Advance past the first poll cycle (the monitor polls immediately, then sleeps)
    // We need to flush microtasks to let the async checkRound() run
    await vi.advanceTimersByTimeAsync(100);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    expect(onWin).toHaveBeenCalledWith(42, '5000000', roundData.claim_deadline);
  });

  it('skips non-winner rounds (different wallet)', async () => {
    const roundData = makeRoundResponse({
      winner: 'SomeOtherWallet',
      status: 'winner_selected',
      round_id: 42,
    });
    const mockApi = createMockApi(roundData);
    const onWin: OnWinCallback = vi.fn();

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    expect(onWin).not.toHaveBeenCalled();
  });

  it('skips rounds where status is not winner_selected', async () => {
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'active', // Not winner_selected
      round_id: 42,
    });
    const mockApi = createMockApi(roundData);
    const onWin: OnWinCallback = vi.fn();

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    expect(onWin).not.toHaveBeenCalled();
  });

  it('tracks claimed rounds and prevents duplicate claims', async () => {
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'winner_selected',
      round_id: 99,
    });
    const mockApi = createMockApi(roundData);

    let callCount = 0;
    const onWin: OnWinCallback = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        roundId: 99,
        success: true,
        txSignature: 'tx_first',
      } satisfies ClaimResult);
    });

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    // First cycle: should detect and claim
    await vi.advanceTimersByTimeAsync(100);

    // Second cycle: should skip (already claimed)
    await vi.advanceTimersByTimeAsync(31_000);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    // onWin should only have been called once
    expect(callCount).toBe(1);
  });

  it('skips claim when deadline has passed', async () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 100; // 100 seconds ago
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'winner_selected',
      round_id: 55,
      claim_deadline: pastDeadline,
    });
    const mockApi = createMockApi(roundData);
    const onWin: OnWinCallback = vi.fn();

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    // Should NOT have called onWin because deadline passed
    expect(onWin).not.toHaveBeenCalled();
  });

  it('handles API errors gracefully without crashing', async () => {
    const mockApi = createMockApi(makeRoundResponse());
    // Make API throw on first call
    (mockApi.getCurrentRound as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network timeout'),
    );
    const onWin: OnWinCallback = vi.fn();

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    // Let it run one failing cycle
    await vi.advanceTimersByTimeAsync(100);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);

    // Should not throw, just log the error
    await startPromise;
    expect(onWin).not.toHaveBeenCalled();
  });
});

// ── claimWithRetry Tests (tested via RoundMonitor behavior) ─────────

describe('claimWithRetry (exponential backoff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on failure and eventually succeeds', async () => {
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'winner_selected',
      round_id: 77,
    });
    const mockApi = createMockApi(roundData);

    let attempt = 0;
    const onWin: OnWinCallback = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt < 3) {
        return Promise.resolve({
          roundId: 77,
          success: false,
          error: 'Transaction failed',
        } satisfies ClaimResult);
      }
      return Promise.resolve({
        roundId: 77,
        success: true,
        txSignature: 'tx_success_finally',
      } satisfies ClaimResult);
    });

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    // Need to advance through retries with backoff:
    // Attempt 1: immediate
    // Attempt 2: ~2s + jitter (2^1 * 1000 + random)
    // Attempt 3: ~4s + jitter (2^2 * 1000 + random)
    // Advance enough time for all retries
    await vi.advanceTimersByTimeAsync(100);    // first attempt
    await vi.advanceTimersByTimeAsync(4_000);  // second attempt
    await vi.advanceTimersByTimeAsync(6_000);  // third attempt

    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    // Should have been called 3 times (2 failures + 1 success)
    expect(attempt).toBe(3);
  });

  it('stops retrying after MAX_RETRIES (5) attempts', async () => {
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'winner_selected',
      round_id: 88,
    });
    const mockApi = createMockApi(roundData);

    let attempt = 0;
    const onWin: OnWinCallback = vi.fn().mockImplementation(() => {
      attempt++;
      return Promise.resolve({
        roundId: 88,
        success: false,
        error: 'Always fails',
      } satisfies ClaimResult);
    });

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    // Advance through all retry delays
    // Max delay is min(1000 * 2^attempt, 30000) + random * 1000
    // Attempt 1: immediate
    // Attempt 2: ~2s, Attempt 3: ~4s, Attempt 4: ~8s, Attempt 5: ~16s
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    // Should have attempted exactly 5 times (MAX_RETRIES)
    expect(attempt).toBe(5);
  });

  it('stops retrying if deadline expires during retries', async () => {
    // Deadline is 3 seconds from now (very tight)
    const tightDeadline = Math.floor(Date.now() / 1000) + 3;
    const roundData = makeRoundResponse({
      winner: TEST_WALLET,
      status: 'winner_selected',
      round_id: 66,
      claim_deadline: tightDeadline,
    });
    const mockApi = createMockApi(roundData);

    let attempt = 0;
    const onWin: OnWinCallback = vi.fn().mockImplementation(() => {
      attempt++;
      return Promise.resolve({
        roundId: 66,
        success: false,
        error: 'Transaction failed',
      } satisfies ClaimResult);
    });

    const monitor = new RoundMonitor(mockApi, TEST_WALLET, onWin);
    const startPromise = monitor.start();

    // First attempt happens immediately
    await vi.advanceTimersByTimeAsync(100);

    // Now advance past the deadline so the next retry check fails
    await vi.advanceTimersByTimeAsync(5_000);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await startPromise;

    // Should have only made 1-2 attempts before deadline check stopped retries
    expect(attempt).toBeLessThanOrEqual(2);
    expect(attempt).toBeGreaterThanOrEqual(1);
  });
});
