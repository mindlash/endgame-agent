/**
 * Marketing Scheduler — orchestrates timed content generation and posting.
 *
 * Pulls live game data, generates AI content via the LLM module,
 * runs safety + dedup filters, and dispatches to all enabled channels.
 * Designed to run alongside the claim engine without crashing.
 */

import { createLogger } from '../core/logger.js';
import { EndGameApi } from '../api/client.js';
import { isSafe, isDuplicate } from './engine.js';
import { generateContent } from './llm.js';
import type { LlmConfig } from './llm.js';
import type { Personality, ChannelAdapter } from './engine.js';

const log = createLogger('scheduler');

const MAX_RETRIES = 3;
const HISTORY_LIMIT = 50;
const JITTER_MS = 15 * 60 * 1000; // +/- 15 minutes

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

      await sleep(delay);
    }
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    log.info('Scheduler stopped');
  }

  // ── Core posting cycle ────────────────────────────────────────────

  private async postCycle(): Promise<void> {
    const gameContext = await this.fetchGameContext();

    for (const channel of this.channels) {
      const channelName = channel.name as 'twitter' | 'discord' | 'telegram';

      try {
        const text = await this.generateSafeContent(channelName, gameContext);
        if (!text) {
          log.warn('All retries exhausted, skipping slot', { channel: channelName });
          continue;
        }

        await channel.post(text);
        this.addToHistory(text);
        log.info('Posted successfully', { channel: channelName, length: text.length });
      } catch (err) {
        log.error('Channel post failed', { channel: channelName, error: String(err) });
      }
    }
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

        const safety = isSafe(text);
        if (!safety.safe) {
          log.warn('Safety filter rejected content', { attempt, reason: safety.reason });
          continue;
        }

        if (isDuplicate(text, this.postHistory)) {
          log.warn('Duplicate content detected, retrying', { attempt });
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
  }
}
