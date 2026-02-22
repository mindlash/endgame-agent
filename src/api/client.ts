/**
 * EndGame API client.
 *
 * All endpoints require Origin + Referer headers.
 * Uses the same public API as the website — no special access.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('api');

const BASE_URL = 'https://endgame.cash';
const REQUIRED_HEADERS = {
  'Accept': 'application/json',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/`,
};

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  timestamp: string;
}

export class EndGameApi {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl = BASE_URL, timeoutMs = 15_000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  private async get<T>(path: string): Promise<T> {
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

      const body = (await res.json()) as ApiResponse<T>;
      return body.data ?? (body as unknown as T);
    } finally {
      clearTimeout(timer);
    }
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

      const body = (await res.json()) as ApiResponse<T>;
      return body.data ?? (body as unknown as T);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Round monitoring ──────────────────────────────────────────────

  async getCurrentRound() {
    return this.get<{
      round_id: string;
      status: string;
      winner_wallet?: string;
      claim_deadline?: string;
      prize_amount?: number;
    }>('/api/game/current-round');
  }

  async getGameStatus() {
    return this.get<Record<string, unknown>>('/api/game/status');
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

  // ── Claiming ─────────────────────────────────────────────────────

  async submitClaim(payload: {
    round_id: string;
    wallet: string;
    signature: string;
  }): Promise<{ tx_signature: string }> {
    return this.post<{ tx_signature: string }>('/api/game/claim', payload);
  }

  // ── Game pulse ────────────────────────────────────────────────────

  async getStatsDigest() {
    return this.get<Record<string, unknown>>('/api/stats/digest');
  }

  async getLevelRequirements() {
    return this.get<Array<Record<string, unknown>>>('/api/level/requirements');
  }
}
