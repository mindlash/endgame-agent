/**
 * AI Marketing Engine — generates and posts content across 3 channels.
 *
 * Architecture:
 * 1. ContentGenerator: Uses LLM (Claude/OpenAI) to generate unique posts
 * 2. PersonalitySystem: Each agent develops its own voice over time
 * 3. SafetyFilter: Blocks prohibited content before posting
 * 4. Deduplicator: Ensures no repeated themes across recent history
 * 5. ChannelAdapters: Twitter/X, Discord, Telegram posting
 *
 * The marketing engine has NO access to the signing subprocess.
 * It can read public game data (via API client) for content context.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('marketing');

// ── Content Generation ──────────────────────────────────────────────

export interface GeneratedPost {
  text: string;
  channel: 'twitter' | 'discord' | 'telegram';
  hasReferralLink: boolean;
  personality: string;
  generatedAt: string;
}

export interface PostHistory {
  posts: Array<{
    text: string;
    channel: string;
    postedAt: string;
    postId?: string;
  }>;
}

/**
 * Game knowledge context for the LLM — factual mechanics only.
 * No strategy, no exploitation, no automation hints.
 */
export const GAME_KNOWLEDGE = `
EndGame is a Solana-based lottery and combat game (Season 1).

Key facts for content:
- Hold $END tokens to auto-enter lottery draws every ~1-2 hours
- Winner gets 1% of the vault balance each round, provably fair via VRF
- Combat: 1v1 PvP challenges with 24-hour resolution period
- Diamond Hands: holding tokens grows your multiplier over time (Paper to Legend)
- Potions: Power of 4/8 lock you into smaller draw pools (better odds)
- Store: credits buy powerups, mystery boxes, and potions
- Donor tiers: permanent multiplier boosts (Bronze through Champion)
- The Endgame: vault fills over time, triggers a massive distribution event
- Unclaimed prizes roll over, making jackpots grow
- Referrals: 2-level system that adds to lottery weight
- Season 1 is LIVE on Solana mainnet
`.trim();

/**
 * Hard rules the LLM must follow — enforced by SafetyFilter as a second layer.
 */
export const CONTENT_RULES = `
NEVER mention: bots, automation, auto-claim, scripting, agents
NEVER mention: specific holdings, wallet sizes, exact ranks, insider info
NEVER mention: financial advice, guaranteed returns, investment recommendations
NEVER include: wallet addresses, private keys, API endpoints, technical exploits
ALWAYS keep: tweets under 260 chars, Discord under 500 chars, Telegram under 300 chars
VARY tone: excitement, curiosity, educational, community vibes, FOMO, humor
`.trim();

// ── Safety Filter ───────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /\b(bot|auto.?claim|script|agent|automat)/i,
  /\b(wallet|address|key)\s*[:=]/i,
  /\b(guaranteed|sure.?thing|free.?money|can't.?lose)/i,
  /\b(financial.?advice|investment.?advice|NFA)/i,
  /\b(0x[a-fA-F0-9]{40})/,                    // ETH addresses
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/,         // Solana addresses (base58)
];

export function isSafe(text: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return { safe: false, reason: `Matched blocked pattern: ${pattern.source}` };
    }
  }
  return { safe: true };
}

// ── Personality System ──────────────────────────────────────────────

export interface Personality {
  name: string;
  traits: string[];
  toneExamples: string[];
  evolution: Array<{
    date: string;
    change: string;
  }>;
}

/**
 * Each agent develops a unique personality over time.
 * Starts with a seed personality, evolves based on engagement metrics.
 */
export function generatePersonalitySeed(): Personality {
  const archetypes = [
    {
      name: 'The Explorer',
      traits: ['curious', 'enthusiastic', 'asks questions'],
      toneExamples: [
        'just discovered something wild about the combat system...',
        'wait, so if you hold longer your odds actually go UP?',
      ],
    },
    {
      name: 'The Strategist',
      traits: ['analytical', 'competitive', 'data-driven'],
      toneExamples: [
        'ran the numbers on potion timing and the dead zone is real',
        'the math on donor tiers is actually insane value per dollar',
      ],
    },
    {
      name: 'The Hype Builder',
      traits: ['energetic', 'community-focused', 'memetic'],
      toneExamples: [
        'the vault just hit a new % and nobody is talking about it',
        'this community is actually built different',
      ],
    },
    {
      name: 'The Storyteller',
      traits: ['narrative', 'dramatic', 'hooks with mystery'],
      toneExamples: [
        'someone just won and they only had 0.5% of supply. the underdog arc is real',
        'the countdown is ticking. nobody knows the exact day. thats the beauty of it',
      ],
    },
  ];

  return {
    ...archetypes[Math.floor(Math.random() * archetypes.length)],
    evolution: [],
  };
}

// ── Deduplication ───────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.6;

/**
 * Simple n-gram based similarity check against recent history.
 * Prevents repetitive themes even when LLM wording varies.
 */
export function isDuplicate(
  newText: string,
  recentPosts: string[],
  threshold = SIMILARITY_THRESHOLD,
): boolean {
  const newGrams = nGrams(newText.toLowerCase(), 3);
  for (const recent of recentPosts) {
    const recentGrams = nGrams(recent.toLowerCase(), 3);
    const similarity = jaccardSimilarity(newGrams, recentGrams);
    if (similarity > threshold) return true;
  }
  return false;
}

function nGrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  const words = text.split(/\s+/);
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(' '));
  }
  return grams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

// ── Channel Adapters ────────────────────────────────────────────────

export interface ChannelAdapter {
  name: string;
  post(content: string, referralLink?: string): Promise<{ postId: string }>;
}

// Implementations in separate files: twitter.ts, discord.ts, telegram.ts
