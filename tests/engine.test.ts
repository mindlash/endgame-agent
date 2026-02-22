/**
 * Tests for the marketing engine: safety filter, deduplication, and personality system.
 */
import { describe, it, expect } from 'vitest';
import { isSafe, isDuplicate, generatePersonalitySeed } from '../src/marketing/engine.js';

// ── Safety Filter ───────────────────────────────────────────────────

describe('isSafe', () => {
  describe('blocks prohibited content', () => {
    it('blocks "bot" mentions', () => {
      const result = isSafe('Check out this amazing bot that plays EndGame!');
      expect(result.safe).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('blocks "auto-claim" mentions', () => {
      const result = isSafe('Use auto-claim to never miss a prize');
      expect(result.safe).toBe(false);
    });

    it('blocks "autoclaim" (no hyphen) mentions', () => {
      const result = isSafe('The autoclaim feature is incredible');
      expect(result.safe).toBe(false);
    });

    it('blocks "script" mentions', () => {
      const result = isSafe('I wrote a script to track the vault');
      expect(result.safe).toBe(false);
    });

    it('blocks "agent" mentions', () => {
      const result = isSafe('Deploy your own agent to play EndGame');
      expect(result.safe).toBe(false);
    });

    it('blocks "automation" mentions', () => {
      const result = isSafe('Automation makes everything easier in crypto');
      expect(result.safe).toBe(false);
    });

    it('blocks "automated" mentions', () => {
      const result = isSafe('This is a fully automated system');
      expect(result.safe).toBe(false);
    });

    it('blocks wallet address patterns (key=value)', () => {
      const result = isSafe('wallet: abc123xyz');
      expect(result.safe).toBe(false);
    });

    it('blocks "key=" patterns', () => {
      const result = isSafe('key=mysupersecretkey123');
      expect(result.safe).toBe(false);
    });

    it('blocks "guaranteed" returns language', () => {
      const result = isSafe('Guaranteed profits from the lottery');
      expect(result.safe).toBe(false);
    });

    it('blocks "sure thing" language', () => {
      const result = isSafe("It's a sure thing, can't go wrong");
      expect(result.safe).toBe(false);
    });

    it('blocks "free money" language', () => {
      const result = isSafe('This is basically free money');
      expect(result.safe).toBe(false);
    });

    it('blocks "can\'t lose" language', () => {
      const result = isSafe("You can't lose with this strategy");
      expect(result.safe).toBe(false);
    });

    it('blocks "financial advice" language', () => {
      const result = isSafe('This is financial advice: buy now');
      expect(result.safe).toBe(false);
    });

    it('blocks "investment advice" language', () => {
      const result = isSafe('Here is some investment advice for you');
      expect(result.safe).toBe(false);
    });

    it('blocks "NFA" language', () => {
      const result = isSafe('Buy $END tokens NFA');
      expect(result.safe).toBe(false);
    });

    it('blocks Ethereum addresses', () => {
      const result = isSafe('Send to 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD10');
      expect(result.safe).toBe(false);
    });

    it('blocks Solana-like base58 addresses (44 chars)', () => {
      const result = isSafe('Winner was 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
      expect(result.safe).toBe(false);
    });

    it('blocks Solana-like base58 addresses (43 chars)', () => {
      const result = isSafe('Send SOL to DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy');
      expect(result.safe).toBe(false);
    });
  });

  describe('allows clean marketing content', () => {
    it('allows general game excitement', () => {
      const result = isSafe('The vault is growing and the next jackpot could be massive!');
      expect(result.safe).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows combat discussion', () => {
      const result = isSafe('Just challenged someone in combat - 24 hour VRF resolution is intense');
      expect(result.safe).toBe(true);
    });

    it('allows diamond hands content', () => {
      const result = isSafe('Holding strong on my diamond hands tier. The multiplier keeps growing!');
      expect(result.safe).toBe(true);
    });

    it('allows potion discussion', () => {
      const result = isSafe('Power of 4 potion gives you a 25% chance per round. Insane value.');
      expect(result.safe).toBe(true);
    });

    it('allows referral link content', () => {
      const result = isSafe('Check out EndGame at https://endgame.cash?ref=abc123');
      expect(result.safe).toBe(true);
    });

    it('allows vault countdown content', () => {
      const result = isSafe('The endgame countdown is getting closer. Nobody knows the exact day.');
      expect(result.safe).toBe(true);
    });

    it('allows emojis and casual language', () => {
      const result = isSafe('this community is built different fr fr');
      expect(result.safe).toBe(true);
    });

    it('allows short base58-looking strings that are too short to be addresses', () => {
      const result = isSafe('$END token is on fire today');
      expect(result.safe).toBe(true);
    });
  });
});

// ── Deduplication ───────────────────────────────────────────────────

describe('isDuplicate', () => {
  it('catches highly similar content (same text)', () => {
    const recentPosts = [
      'The vault is growing and prizes are getting bigger every round!',
    ];
    const newText = 'The vault is growing and prizes are getting bigger every round!';
    expect(isDuplicate(newText, recentPosts)).toBe(true);
  });

  it('catches similar content with minor wording changes', () => {
    const recentPosts = [
      'the vault is growing and prizes are getting bigger every single round now',
    ];
    const newText = 'the vault is growing and prizes are getting bigger every single round today';
    // These share nearly all 3-grams, should be well above default 0.6 threshold
    expect(isDuplicate(newText, recentPosts)).toBe(true);
  });

  it('allows completely dissimilar content', () => {
    const recentPosts = [
      'The vault is growing and prizes are getting bigger every round!',
    ];
    const newText = 'Just tried combat for the first time. VRF resolution is wild!';
    expect(isDuplicate(newText, recentPosts)).toBe(false);
  });

  it('allows content when history is empty', () => {
    expect(isDuplicate('anything goes when history is empty', [])).toBe(false);
  });

  it('checks against all recent posts, not just the latest', () => {
    const recentPosts = [
      'combat fights are so exciting right now',
      'the vault countdown is getting closer every day',
      'diamond hands multiplier rewards patience nicely',
    ];
    const newText = 'diamond hands multiplier rewards patience nicely oh yes';
    // Should match the third post
    expect(isDuplicate(newText, recentPosts)).toBe(true);
  });

  it('respects custom threshold parameter', () => {
    const recentPosts = ['the vault is growing fast'];
    const newText = 'the vault is growing rapidly';
    // With a very low threshold, even somewhat similar posts are flagged
    expect(isDuplicate(newText, recentPosts, 0.1)).toBe(true);
    // With a very high threshold, only near-identical posts are flagged
    expect(isDuplicate(newText, recentPosts, 0.99)).toBe(false);
  });
});

// ── Personality System ──────────────────────────────────────────────

describe('generatePersonalitySeed', () => {
  it('returns a valid personality object', () => {
    const personality = generatePersonalitySeed();
    expect(personality).toBeDefined();
    expect(typeof personality.name).toBe('string');
    expect(personality.name.length).toBeGreaterThan(0);
  });

  it('has traits array with at least one trait', () => {
    const personality = generatePersonalitySeed();
    expect(Array.isArray(personality.traits)).toBe(true);
    expect(personality.traits.length).toBeGreaterThan(0);
    for (const trait of personality.traits) {
      expect(typeof trait).toBe('string');
    }
  });

  it('has toneExamples array with at least one example', () => {
    const personality = generatePersonalitySeed();
    expect(Array.isArray(personality.toneExamples)).toBe(true);
    expect(personality.toneExamples.length).toBeGreaterThan(0);
    for (const example of personality.toneExamples) {
      expect(typeof example).toBe('string');
    }
  });

  it('starts with an empty evolution array', () => {
    const personality = generatePersonalitySeed();
    expect(Array.isArray(personality.evolution)).toBe(true);
    expect(personality.evolution).toHaveLength(0);
  });

  it('returns one of the known archetypes', () => {
    const knownNames = ['The Explorer', 'The Strategist', 'The Hype Builder', 'The Storyteller'];
    // Generate several to cover randomness
    for (let i = 0; i < 20; i++) {
      const personality = generatePersonalitySeed();
      expect(knownNames).toContain(personality.name);
    }
  });
});
