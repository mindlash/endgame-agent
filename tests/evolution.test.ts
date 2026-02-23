/**
 * Tests for personality evolution: LLM-driven self-reflection and persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evolvePersonality, savePersonality } from '../src/marketing/evolution.js';
import type { EvolutionStats } from '../src/marketing/evolution.js';
import type { LlmConfig } from '../src/marketing/llm.js';
import type { Personality } from '../src/marketing/engine.js';
import { writeFileSync, mkdirSync } from 'node:fs';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Fixtures ─────────────────────────────────────────────────────────

const testPersonality: Personality = {
  name: 'The Explorer',
  traits: ['curious', 'enthusiastic', 'asks questions'],
  toneExamples: [
    'just discovered something wild about the combat system...',
    'wait, so if you hold longer your odds actually go UP?',
  ],
  evolution: [],
};

const testStats: EvolutionStats = {
  totalGenerated: 25,
  safetyRejections: 2,
  dedupRejections: 3,
  postsFailed: 1,
  postsSucceeded: 20,
};

const testPosts = [
  'The vault just hit a new milestone!',
  'Combat fights are heating up today.',
  'Diamond hands paying off big time.',
];

const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };

// ── evolvePersonality ────────────────────────────────────────────────

describe('evolvePersonality', () => {
  it('returns updated personality with new traits and evolution entry', async () => {
    const llmResponse = JSON.stringify({
      traits: ['bold', 'data-curious', 'community-driven'],
      toneExamples: [
        'the numbers dont lie — vault growth is accelerating',
        'combat fortune stacking up nicely this week',
      ],
      summary: 'Shifted toward data-driven excitement based on successful analytical posts.',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: llmResponse }] }),
    } as unknown as Response);

    const evolved = await evolvePersonality(config, testPersonality, testPosts, testStats);

    expect(evolved.name).toBe('The Explorer');
    expect(evolved.traits).toEqual(['bold', 'data-curious', 'community-driven']);
    expect(evolved.toneExamples).toHaveLength(2);
    expect(evolved.evolution).toHaveLength(1);
    expect(evolved.evolution[0].change).toContain('data-driven');
  });

  it('handles LLM response wrapped in markdown code fences', async () => {
    const llmResponse = '```json\n' + JSON.stringify({
      traits: ['strategic', 'witty', 'observant'],
      toneExamples: ['interesting pattern forming', 'the meta is shifting'],
      summary: 'Added wit to engage more readers.',
    }) + '\n```';

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: llmResponse }] }),
    } as unknown as Response);

    const evolved = await evolvePersonality(config, testPersonality, testPosts, testStats);

    expect(evolved.traits).toEqual(['strategic', 'witty', 'observant']);
    expect(evolved.evolution).toHaveLength(1);
  });

  it('returns original personality when LLM returns no JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: 'I cannot help with that.' }] }),
    } as unknown as Response);

    const result = await evolvePersonality(config, testPersonality, testPosts, testStats);

    expect(result).toEqual(testPersonality);
  });

  it('returns original personality when LLM returns invalid structure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: '{ "wrong": "shape" }' }] }),
    } as unknown as Response);

    const result = await evolvePersonality(config, testPersonality, testPosts, testStats);

    expect(result).toEqual(testPersonality);
  });

  it('returns original personality when LLM call throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await evolvePersonality(config, testPersonality, testPosts, testStats);

    expect(result).toEqual(testPersonality);
  });

  it('preserves existing evolution history', async () => {
    const personalityWithHistory: Personality = {
      ...testPersonality,
      evolution: [{ date: '2025-01-01T00:00:00.000Z', change: 'Initial tweak' }],
    };

    const llmResponse = JSON.stringify({
      traits: ['bold', 'focused', 'edgy'],
      toneExamples: ['lets go', 'no holding back'],
      summary: 'Doubled down on boldness.',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: llmResponse }] }),
    } as unknown as Response);

    const evolved = await evolvePersonality(config, personalityWithHistory, testPosts, testStats);

    expect(evolved.evolution).toHaveLength(2);
    expect(evolved.evolution[0].change).toBe('Initial tweak');
    expect(evolved.evolution[1].change).toBe('Doubled down on boldness.');
  });
});

// ── savePersonality ──────────────────────────────────────────────────

describe('savePersonality', () => {
  it('writes personality JSON to disk', () => {
    savePersonality(testPersonality);

    expect(mkdirSync).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('personality.json'),
      expect.stringContaining('"The Explorer"'),
    );
  });
});
