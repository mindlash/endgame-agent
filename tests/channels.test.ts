/**
 * Tests for channel adapters: Discord, Telegram, Twitter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordChannel } from '../src/marketing/channels/discord.js';
import { TelegramChannel } from '../src/marketing/channels/telegram.js';
import { TwitterChannel } from '../src/marketing/channels/twitter.js';

// ── Fetch Mock Setup ─────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Discord Adapter ─────────────────────────────────────────────────

describe('DiscordChannel', () => {
  const VALID_WEBHOOK = 'https://discord.com/api/webhooks/123456/abcdef';

  it('validates webhook URL must start with correct prefix', () => {
    expect(() => new DiscordChannel(VALID_WEBHOOK)).not.toThrow();
  });

  it('rejects invalid webhook URL', () => {
    expect(() => new DiscordChannel('https://example.com/webhook')).toThrow(
      'Invalid Discord webhook URL',
    );
  });

  it('rejects empty webhook URL', () => {
    expect(() => new DiscordChannel('')).toThrow('Invalid Discord webhook URL');
  });

  it('posts content to webhook with ?wait=true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'msg_123' }),
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    const result = await channel.post('Hello EndGame!');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(VALID_WEBHOOK + '?wait=true');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ content: 'Hello EndGame!' });
    expect(result.postId).toBe('msg_123');
  });

  it('appends referral link when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'msg_456' }),
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    await channel.post('Check this out', 'https://endgame.cash?ref=abc');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toBe('Check this out\nhttps://endgame.cash?ref=abc');
  });

  it('handles rate limiting (429 status)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ retry_after: 5 }),
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    await expect(channel.post('Test')).rejects.toThrow('Discord rate limited');
  });

  it('handles non-OK responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    await expect(channel.post('Test')).rejects.toThrow('Discord webhook failed (500)');
  });

  it('passes an AbortSignal for timeout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'msg_789' }),
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    await channel.post('Test');

    const options = mockFetch.mock.calls[0][1];
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

// ── Telegram Adapter ────────────────────────────────────────────────

describe('TelegramChannel', () => {
  const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
  const CHAT_ID = '-1001234567890';

  it('requires both botToken and chatId', () => {
    expect(() => new TelegramChannel(BOT_TOKEN, CHAT_ID)).not.toThrow();
    expect(() => new TelegramChannel('', CHAT_ID)).toThrow(
      'Telegram adapter requires both botToken and chatId',
    );
    expect(() => new TelegramChannel(BOT_TOKEN, '')).toThrow(
      'Telegram adapter requires both botToken and chatId',
    );
  });

  it('constructs correct Bot API URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await channel.post('Hello Telegram!');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
  });

  it('sends correct payload with chat_id and parse_mode', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await channel.post('Test message');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.text).toBe('Test message');
    expect(body.parse_mode).toBe('Markdown');
  });

  it('appends referral link when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 43 } }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await channel.post('Check out EndGame', 'https://endgame.cash?ref=xyz');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('Check out EndGame\nhttps://endgame.cash?ref=xyz');
  });

  it('returns postId as string from message_id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 99 } }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    const result = await channel.post('Test');

    expect(result.postId).toBe('99');
  });

  it('handles non-OK HTTP response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await expect(channel.post('Test')).rejects.toThrow('Telegram API failed (400)');
  });

  it('handles Telegram API error (ok: false in response body)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Chat not found' }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await expect(channel.post('Test')).rejects.toThrow('Telegram API error: Chat not found');
  });

  it('passes an AbortSignal for timeout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await channel.post('Test');

    const options = mockFetch.mock.calls[0][1];
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

// ── Twitter Adapter ─────────────────────────────────────────────────

describe('TwitterChannel', () => {
  const VALID_CONFIG = {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    accessToken: 'test-access-token',
    accessTokenSecret: 'test-access-token-secret',
  };

  it('requires all four OAuth credentials', () => {
    expect(() => new TwitterChannel(VALID_CONFIG)).not.toThrow();

    expect(() => new TwitterChannel({ ...VALID_CONFIG, apiKey: '' })).toThrow(
      'Twitter adapter requires apiKey, apiSecret, accessToken, and accessTokenSecret',
    );
    expect(() => new TwitterChannel({ ...VALID_CONFIG, apiSecret: '' })).toThrow();
    expect(() => new TwitterChannel({ ...VALID_CONFIG, accessToken: '' })).toThrow();
    expect(() => new TwitterChannel({ ...VALID_CONFIG, accessTokenSecret: '' })).toThrow();
  });

  it('posts to the correct Twitter v2 endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'tweet_123', text: 'Hello!' } }),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await channel.post('Hello world!');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.twitter.com/2/tweets');
  });

  it('builds OAuth 1.0a Authorization header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'tweet_456', text: 'Test' } }),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await channel.post('Test tweet');

    const options = mockFetch.mock.calls[0][1];
    const authHeader = options.headers['Authorization'] as string;

    expect(authHeader).toMatch(/^OAuth /);
    expect(authHeader).toContain('oauth_consumer_key=');
    expect(authHeader).toContain('oauth_nonce=');
    expect(authHeader).toContain('oauth_signature=');
    expect(authHeader).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(authHeader).toContain('oauth_timestamp=');
    expect(authHeader).toContain('oauth_token=');
    expect(authHeader).toContain('oauth_version="1.0"');
  });

  it('sends tweet text in request body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'tweet_789', text: 'My tweet' } }),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await channel.post('My tweet');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('My tweet');
  });

  it('returns postId from response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'tweet_abc', text: 'Posted' } }),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    const result = await channel.post('Posted');

    expect(result.postId).toBe('tweet_abc');
  });

  it('handles rate limiting (429)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'x-rate-limit-reset': '1234567890' }),
      text: () => Promise.resolve('Rate limited'),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await expect(channel.post('Test')).rejects.toThrow('Twitter rate limited');
  });

  it('handles non-OK responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await expect(channel.post('Test')).rejects.toThrow('Twitter API failed (403)');
  });

  it('handles Twitter API errors in response body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          errors: [{ message: 'Duplicate content' }],
        }),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await expect(channel.post('Test')).rejects.toThrow('Twitter API errors: Duplicate content');
  });

  it('throws when response has no tweet ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await expect(channel.post('Test')).rejects.toThrow('Twitter API returned no tweet ID');
  });

  it('truncates long tweets and appends referral link', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'tweet_trunc', text: 'Truncated' } }),
    } as unknown as Response);

    const longContent = 'A'.repeat(300);
    const channel = new TwitterChannel(VALID_CONFIG);
    await channel.post(longContent, 'https://endgame.cash?ref=test');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Total should be <= 280 chars
    expect(body.text.length).toBeLessThanOrEqual(280);
    expect(body.text).toContain('https://endgame.cash?ref=test');
  });

  it('passes an AbortSignal for timeout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'tweet_sig', text: 'Test' } }),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await channel.post('Test');

    const options = mockFetch.mock.calls[0][1];
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

// ── Delete Method Tests ──────────────────────────────────────────────

describe('DiscordChannel.delete', () => {
  const VALID_WEBHOOK = 'https://discord.com/api/webhooks/123456/abcdef';

  it('sends DELETE to webhook/messages/{postId}', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    await channel.delete('msg_123');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${VALID_WEBHOOK}/messages/msg_123`);
    expect(options.method).toBe('DELETE');
  });

  it('throws on non-OK delete response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Unknown Message'),
    } as unknown as Response);

    const channel = new DiscordChannel(VALID_WEBHOOK);
    await expect(channel.delete('bad_id')).rejects.toThrow('Discord delete failed (404)');
  });
});

describe('TelegramChannel.delete', () => {
  const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
  const CHAT_ID = '-1001234567890';

  it('sends deleteMessage request with correct payload', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await channel.delete('42');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.message_id).toBe(42);
  });

  it('throws on non-OK delete response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await expect(channel.delete('99')).rejects.toThrow('Telegram delete failed (400)');
  });

  it('throws on Telegram API error (ok: false)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'message to delete not found' }),
    } as unknown as Response);

    const channel = new TelegramChannel(BOT_TOKEN, CHAT_ID);
    await expect(channel.delete('999')).rejects.toThrow('Telegram delete error: message to delete not found');
  });
});

describe('TwitterChannel.delete', () => {
  const VALID_CONFIG = {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    accessToken: 'test-access-token',
    accessTokenSecret: 'test-access-token-secret',
  };

  it('sends DELETE to correct tweet endpoint with OAuth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await channel.delete('tweet_123');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.twitter.com/2/tweets/tweet_123');
    expect(options.method).toBe('DELETE');
    expect(options.headers['Authorization']).toMatch(/^OAuth /);
  });

  it('throws on non-OK delete response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    } as unknown as Response);

    const channel = new TwitterChannel(VALID_CONFIG);
    await expect(channel.delete('tweet_bad')).rejects.toThrow('Twitter delete failed (403)');
  });
});
