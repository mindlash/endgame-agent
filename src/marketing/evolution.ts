/**
 * Personality Evolution — LLM-driven self-reflection after every N posts.
 *
 * Since real engagement metrics (likes, views) are unavailable on Basic-tier
 * APIs, we use proxy signals: post success/failure rates, safety/dedup
 * rejection counts, and the LLM itself as the evaluator.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '../core/logger.js';
import { callLlmRaw } from './llm.js';
import type { LlmConfig } from './llm.js';
import type { Personality } from './engine.js';

const log = createLogger('evolution');

const PERSONALITY_FILE = join(process.cwd(), '.agent-data', 'personality.json');

export interface EvolutionStats {
  totalGenerated: number;
  safetyRejections: number;
  dedupRejections: number;
  postsFailed: number;
  postsSucceeded: number;
}

export interface EvolutionResult {
  traits: string[];
  toneExamples: string[];
  summary: string;
}

export function savePersonality(personality: Personality): void {
  try {
    mkdirSync(dirname(PERSONALITY_FILE), { recursive: true });
    writeFileSync(PERSONALITY_FILE, JSON.stringify(personality, null, 2) + '\n');
    log.info('Personality saved to disk');
  } catch (err) {
    log.warn('Failed to save personality', { error: String(err) });
  }
}

export async function evolvePersonality(
  llmConfig: LlmConfig,
  personality: Personality,
  recentPosts: string[],
  stats: EvolutionStats,
): Promise<Personality> {
  const system = [
    'You are an AI personality coach. You review an agent\'s recent social media posts and evolve its personality traits and tone.',
    'Return ONLY valid JSON matching this schema: { "traits": string[], "toneExamples": string[], "summary": string }',
    'Keep 3 traits and 2 tone examples. Adjust based on what seems to be working (high success rate) or not (many rejections).',
    'The summary should be 1 sentence explaining what changed and why.',
  ].join('\n');

  const evolutionHistory = personality.evolution.slice(-3);

  const user = [
    `Current personality: ${personality.name}`,
    `Traits: ${personality.traits.join(', ')}`,
    `Tone examples:\n${personality.toneExamples.join('\n')}`,
    '',
    `Recent posts (last ${recentPosts.length}):\n${recentPosts.slice(-20).join('\n---\n')}`,
    '',
    `Cycle stats: ${stats.postsSucceeded} succeeded, ${stats.postsFailed} failed, ${stats.safetyRejections} safety rejections, ${stats.dedupRejections} dedup rejections`,
    '',
    evolutionHistory.length
      ? `Previous evolutions:\n${evolutionHistory.map(e => `${e.date}: ${e.change}`).join('\n')}`
      : 'No previous evolutions yet.',
    '',
    'Based on the posts and stats, return updated traits and tone examples as JSON.',
  ].join('\n');

  try {
    const raw = await callLlmRaw(llmConfig, system, user);

    // Extract JSON from response (handle markdown code fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('Evolution LLM returned no JSON, personality unchanged');
      return personality;
    }

    const result: EvolutionResult = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(result.traits) || !Array.isArray(result.toneExamples) || typeof result.summary !== 'string') {
      log.warn('Evolution LLM returned invalid structure, personality unchanged');
      return personality;
    }

    const evolved: Personality = {
      ...personality,
      traits: result.traits,
      toneExamples: result.toneExamples,
      evolution: [
        ...personality.evolution,
        { date: new Date().toISOString(), change: result.summary },
      ],
    };

    log.info('Personality evolved', { summary: result.summary });
    return evolved;
  } catch (err) {
    log.warn('Evolution failed, personality unchanged', { error: String(err) });
    return personality;
  }
}
