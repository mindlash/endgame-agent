/**
 * EndGame API client.
 *
 * All endpoints require Origin + Referer headers.
 * Uses the same public API as the website -- no special access.
 *
 * IMPORTANT: API base is https://api.endgame.cash (not https://endgame.cash).
 * Response formats vary by endpoint -- some return raw JSON, others wrap in {success, data}.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('api');

const DEFAULT_BASE_URL = 'https://api.endgame.cash';
const REQUIRED_HEADERS = {
  'Accept': 'application/json',
  'Origin': 'https://endgame.cash',
  'Referer': 'https://endgame.cash/',
};

// ── Response types ───────────────────────────────────────────────────

/** Game status from /api/game/status -- NOT wrapped in {success, data}. */
export interface GameStatusResponse {
  round_id: number;
  current_round: number;
  winner: string;
  prize_amount: string;
  claim_deadline: number;
  status: string;
  time_remaining_seconds: number;
  vault_balance: string;
}

/** Claim verification result from /api/claims/verify. */
export interface ClaimVerifyResult {
  roundId: number;
  claimable: boolean;
  reason?: string;
}

export interface ClaimVerifyResponse {
  results: ClaimVerifyResult[];
}

// ── Client ───────────────────────────────────────────────────────────

export class EndGameApi {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl = DEFAULT_BASE_URL, timeoutMs = 15_000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Raw GET -- returns the parsed JSON body as-is (no unwrapping).
   */
  private async getRaw<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        headers: REQUIRED_HEADERS,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`API ${res.status}: ${path}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET for endpoints that wrap responses in {success, data, ...}.
   * Falls back to returning the body as-is if no .data wrapper exists.
   */
  private async get<T>(path: string): Promise<T> {
    const body = await this.getRaw<Record<string, unknown>>(path);
    if ('data' in body && body.data !== undefined) {
      return body.data as T;
    }
    return body as unknown as T;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...REQUIRED_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`API ${res.status}: ${path}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Round monitoring ──────────────────────────────────────────────

  /**
   * Get current game status. Returns the raw response (not wrapped).
   * Fields: round_id (number), winner (string), prize_amount (string),
   *         claim_deadline (unix timestamp number), status (string).
   */
  async getGameStatus(): Promise<GameStatusResponse> {
    return this.getRaw<GameStatusResponse>('/api/game/status');
  }

  /**
   * Alias for getGameStatus -- this is the primary round-checking method.
   * The old /api/game/current-round endpoint is NOT used; /api/game/status
   * contains all the information needed for monitoring.
   */
  async getCurrentRound(): Promise<GameStatusResponse> {
    return this.getGameStatus();
  }

  // ── Claim verification ────────────────────────────────────────────

  /**
   * Verify whether rounds are claimable before building on-chain transactions.
   * POST to /api/claims/verify with {roundIds, walletAddress}.
   */
  async verifyClaims(roundIds: number[], walletAddress: string): Promise<ClaimVerifyResponse> {
    return this.post<ClaimVerifyResponse>('/api/claims/verify', {
      roundIds,
      walletAddress,
    });
  }

  // ── Vault & price ─────────────────────────────────────────────────

  async getVaultProjection() {
    return this.get<{
      days_until_target: number;
      confidence: number;
    }>('/api/vault/projection');
  }

  async getPrice() {
    return this.get<{
      price_usd: number;
      change_24h: number;
      volume_24h: number;
      liquidity: number;
    }>('/api/price');
  }

  // ── Player data ───────────────────────────────────────────────────

  async getRankings() {
    return this.get<Array<Record<string, unknown>>>('/api/rankings');
  }

  async getWeightBreakdown(wallet: string) {
    return this.get<Record<string, unknown>>(`/api/weight-breakdown/${wallet}`);
  }

  async getDiamondHands(wallet: string) {
    return this.get<Record<string, unknown>>(`/api/diamond-hands/status/${wallet}`);
  }

  async getCombatFortune(wallet: string) {
    return this.get<Record<string, unknown>>(`/api/combat-fortune/${wallet}`);
  }

  // ── Store & potions ───────────────────────────────────────────────

  async getDonorBoost(wallet: string) {
    return this.get<Record<string, unknown>>(`/api/store/donor-boost?wallet=${wallet}`);
  }

  async getPotionStatus(wallet: string) {
    return this.get<Record<string, unknown>>(`/api/store/potions/status?wallet=${wallet}`);
  }

  // ── Combat ────────────────────────────────────────────────────────

  async getChallengeStats(wallet: string) {
    return this.get<{
      total: number;
      won: number;
      lost: number;
    }>(`/api/challenges/stats/${wallet}`);
  }

  async getActiveChallenges() {
    return this.get<Array<Record<string, unknown>>>('/api/challenges/active');
  }

  // ── Game pulse ────────────────────────────────────────────────────

  async getStatsDigest() {
    return this.get<Record<string, unknown>>('/api/stats/digest');
  }

  async getLevelRequirements() {
    return this.get<Array<Record<string, unknown>>>('/api/level/requirements');
  }
}
