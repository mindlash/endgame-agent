/**
 * Marketing Scheduler — orchestrates timed content generation and posting.
 *
 * Pulls live game data, generates AI content via the LLM module,
 * runs safety + dedup filters, and dispatches to all enabled channels.
 * Designed to run alongside the claim engine without crashing.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '../core/logger.js';
import { EndGameApi } from '../api/client.js';
import { isSafe, isDuplicate } from './engine.js';
import { generateContent } from './llm.js';
import { evolvePersonality, savePersonality } from './evolution.js';
import type { LlmConfig } from './llm.js';
import type { Personality, ChannelAdapter } from './engine.js';
import type { EvolutionStats } from './evolution.js';

const log = createLogger('scheduler');

const MAX_RETRIES = 3;
const HISTORY_LIMIT = 50;
const JITTER_MS = 15 * 60 * 1000; // +/- 15 minutes
const HISTORY_FILE = join(process.cwd(), '.agent-data', 'post-history.json');
const EVOLUTION_INTERVAL = 20;

export class MarketingScheduler {
  private api: EndGameApi;
  private llmConfig: LlmConfig;
  private channels: ChannelAdapter[];
  private personality: Personality;
  private referralCode: string;
  private postsPerDay: number;
  private postHistory: string[] = [];
  private running = false;
  private abortController: AbortController | null = null;
  private postsSinceEvolution = 0;
  private cycleStats: EvolutionStats = {
    totalGenerated: 0,
    safetyRejections: 0,
    dedupRejections: 0,
    postsFailed: 0,
    postsSucceeded: 0,
  };

  constructor(
    api: EndGameApi,
    llmConfig: LlmConfig,
    channels: ChannelAdapter[],
    personality: Personality,
    referralCode: string,
    postsPerDay = 4,
  ) {
    this.api = api;
    this.llmConfig = llmConfig;
    this.channels = channels;
    this.personality = personality;
    this.referralCode = referralCode;
    this.postsPerDay = postsPerDay;
    this.loadHistory();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    const intervalMs = (24 * 60 * 60 * 1000) / this.postsPerDay;
    log.info('Scheduler started', { postsPerDay: this.postsPerDay, intervalMs, channels: this.channels.length });

    while (this.running) {
      try {
        await this.postCycle();
      } catch (err) {
        log.error('Post cycle failed', { error: String(err) });
      }

      const jitter = Math.random() * 2 * JITTER_MS - JITTER_MS;
      const delay = Math.max(intervalMs + jitter, 60_000); // at least 1 minute
      log.debug('Next post scheduled', { delayMs: Math.round(delay) });

      await this.sleep(delay);
    }
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    log.info('Scheduler stopped');
  }

  // ── Signal-aware sleep ────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      this.abortController?.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── Core posting cycle ────────────────────────────────────────────

  private async postCycle(): Promise<void> {
    const gameContext = await this.fetchGameContext();
    const referralLink = this.referralCode ? `https://endgame.cash?ref=${this.referralCode}` : undefined;

    const results = await Promise.allSettled(
      this.channels.map(async (channel) => {
        const channelName = channel.name as 'twitter' | 'discord' | 'telegram';

        const text = await this.generateSafeContent(channelName, gameContext);
        if (!text) {
          log.warn('All retries exhausted, skipping slot', { channel: channelName });
          this.cycleStats.postsFailed++;
          return;
        }

        await channel.post(text, referralLink);
        this.addToHistory(text);
        this.cycleStats.postsSucceeded++;
        this.postsSinceEvolution++;
        log.info('Posted successfully', { channel: channelName, length: text.length });
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        log.error('Channel post failed', { error: String(result.reason) });
        this.cycleStats.postsFailed++;
      }
    }

    await this.maybeEvolve();
  }

  private async maybeEvolve(): Promise<void> {
    if (this.postsSinceEvolution < EVOLUTION_INTERVAL) return;

    log.info('Evolution threshold reached, reflecting on personality', {
      postsSinceEvolution: this.postsSinceEvolution,
    });

    try {
      this.personality = await evolvePersonality(
        this.llmConfig,
        this.personality,
        this.postHistory,
        this.cycleStats,
      );
      savePersonality(this.personality);
    } catch (err) {
      log.warn('Evolution cycle failed', { error: String(err) });
    }

    this.postsSinceEvolution = 0;
    this.cycleStats = {
      totalGenerated: 0,
      safetyRejections: 0,
      dedupRejections: 0,
      postsFailed: 0,
      postsSucceeded: 0,
    };
  }

  private async generateSafeContent(
    channel: 'twitter' | 'discord' | 'telegram',
    gameContext: Record<string, unknown>,
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const text = await generateContent(
          this.llmConfig,
          channel,
          this.personality,
          gameContext,
          this.postHistory,
          this.referralCode,
        );
        this.cycleStats.totalGenerated++;

        const safety = isSafe(text);
        if (!safety.safe) {
          log.warn('Safety filter rejected content', { attempt, reason: safety.reason });
          this.cycleStats.safetyRejections++;
          continue;
        }

        if (isDuplicate(text, this.postHistory)) {
          log.warn('Duplicate content detected, retrying', { attempt });
          this.cycleStats.dedupRejections++;
          continue;
        }

        return text;
      } catch (err) {
        log.error('LLM generation failed', { attempt, error: String(err) });
      }
    }

    return null;
  }

  // ── Game context fetching ─────────────────────────────────────────

  private async fetchGameContext(): Promise<Record<string, unknown>> {
    const context: Record<string, unknown> = {};

    const fetchers: Array<[string, () => Promise<unknown>]> = [
      ['price', () => this.api.getPrice()],
      ['stats', () => this.api.getStatsDigest()],
      ['vault', () => this.api.getVaultProjection()],
      ['gameStatus', () => this.api.getGameStatus()],
      ['activeChallenges', () => this.api.getActiveChallenges()],
      ['rankings', () => this.api.getRankings()],
    ];

    await Promise.all(
      fetchers.map(async ([key, fn]) => {
        try {
          context[key] = await fn();
        } catch (err) {
          log.warn('Failed to fetch game context', { key, error: String(err) });
          context[key] = null;
        }
      }),
    );

    return context;
  }

  // ── Post history management ───────────────────────────────────────

  private addToHistory(text: string): void {
    this.postHistory.push(text);
    if (this.postHistory.length > HISTORY_LIMIT) {
      this.postHistory = this.postHistory.slice(-HISTORY_LIMIT);
    }
    this.saveHistory();
  }

  private loadHistory(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          this.postHistory = data.slice(-HISTORY_LIMIT);
          log.info('Loaded post history from disk', { count: this.postHistory.length });
        }
      }
    } catch (err) {
      log.warn('Failed to load post history', { error: String(err) });
    }
  }

  private saveHistory(): void {
    try {
      mkdirSync(dirname(HISTORY_FILE), { recursive: true });
      writeFileSync(HISTORY_FILE, JSON.stringify(this.postHistory, null, 2) + '\n');
    } catch (err) {
      log.warn('Failed to save post history', { error: String(err) });
    }
  }
}
