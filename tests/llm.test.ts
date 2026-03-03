/**
 * Tests for LLM content generation: prompt building, Claude and OpenAI API call formats.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateContent, type LlmConfig } from '../src/marketing/llm.js';
import { GAME_KNOWLEDGE, CONTENT_RULES } from '../src/marketing/engine.js';
import type { Personality } from '../src/marketing/engine.js';

// ── Fetch Mock Setup ─────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Test Fixtures ───────────────────────────────────────────────────

const testPersonality: Personality = {
  name: 'The Explorer',
  traits: ['curious', 'enthusiastic', 'asks questions'],
  toneExamples: [
    'just discovered something wild about the combat system...',
    'wait, so if you hold longer your odds actually go UP?',
  ],
  evolution: [],
};

const testGameContext: Record<string, unknown> = {
  price: { price_usd: 0.05, change_24h: 10 },
  vault: { days_until_target: 18, confidence: 0.85 },
};

// ── Prompt Building Tests ───────────────────────────────────────────

describe('generateContent prompt building', () => {
  it('includes personality in Claude API call', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'The vault is heating up!' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], 'ref123');

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);

    // System prompt should include personality name and traits
    expect(body.system).toContain('The Explorer');
    expect(body.system).toContain('curious');
    expect(body.system).toContain('enthusiastic');
  });

  it('includes game knowledge in system prompt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Combat is wild!' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // System prompt should contain game knowledge
    expect(body.system).toContain('EndGame is a Solana-based lottery');
    expect(body.system).toContain('Diamond Hands');
  });

  it('includes content rules in system prompt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Check it out!' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.system).toContain('NEVER mention');
    expect(body.system).toContain('bots, automation');
  });

  it('includes game context in user prompt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Wow!' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMessage = body.messages[0].content;
    expect(userMessage).toContain('price_usd');
    expect(userMessage).toContain('0.05');
  });

  it('includes referral code in user prompt when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Check this out!' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], 'myref');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMessage = body.messages[0].content;
    expect(userMessage).toContain('https://endgame.cash?ref=myref');
  });

  it('includes recent posts for dedup context', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Something new!' }],
      }),
    } as unknown as Response);

    const recentPosts = ['Previous post about vault', 'Another about combat'];
    const config: LlmConfig = { provider: 'claude', apiKey: 'test-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, recentPosts, '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMessage = body.messages[0].content;
    expect(userMessage).toContain('Previous post about vault');
    expect(userMessage).toContain('Another about combat');
  });
});

// ── Claude API Format ───────────────────────────────────────────────

describe('Claude API call format', () => {
  it('calls the correct Claude endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Generated tweet' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'claude-key-123' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('sends correct Claude headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Tweet' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'claude-key-abc' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('claude-key-abc');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });

  it('uses default Claude model when not specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Tweet' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('uses custom model when specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Tweet' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'key', model: 'claude-opus-4-20250514' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-opus-4-20250514');
  });

  it('sends system as top-level field and user message in messages array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'Tweet' }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(typeof body.system).toBe('string');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.max_tokens).toBe(300);
  });

  it('throws on non-200 Claude response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'claude', apiKey: 'key' };
    await expect(
      generateContent(config, 'twitter', testPersonality, testGameContext, [], ''),
    ).rejects.toThrow('Claude API 429');
  });
});

// ── OpenAI API Format ───────────────────────────────────────────────

describe('OpenAI API call format', () => {
  it('calls the correct OpenAI endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Generated tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'openai', apiKey: 'sk-openai-key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('sends correct OpenAI headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'openai', apiKey: 'sk-openai-key-abc' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer sk-openai-key-abc');
    expect(headers['content-type']).toBe('application/json');
  });

  it('uses default OpenAI model when not specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'openai', apiKey: 'key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o-mini');
  });

  it('sends system and user messages in messages array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'openai', apiKey: 'key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.max_tokens).toBe(300);
  });

  it('throws on non-200 OpenAI response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'openai', apiKey: 'bad-key' };
    await expect(
      generateContent(config, 'twitter', testPersonality, testGameContext, [], ''),
    ).rejects.toThrow('OpenAI API 401');
  });
});

// ── Gemini API Format ────────────────────────────────────────────────

describe('Gemini API call format', () => {
  it('calls the correct Gemini endpoint with API key in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Generated tweet' }] } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'gemini', apiKey: 'gemini-key-123' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('key=gemini-key-123');
    expect(url).toContain('gemini-2.0-flash');
  });

  it('uses Gemini content format with systemInstruction', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Tweet' }] } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'gemini', apiKey: 'key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.systemInstruction).toBeDefined();
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
    expect(body.generationConfig.maxOutputTokens).toBe(300);
  });

  it('throws on non-200 Gemini response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'gemini', apiKey: 'bad-key' };
    await expect(
      generateContent(config, 'twitter', testPersonality, testGameContext, [], ''),
    ).rejects.toThrow('Gemini API 403');
  });
});

// ── Groq API Format ─────────────────────────────────────────────────

describe('Groq API call format', () => {
  it('calls the correct Groq endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Generated tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'groq', apiKey: 'groq-key-123' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('sends correct Groq headers (OpenAI-compatible)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'groq', apiKey: 'groq-key-abc' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer groq-key-abc');
  });

  it('uses default Groq model', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Tweet' } }],
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'groq', apiKey: 'key' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('llama-3.3-70b-versatile');
  });

  it('throws on non-200 Groq response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'groq', apiKey: 'bad-key' };
    await expect(
      generateContent(config, 'twitter', testPersonality, testGameContext, [], ''),
    ).rejects.toThrow('Groq API 401');
  });
});

// ── Ollama API Format ───────────────────────────────────────────────

describe('Ollama API call format', () => {
  it('calls the correct Ollama endpoint with default base URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: 'Generated tweet' },
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'ollama', apiKey: '' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
  });

  it('uses custom Ollama base URL when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: 'Tweet' },
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'ollama', apiKey: '', ollamaBaseUrl: 'http://myserver:11434' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    expect(mockFetch.mock.calls[0][0]).toBe('http://myserver:11434/api/chat');
  });

  it('sends stream: false and correct message format', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: 'Tweet' },
      }),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'ollama', apiKey: '' };
    await generateContent(config, 'twitter', testPersonality, testGameContext, [], '');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('llama3.2');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('throws on non-200 Ollama response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('model not found'),
    } as unknown as Response);

    const config: LlmConfig = { provider: 'ollama', apiKey: '' };
    await expect(
      generateContent(config, 'twitter', testPersonality, testGameContext, [], ''),
    ).rejects.toThrow('Ollama API 404');
  });
});
