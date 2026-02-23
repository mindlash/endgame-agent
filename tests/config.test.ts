/**
 * Tests for configuration loading from environment variables.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { loadConfig, loadChannelCredentials, resolveHome, resolveDataDir, resolveConfigDir } from '../src/core/config.js';

// Save original env to restore after each test
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
});

// ── loadConfig ─────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('reads env vars correctly', () => {
    process.env['WALLET_ADDRESS'] = 'TestWalletAddress123';
    process.env['CLAIM_ENABLED'] = 'false';
    process.env['CLAIM_RETRY_ATTEMPTS'] = '10';
    process.env['CLAIM_RETRY_DELAY_MS'] = '5000';
    process.env['MARKETING_ENABLED'] = 'false';
    process.env['MARKETING_CHANNELS'] = 'twitter,discord';
    process.env['REFERRAL_CODE'] = 'myref';
    process.env['POSTS_PER_DAY'] = '8';
    process.env['LLM_PROVIDER'] = 'openai';
    process.env['LLM_API_KEY'] = 'sk-test-key';
    process.env['LLM_MODEL'] = 'gpt-4o';
    process.env['API_BASE_URL'] = 'https://custom.api.url';
    process.env['API_TIMEOUT_MS'] = '30000';
    process.env['SOLANA_RPC_URL'] = 'https://my-rpc.example.com';
    process.env['KEYFILE_PATH'] = '/custom/path/keyfile.json';

    const config = loadConfig();

    expect(config.walletAddress).toBe('TestWalletAddress123');
    expect(config.claimEnabled).toBe(false);
    expect(config.claimRetryAttempts).toBe(10);
    expect(config.claimRetryDelayMs).toBe(5000);
    expect(config.marketingEnabled).toBe(false);
    expect(config.marketingChannels).toEqual(['twitter', 'discord']);
    expect(config.referralCode).toBe('myref');
    expect(config.postsPerDay).toBe(8);
    expect(config.llmProvider).toBe('openai');
    expect(config.llmApiKey).toBe('sk-test-key');
    expect(config.llmModel).toBe('gpt-4o');
    expect(config.apiBaseUrl).toBe('https://custom.api.url');
    expect(config.apiTimeoutMs).toBe(30000);
    expect(config.rpcEndpoint).toBe('https://my-rpc.example.com');
    expect(config.encryptedKeyPath).toBe('/custom/path/keyfile.json');
  });

  it('uses defaults when env vars missing', () => {
    // Only the required var
    process.env['WALLET_ADDRESS'] = 'SomeWallet';
    // Clear all optional vars
    delete process.env['CLAIM_ENABLED'];
    delete process.env['CLAIM_RETRY_ATTEMPTS'];
    delete process.env['CLAIM_RETRY_DELAY_MS'];
    delete process.env['MARKETING_ENABLED'];
    delete process.env['MARKETING_CHANNELS'];
    delete process.env['REFERRAL_CODE'];
    delete process.env['POSTS_PER_DAY'];
    delete process.env['LLM_PROVIDER'];
    delete process.env['LLM_API_KEY'];
    delete process.env['LLM_MODEL'];
    delete process.env['API_BASE_URL'];
    delete process.env['API_TIMEOUT_MS'];
    delete process.env['SOLANA_RPC_URL'];
    delete process.env['KEYFILE_PATH'];

    const config = loadConfig();

    expect(config.walletAddress).toBe('SomeWallet');
    expect(config.claimEnabled).toBe(true);
    expect(config.claimRetryAttempts).toBe(5);
    expect(config.claimRetryDelayMs).toBe(2000);
    expect(config.marketingEnabled).toBe(true);
    expect(config.marketingChannels).toEqual([]);
    expect(config.referralCode).toBe('');
    expect(config.postsPerDay).toBe(4);
    expect(config.llmProvider).toBe('claude');
    expect(config.llmApiKey).toBe('');
    expect(config.llmModel).toBeUndefined();
    expect(config.apiBaseUrl).toBe('https://api.endgame.cash');
    expect(config.apiTimeoutMs).toBe(15000);
    expect(config.encryptedKeyPath).toBe(join(process.cwd(), 'data', 'keyfile.json'));
  });

  it('throws on missing WALLET_ADDRESS', () => {
    delete process.env['WALLET_ADDRESS'];
    expect(() => loadConfig()).toThrow('Missing required env var: WALLET_ADDRESS');
  });
});

// ── loadChannelCredentials ──────────────────────────────────────────

describe('loadChannelCredentials', () => {
  it('loads Twitter credentials when all vars set', () => {
    process.env['WALLET_ADDRESS'] = 'dummy';
    process.env['TWITTER_API_KEY'] = 'tkey';
    process.env['TWITTER_API_SECRET'] = 'tsecret';
    process.env['TWITTER_ACCESS_TOKEN'] = 'tatoken';
    process.env['TWITTER_ACCESS_TOKEN_SECRET'] = 'tatsecret';

    const creds = loadChannelCredentials();
    expect(creds.twitter).toEqual({
      apiKey: 'tkey',
      apiSecret: 'tsecret',
      accessToken: 'tatoken',
      accessTokenSecret: 'tatsecret',
    });
  });

  it('loads Discord credentials when webhook URL set', () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/123/abc';

    const creds = loadChannelCredentials();
    expect(creds.discord).toEqual({
      webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    });
  });

  it('loads Telegram credentials when both vars set', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:ABC-DEF';
    process.env['TELEGRAM_CHAT_ID'] = '-1001234567890';

    const creds = loadChannelCredentials();
    expect(creds.telegram).toEqual({
      botToken: '123456:ABC-DEF',
      chatId: '-1001234567890',
    });
  });

  it('returns empty object when no channel env vars set', () => {
    delete process.env['TWITTER_API_KEY'];
    delete process.env['DISCORD_WEBHOOK_URL'];
    delete process.env['TELEGRAM_BOT_TOKEN'];

    const creds = loadChannelCredentials();
    expect(creds.twitter).toBeUndefined();
    expect(creds.discord).toBeUndefined();
    expect(creds.telegram).toBeUndefined();
  });

  it('loads only the channels that have env vars set', () => {
    delete process.env['TWITTER_API_KEY'];
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/456/xyz';
    delete process.env['TELEGRAM_BOT_TOKEN'];

    const creds = loadChannelCredentials();
    expect(creds.twitter).toBeUndefined();
    expect(creds.discord).toBeDefined();
    expect(creds.telegram).toBeUndefined();
  });
});

// ── parseChannels (tested indirectly via loadConfig) ────────────────

describe('parseChannels (via loadConfig)', () => {
  it('handles comma-separated channel values', () => {
    process.env['WALLET_ADDRESS'] = 'w';
    process.env['MARKETING_CHANNELS'] = 'twitter,discord,telegram';

    const config = loadConfig();
    expect(config.marketingChannels).toEqual(['twitter', 'discord', 'telegram']);
  });

  it('handles whitespace in comma-separated values', () => {
    process.env['WALLET_ADDRESS'] = 'w';
    process.env['MARKETING_CHANNELS'] = ' twitter , discord , telegram ';

    const config = loadConfig();
    expect(config.marketingChannels).toEqual(['twitter', 'discord', 'telegram']);
  });

  it('filters out invalid channel names', () => {
    process.env['WALLET_ADDRESS'] = 'w';
    process.env['MARKETING_CHANNELS'] = 'twitter,invalid,discord,facebook';

    const config = loadConfig();
    expect(config.marketingChannels).toEqual(['twitter', 'discord']);
  });

  it('handles empty string', () => {
    process.env['WALLET_ADDRESS'] = 'w';
    process.env['MARKETING_CHANNELS'] = '';

    const config = loadConfig();
    expect(config.marketingChannels).toEqual([]);
  });

  it('handles single channel', () => {
    process.env['WALLET_ADDRESS'] = 'w';
    process.env['MARKETING_CHANNELS'] = 'telegram';

    const config = loadConfig();
    expect(config.marketingChannels).toEqual(['telegram']);
  });

  it('is case-insensitive', () => {
    process.env['WALLET_ADDRESS'] = 'w';
    process.env['MARKETING_CHANNELS'] = 'Twitter,DISCORD,Telegram';

    const config = loadConfig();
    expect(config.marketingChannels).toEqual(['twitter', 'discord', 'telegram']);
  });
});
