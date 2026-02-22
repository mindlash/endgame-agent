/**
 * Agent configuration loaded from .env and setup wizard.
 * All secrets are read once at startup and never logged.
 */

export interface AgentConfig {
  // Wallet
  walletAddress: string;

  // Claim settings
  claimEnabled: boolean;
  claimRetryAttempts: number;
  claimRetryDelayMs: number;

  // Marketing
  marketingEnabled: boolean;
  marketingChannels: ('twitter' | 'discord' | 'telegram')[];
  referralCode: string;
  postsPerDay: number;

  // LLM
  llmProvider: 'claude' | 'openai';
  llmApiKey: string;
  llmModel?: string;

  // API
  apiBaseUrl: string;
  apiTimeoutMs: number;

  // Security
  encryptedKeyPath: string;
}

export interface ChannelCredentials {
  twitter?: { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string };
  discord?: { webhookUrl: string };
  telegram?: { botToken: string; chatId: string };
}

export interface SecureConfig {
  // Never persisted, never logged — lives only in the signing subprocess
  privateKey: Uint8Array;
}

// ── Env helpers ────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function env(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function parseChannels(str: string): ('twitter' | 'discord' | 'telegram')[] {
  if (!str.trim()) return [];
  const valid = new Set(['twitter', 'discord', 'telegram']);
  return str
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is 'twitter' | 'discord' | 'telegram' => valid.has(s));
}

// ── Loaders ────────────────────────────────────────────────────────

export function loadConfig(): AgentConfig {
  return {
    walletAddress: requireEnv('WALLET_ADDRESS'),
    claimEnabled: env('CLAIM_ENABLED', 'true') === 'true',
    claimRetryAttempts: parseInt(env('CLAIM_RETRY_ATTEMPTS', '5')),
    claimRetryDelayMs: parseInt(env('CLAIM_RETRY_DELAY_MS', '2000')),
    marketingEnabled: env('MARKETING_ENABLED', 'true') === 'true',
    marketingChannels: parseChannels(env('MARKETING_CHANNELS', '')),
    referralCode: env('REFERRAL_CODE', ''),
    postsPerDay: parseInt(env('POSTS_PER_DAY', '4')),
    llmProvider: env('LLM_PROVIDER', 'claude') as 'claude' | 'openai',
    llmApiKey: env('LLM_API_KEY', ''),
    llmModel: process.env['LLM_MODEL'],
    apiBaseUrl: env('API_BASE_URL', 'https://endgame.cash'),
    apiTimeoutMs: parseInt(env('API_TIMEOUT_MS', '15000')),
    encryptedKeyPath: env('KEYFILE_PATH', '.agent-data/keyfile.json'),
  };
}

export function loadChannelCredentials(): ChannelCredentials {
  const creds: ChannelCredentials = {};

  if (process.env['TWITTER_API_KEY']) {
    creds.twitter = {
      apiKey: requireEnv('TWITTER_API_KEY'),
      apiSecret: requireEnv('TWITTER_API_SECRET'),
      accessToken: requireEnv('TWITTER_ACCESS_TOKEN'),
      accessTokenSecret: requireEnv('TWITTER_ACCESS_TOKEN_SECRET'),
    };
  }

  if (process.env['DISCORD_WEBHOOK_URL']) {
    creds.discord = { webhookUrl: requireEnv('DISCORD_WEBHOOK_URL') };
  }

  if (process.env['TELEGRAM_BOT_TOKEN']) {
    creds.telegram = {
      botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
    };
  }

  return creds;
}
