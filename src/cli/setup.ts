/**
 * Interactive CLI setup wizard.
 *
 * Collects credentials, encrypts the private key, writes .env,
 * generates a personality seed, and optionally stores the password
 * in the OS credential store + installs a background service.
 */

import * as readline from 'node:readline';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { encryptKey } from '../security/keystore.js';
import { generatePersonalitySeed } from '../marketing/engine.js';
import { resolveDataDir, resolveConfigDir } from '../core/config.js';
import { isCredentialStoreAvailable, storePassword } from './credentials.js';
import { installService } from './service.js';
import { suppressLogs, unsuppressLogs } from '../core/logger.js';
import type { LlmProvider } from '../marketing/llm.js';

const DATA_DIR = resolveDataDir();
const KEYFILE_PATH = join(DATA_DIR, 'keyfile.json');
const PERSONALITY_PATH = join(DATA_DIR, 'personality.json');

const VALID_LLM_PROVIDERS = new Set<string>(['claude', 'openai', 'gemini', 'groq', 'ollama']);

const LLM_TIMEOUT_MS = 15_000;
const CHANNEL_TIMEOUT_MS = 15_000;

// ── Credential Test Helpers ─────────────────────────────────────────

async function testLlm(provider: LlmProvider, apiKey: string, ollamaBaseUrl?: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    switch (provider) {
      case 'claude': {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 10,
            messages: [{ role: 'user', content: "Say 'OK' in one word" }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return `Claude API ${res.status}: ${await res.text().catch(() => '')}`;
        return null;
      }
      case 'openai': {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 10,
            messages: [{ role: 'user', content: "Say 'OK' in one word" }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return `OpenAI API ${res.status}: ${await res.text().catch(() => '')}`;
        return null;
      }
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: "Say 'OK' in one word" }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
          signal: controller.signal,
        });
        if (!res.ok) return `Gemini API ${res.status}: ${await res.text().catch(() => '')}`;
        return null;
      }
      case 'groq': {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 10,
            messages: [{ role: 'user', content: "Say 'OK' in one word" }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return `Groq API ${res.status}: ${await res.text().catch(() => '')}`;
        return null;
      }
      case 'ollama': {
        const base = ollamaBaseUrl ?? 'http://localhost:11434';
        const res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'llama3.2',
            stream: false,
            messages: [{ role: 'user', content: "Say 'OK' in one word" }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return `Ollama API ${res.status}: ${await res.text().catch(() => '')}`;
        return null;
      }
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
}

async function testTwitter(apiKey: string, apiSecret: string, accessToken: string, accessTokenSecret: string): Promise<string | null> {
  suppressLogs();
  try {
    const { TwitterChannel } = await import('../marketing/channels/twitter.js');
    const channel = new TwitterChannel({ apiKey, apiSecret, accessToken, accessTokenSecret });
    const { postId } = await channel.post('EndGame Agent connected! [test]');
    await channel.delete(postId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    unsuppressLogs();
  }
}

async function testDiscord(webhookUrl: string): Promise<string | null> {
  suppressLogs();
  try {
    const { DiscordChannel } = await import('../marketing/channels/discord.js');
    const channel = new DiscordChannel(webhookUrl);
    const { postId } = await channel.post('EndGame Agent connected! [test]');
    await channel.delete(postId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    unsuppressLogs();
  }
}

async function testTelegram(botToken: string, chatId: string): Promise<string | null> {
  suppressLogs();
  try {
    const { TelegramChannel } = await import('../marketing/channels/telegram.js');
    const channel = new TelegramChannel(botToken, chatId);
    const { postId } = await channel.post('EndGame Agent connected! [test]');
    await channel.delete(postId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    unsuppressLogs();
  }
}

// ── Main Setup ──────────────────────────────────────────────────────

export async function setup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  console.log('\n=== EndGame Agent Setup ===\n');

  mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: Private key (accepts base58 or JSON byte array [1,2,3,...])
  const privateKeyInput = await ask('Paste your Solana private key (base58 or [byte,array]): ');
  const password = await ask('Choose encryption password for keyfile: ');

  // Decode and encrypt immediately
  const bs58 = (await import('bs58')).default;
  const nacl = await import('tweetnacl');
  let keyBytes: Uint8Array;
  const trimmed = privateKeyInput.trim();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    // JSON byte array format: [1,2,3,...,255]
    try {
      const numbers: number[] = JSON.parse(trimmed);
      if (!Array.isArray(numbers) || numbers.length === 0 || numbers.some(n => typeof n !== 'number' || n < 0 || n > 255 || !Number.isInteger(n))) {
        throw new Error('Invalid byte values');
      }
      keyBytes = Uint8Array.from(numbers);
    } catch {
      console.error('ERROR: Invalid byte array. Expected format: [1,2,3,...,255]');
      rl.close();
      process.exit(1);
    }
  } else {
    // Base58 format
    try {
      keyBytes = bs58.decode(trimmed);
    } catch {
      console.error('ERROR: Invalid private key. Use base58 string or byte array [1,2,3,...].');
      rl.close();
      process.exit(1);
    }
  }

  // Derive wallet address from key (ed25519 keypair is 64 bytes: secret+public)
  const keypair = keyBytes.length === 64
    ? keyBytes
    : nacl.sign.keyPair.fromSeed(keyBytes.slice(0, 32)).secretKey;
  const publicKey = keypair.slice(32, 64);
  const walletAddress = bs58.encode(publicKey);

  // Encrypt and save keyfile with restrictive permissions
  const keyfile = await encryptKey(keypair, password);
  writeFileSync(KEYFILE_PATH, JSON.stringify(keyfile, null, 2) + '\n');
  chmodSync(KEYFILE_PATH, 0o600);
  console.log(`Keyfile saved to ${KEYFILE_PATH}`);

  // Wipe sensitive data from scope
  keyBytes.fill(0);
  keypair.fill(0);

  // Step 2: Credential store (macOS Keychain / Windows Credential Manager)
  if (isCredentialStoreAvailable()) {
    const useKeychain = (await ask('Store password in system keychain for auto-start? (y/n): ')).trim().toLowerCase();
    if (useKeychain === 'y') {
      suppressLogs();
      const stored = storePassword(password);
      unsuppressLogs();
      if (stored) {
        console.log('Password stored securely in system credential store.');
      } else {
        console.log('Failed to store password. You will need to provide it manually.');
      }
    }
  }

  // Step 3: Referral code
  const referralCode = await ask('Your EndGame referral code (optional, press Enter to skip): ');

  // Step 4: LLM provider
  console.log(`
=== LLM Provider ===
The marketing engine needs an LLM to generate posts.

  claude  — Best quality. ~$3/MTok. Get key: https://console.anthropic.com/settings/keys
  openai  — Good quality. ~$0.15/MTok. Get key: https://platform.openai.com/api-keys
  gemini  — FREE (15 req/min). Get key: https://aistudio.google.com/apikeys
  groq    — FREE (30 req/min, open models). Get key: https://console.groq.com/keys
  ollama  — FREE, runs locally. Install: https://ollama.com then: ollama pull llama3.2
`);

  let llmProvider = '';
  while (!VALID_LLM_PROVIDERS.has(llmProvider)) {
    llmProvider = (await ask('LLM provider (claude/openai/gemini/groq/ollama): ')).trim().toLowerCase();
  }

  let llmApiKey = '';
  let ollamaBaseUrl = '';
  if (llmProvider === 'ollama') {
    ollamaBaseUrl = (await ask('Ollama base URL (press Enter for http://localhost:11434): ')).trim() || 'http://localhost:11434';
  } else {
    llmApiKey = await ask(`${llmProvider} API key: `);
  }
  const llmModel = await ask('Model override (press Enter for default): ');

  // Test LLM connection
  const testLlmChoice = (await ask('Test LLM connection? (y/n): ')).trim().toLowerCase();
  if (testLlmChoice === 'y') {
    process.stdout.write('  Testing...');
    const err = await testLlm(llmProvider as LlmProvider, llmApiKey, ollamaBaseUrl || undefined);
    if (err) {
      console.log(` FAILED\n  Error: ${err}`);
      const retry = (await ask('  Re-enter credentials? (y/n): ')).trim().toLowerCase();
      if (retry === 'y') {
        if (llmProvider === 'ollama') {
          ollamaBaseUrl = (await ask('  Ollama base URL: ')).trim() || 'http://localhost:11434';
        } else {
          llmApiKey = await ask(`  ${llmProvider} API key: `);
        }
      }
    } else {
      console.log(' OK');
    }
  }

  // Step 5: Marketing channels
  const enabledChannels: string[] = [];
  const envLines: string[] = [
    `# EndGame Agent config — generated by setup wizard`,
    `WALLET_ADDRESS=${walletAddress}`,
    `KEYFILE_PATH=${KEYFILE_PATH}`,
    `# SECURITY: Password stored in system keychain (or provide at runtime):`,
    `#   KEYFILE_PASSWORD=yourpassword npm start`,
    ``,
    `CLAIM_ENABLED=true`,
    `MARKETING_ENABLED=true`,
    ``,
    `LLM_PROVIDER=${llmProvider}`,
  ];
  if (llmProvider !== 'ollama') {
    envLines.push(`LLM_API_KEY=${llmApiKey}`);
  } else {
    envLines.push(`OLLAMA_BASE_URL=${ollamaBaseUrl}`);
  }
  if (llmModel.trim()) envLines.push(`LLM_MODEL=${llmModel.trim()}`);
  if (referralCode.trim()) envLines.push(`REFERRAL_CODE=${referralCode.trim()}`);
  envLines.push('');

  // Twitter (optional)
  console.log(`
=== Twitter/X (Optional) ===
Requires a paid Basic tier dev account ($5/month at developer.x.com).

  1. Sign up at https://developer.x.com -> subscribe to the Basic plan

  2. Developer Portal -> Projects & Apps -> Create a new Project + App
     - Project name: anything (e.g. "EndGame Agent")
     - Use case: choose anything (e.g. "Making a bot")
     - App name: anything unique (e.g. "endgame-agent-yourname")

  3. IMPORTANT — Set up "User authentication settings" BEFORE generating tokens:
     App Settings -> scroll to "User authentication settings" -> "Set up"
     - App permissions:  "Read and Write"
     - Type of App:      "Web App, Automated App or Bot"
     - Callback URL:     https://example.com  (required but we don't use it)
     - Website URL:      https://endgame.cash  (required, any URL works)
     -> Save
     ** It will show a "Client ID" and "Client Secret" — IGNORE THESE. **
     ** Those are OAuth 2.0 keys we don't use. Just close/dismiss that dialog. **

  4. Go to "Keys and tokens" tab (this is where YOUR keys are):
     a. Under "Consumer Keys" -> "Regenerate" -> copy both values:
        "API Key"        = what we call "API Key" below
        "API Key Secret" = what we call "API Key Secret" below
        (shown only once — save them!)
     b. Under "Authentication Tokens" -> "Generate" -> copy both values:
        "Access Token"        = what we call "Access Token" below
        "Access Token Secret" = what we call "Access Token Secret" below
        (also shown only once — save them!)

  Common mistakes:
  - Generating tokens BEFORE setting "Read and Write" = read-only tokens
    Fix: change permissions, then Regenerate both Consumer Keys AND Access Tokens
  - Choosing "Native App" instead of "Web App, Automated App or Bot"
  - Using the Free tier = 401/403 errors (Free tier cannot post tweets)
`);
  const useTwitter = (await ask('Enable Twitter/X? (y/n): ')).trim().toLowerCase();
  if (useTwitter === 'y') {
    let apiKey = await ask('  API Key (from Consumer Keys): ');
    let apiSecret = await ask('  API Key Secret (from Consumer Keys): ');
    let accessToken = await ask('  Access Token (from Authentication Tokens): ');
    let accessTokenSecret = await ask('  Access Token Secret (from Authentication Tokens): ');

    const testChoice = (await ask('  Test Twitter connection? (y/n): ')).trim().toLowerCase();
    if (testChoice === 'y') {
      process.stdout.write('  Testing (post + delete)...');
      const err = await testTwitter(apiKey, apiSecret, accessToken, accessTokenSecret);
      if (err) {
        console.log(` FAILED\n  Error: ${err}`);
        const retry = (await ask('  Re-enter credentials? (y/n): ')).trim().toLowerCase();
        if (retry === 'y') {
          apiKey = await ask('  API Key: ');
          apiSecret = await ask('  API Key Secret: ');
          accessToken = await ask('  Access Token: ');
          accessTokenSecret = await ask('  Access Token Secret: ');
        }
      } else {
        console.log(' OK');
      }
    }

    envLines.push(`TWITTER_API_KEY=${apiKey}`);
    envLines.push(`TWITTER_API_SECRET=${apiSecret}`);
    envLines.push(`TWITTER_ACCESS_TOKEN=${accessToken}`);
    envLines.push(`TWITTER_ACCESS_TOKEN_SECRET=${accessTokenSecret}`);
    enabledChannels.push('twitter');
  }

  // Discord (optional)
  console.log(`
=== Discord (Optional, FREE) ===

  1. Open Discord -> go to your server
  2. Right-click channel -> Edit Channel -> Integrations -> Webhooks
  3. Click "New Webhook" -> copy the URL
`);
  const useDiscord = (await ask('Enable Discord? (y/n): ')).trim().toLowerCase();
  if (useDiscord === 'y') {
    let webhookUrl = await ask('  Discord Webhook URL: ');

    const testChoice = (await ask('  Test Discord connection? (y/n): ')).trim().toLowerCase();
    if (testChoice === 'y') {
      process.stdout.write('  Testing (post + delete)...');
      const err = await testDiscord(webhookUrl);
      if (err) {
        console.log(` FAILED\n  Error: ${err}`);
        const retry = (await ask('  Re-enter webhook URL? (y/n): ')).trim().toLowerCase();
        if (retry === 'y') {
          webhookUrl = await ask('  Discord Webhook URL: ');
        }
      } else {
        console.log(' OK');
      }
    }

    envLines.push(`DISCORD_WEBHOOK_URL=${webhookUrl}`);
    enabledChannels.push('discord');
  }

  // Telegram (optional)
  console.log(`
=== Telegram (Optional, FREE) ===

  1. Open Telegram, search for @BotFather, send /newbot
  2. Follow prompts to name it, copy the bot token
  3. Add the bot to your channel/group as admin
  4. For Chat ID: send a message in the chat, then visit:
     https://api.telegram.org/bot<TOKEN>/getUpdates
     Look for "chat":{"id": NUMBER}
`);
  const useTelegram = (await ask('Enable Telegram? (y/n): ')).trim().toLowerCase();
  if (useTelegram === 'y') {
    let botToken = await ask('  Telegram Bot Token (from @BotFather): ');
    let chatId = await ask('  Telegram Chat/Channel ID: ');

    const testChoice = (await ask('  Test Telegram connection? (y/n): ')).trim().toLowerCase();
    if (testChoice === 'y') {
      process.stdout.write('  Testing (post + delete)...');
      const err = await testTelegram(botToken, chatId);
      if (err) {
        console.log(` FAILED\n  Error: ${err}`);
        const retry = (await ask('  Re-enter credentials? (y/n): ')).trim().toLowerCase();
        if (retry === 'y') {
          botToken = await ask('  Telegram Bot Token: ');
          chatId = await ask('  Telegram Chat/Channel ID: ');
        }
      } else {
        console.log(' OK');
      }
    }

    envLines.push(`TELEGRAM_BOT_TOKEN=${botToken}`);
    envLines.push(`TELEGRAM_CHAT_ID=${chatId}`);
    enabledChannels.push('telegram');
  }

  if (enabledChannels.length > 0) {
    envLines.push(`MARKETING_CHANNELS=${enabledChannels.join(',')}`);
  } else {
    envLines.push('MARKETING_ENABLED=false');
  }

  if (enabledChannels.length > 0) {
    console.log(`\nMarketing: 4 posts/day (~every 6 hours, randomized +/-15min)`);
    console.log(`Change later in config: POSTS_PER_DAY=8`);
  }

  // Write .env with restrictive permissions (0600 = owner read/write only)
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });
  const envPath = join(configDir, '.env');
  writeFileSync(envPath, envLines.join('\n') + '\n');
  chmodSync(envPath, 0o600);
  console.log(`Config written to ${envPath}`);

  // Generate personality seed
  const personality = generatePersonalitySeed();
  writeFileSync(PERSONALITY_PATH, JSON.stringify(personality, null, 2) + '\n');
  console.log(`Personality "${personality.name}" saved to ${PERSONALITY_PATH}`);

  // Step 6: Background service
  const installBg = (await ask('Install as background service (starts on login)? (y/n): ')).trim().toLowerCase();
  if (installBg === 'y') {
    let useCaffeinate = false;
    if (platform() === 'darwin') {
      const preventSleep = (await ask('Prevent sleep while agent runs (caffeinate)? (y/n): ')).trim().toLowerCase();
      useCaffeinate = preventSleep === 'y';
    }
    try {
      suppressLogs();
      installService({ useCaffeinate });
      unsuppressLogs();
      console.log('Background service installed. It will start on next login.');
      console.log('Start now with: endgame-agent start');
    } catch (err) {
      unsuppressLogs();
      console.log(`Service install failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log('You can start the agent manually with: endgame-agent run');
    }
  }

  console.log(`\nWallet: ${walletAddress}`);
  console.log(`Channels: ${enabledChannels.join(', ') || 'none'}`);
  console.log('\nSetup complete!');
  if (installBg !== 'y') {
    console.log('Start with: endgame-agent start  (or: KEYFILE_PASSWORD=yourpassword endgame-agent run)\n');
  }
  rl.close();
}

// ── Per-section reconfiguration ──────────────────────────────────

const VALID_SECTIONS = new Set(['twitter', 'discord', 'telegram', 'llm']);

function loadEnvFile(): Map<string, string> {
  const envPath = join(resolveConfigDir(), '.env');
  if (!existsSync(envPath)) return new Map();
  const content = readFileSync(envPath, 'utf-8');
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    map.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
  }
  return map;
}

function updateEnvFile(updates: Record<string, string>, removals?: string[]): void {
  const map = loadEnvFile();

  // Apply updates
  for (const [key, value] of Object.entries(updates)) {
    map.set(key, value);
  }

  // Apply removals
  if (removals) {
    for (const key of removals) {
      map.delete(key);
    }
  }

  // Rebuild MARKETING_CHANNELS from which channel vars exist
  const channels: string[] = [];
  if (map.has('TWITTER_API_KEY') && map.has('TWITTER_API_SECRET') &&
      map.has('TWITTER_ACCESS_TOKEN') && map.has('TWITTER_ACCESS_TOKEN_SECRET')) {
    channels.push('twitter');
  }
  if (map.has('DISCORD_WEBHOOK_URL')) {
    channels.push('discord');
  }
  if (map.has('TELEGRAM_BOT_TOKEN') && map.has('TELEGRAM_CHAT_ID')) {
    channels.push('telegram');
  }

  if (channels.length > 0) {
    map.set('MARKETING_ENABLED', 'true');
    map.set('MARKETING_CHANNELS', channels.join(','));
  } else {
    map.set('MARKETING_ENABLED', 'false');
    map.delete('MARKETING_CHANNELS');
  }

  // Write back
  const lines: string[] = [];
  for (const [key, value] of map) {
    lines.push(`${key}=${value}`);
  }
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });
  const envPath = join(configDir, '.env');
  writeFileSync(envPath, lines.join('\n') + '\n');
  chmodSync(envPath, 0o600);
}

async function setupTwitterSection(ask: (q: string) => Promise<string>): Promise<void> {
  console.log(`
=== Reconfigure Twitter/X ===
Requires a paid Basic tier dev account ($5/month at developer.x.com).

  1. Sign up at https://developer.x.com -> subscribe to the Basic plan

  2. Developer Portal -> Projects & Apps -> Create a new Project + App

  3. IMPORTANT — Set "User authentication settings" to "Read and Write"
     App permissions: "Read and Write" / Type: "Web App, Automated App or Bot"

  4. Go to "Keys and tokens" tab:
     a. Consumer Keys -> Regenerate -> copy "API Key" + "API Key Secret"
     b. Authentication Tokens -> Generate -> copy "Access Token" + "Access Token Secret"

  Common mistakes:
  - Generating tokens BEFORE setting "Read and Write" = read-only tokens
  - Using the Free tier = 401/403 errors (Free tier cannot post tweets)
`);
  let apiKey = await ask('  API Key (from Consumer Keys): ');
  let apiSecret = await ask('  API Key Secret (from Consumer Keys): ');
  let accessToken = await ask('  Access Token (from Authentication Tokens): ');
  let accessTokenSecret = await ask('  Access Token Secret (from Authentication Tokens): ');

  const testChoice = (await ask('  Test Twitter connection? (y/n): ')).trim().toLowerCase();
  if (testChoice === 'y') {
    process.stdout.write('  Testing (post + delete)...');
    const err = await testTwitter(apiKey, apiSecret, accessToken, accessTokenSecret);
    if (err) {
      console.log(` FAILED\n  Error: ${err}`);
      const retry = (await ask('  Re-enter credentials? (y/n): ')).trim().toLowerCase();
      if (retry === 'y') {
        apiKey = await ask('  API Key: ');
        apiSecret = await ask('  API Key Secret: ');
        accessToken = await ask('  Access Token: ');
        accessTokenSecret = await ask('  Access Token Secret: ');
      }
    } else {
      console.log(' OK');
    }
  }

  updateEnvFile({
    TWITTER_API_KEY: apiKey,
    TWITTER_API_SECRET: apiSecret,
    TWITTER_ACCESS_TOKEN: accessToken,
    TWITTER_ACCESS_TOKEN_SECRET: accessTokenSecret,
  });
  console.log('Twitter configuration updated.');
}

async function setupDiscordSection(ask: (q: string) => Promise<string>): Promise<void> {
  console.log(`
=== Reconfigure Discord ===

  1. Open Discord -> go to your server
  2. Right-click channel -> Edit Channel -> Integrations -> Webhooks
  3. Click "New Webhook" -> copy the URL
`);
  let webhookUrl = await ask('  Discord Webhook URL: ');

  const testChoice = (await ask('  Test Discord connection? (y/n): ')).trim().toLowerCase();
  if (testChoice === 'y') {
    process.stdout.write('  Testing (post + delete)...');
    const err = await testDiscord(webhookUrl);
    if (err) {
      console.log(` FAILED\n  Error: ${err}`);
      const retry = (await ask('  Re-enter webhook URL? (y/n): ')).trim().toLowerCase();
      if (retry === 'y') {
        webhookUrl = await ask('  Discord Webhook URL: ');
      }
    } else {
      console.log(' OK');
    }
  }

  updateEnvFile({ DISCORD_WEBHOOK_URL: webhookUrl });
  console.log('Discord configuration updated.');
}

async function setupTelegramSection(ask: (q: string) => Promise<string>): Promise<void> {
  console.log(`
=== Reconfigure Telegram ===

  1. Open Telegram, search for @BotFather, send /newbot
  2. Follow prompts to name it, copy the bot token
  3. Add the bot to your channel/group as admin
  4. For Chat ID: send a message in the chat, then visit:
     https://api.telegram.org/bot<TOKEN>/getUpdates
     Look for "chat":{"id": NUMBER}
`);
  let botToken = await ask('  Telegram Bot Token (from @BotFather): ');
  let chatId = await ask('  Telegram Chat/Channel ID: ');

  const testChoice = (await ask('  Test Telegram connection? (y/n): ')).trim().toLowerCase();
  if (testChoice === 'y') {
    process.stdout.write('  Testing (post + delete)...');
    const err = await testTelegram(botToken, chatId);
    if (err) {
      console.log(` FAILED\n  Error: ${err}`);
      const retry = (await ask('  Re-enter credentials? (y/n): ')).trim().toLowerCase();
      if (retry === 'y') {
        botToken = await ask('  Telegram Bot Token: ');
        chatId = await ask('  Telegram Chat/Channel ID: ');
      }
    } else {
      console.log(' OK');
    }
  }

  updateEnvFile({
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_CHAT_ID: chatId,
  });
  console.log('Telegram configuration updated.');
}

async function setupLlmSection(ask: (q: string) => Promise<string>): Promise<void> {
  console.log(`
=== Reconfigure LLM Provider ===

  claude  — Best quality. ~$3/MTok. Get key: https://console.anthropic.com/settings/keys
  openai  — Good quality. ~$0.15/MTok. Get key: https://platform.openai.com/api-keys
  gemini  — FREE (15 req/min). Get key: https://aistudio.google.com/apikeys
  groq    — FREE (30 req/min, open models). Get key: https://console.groq.com/keys
  ollama  — FREE, runs locally. Install: https://ollama.com then: ollama pull llama3.2
`);

  let llmProvider = '';
  while (!VALID_LLM_PROVIDERS.has(llmProvider)) {
    llmProvider = (await ask('LLM provider (claude/openai/gemini/groq/ollama): ')).trim().toLowerCase();
  }

  let llmApiKey = '';
  let ollamaBaseUrl = '';
  if (llmProvider === 'ollama') {
    ollamaBaseUrl = (await ask('Ollama base URL (press Enter for http://localhost:11434): ')).trim() || 'http://localhost:11434';
  } else {
    llmApiKey = await ask(`${llmProvider} API key: `);
  }

  const testChoice = (await ask('Test LLM connection? (y/n): ')).trim().toLowerCase();
  if (testChoice === 'y') {
    process.stdout.write('  Testing...');
    const err = await testLlm(llmProvider as LlmProvider, llmApiKey, ollamaBaseUrl || undefined);
    if (err) {
      console.log(` FAILED\n  Error: ${err}`);
      const retry = (await ask('  Re-enter credentials? (y/n): ')).trim().toLowerCase();
      if (retry === 'y') {
        if (llmProvider === 'ollama') {
          ollamaBaseUrl = (await ask('  Ollama base URL: ')).trim() || 'http://localhost:11434';
        } else {
          llmApiKey = await ask(`  ${llmProvider} API key: `);
        }
      }
    } else {
      console.log(' OK');
    }
  }

  const updates: Record<string, string> = { LLM_PROVIDER: llmProvider };
  const removals: string[] = [];

  if (llmProvider === 'ollama') {
    updates['OLLAMA_BASE_URL'] = ollamaBaseUrl;
    removals.push('LLM_API_KEY');
  } else {
    updates['LLM_API_KEY'] = llmApiKey;
    removals.push('OLLAMA_BASE_URL');
  }

  updateEnvFile(updates, removals);
  console.log('LLM configuration updated.');
}

export async function setupSection(section: string): Promise<void> {
  if (!VALID_SECTIONS.has(section)) {
    console.error(`Unknown section: ${section}`);
    console.log(`Valid sections: ${[...VALID_SECTIONS].join(', ')}`);
    process.exit(1);
  }

  const envPath = join(resolveConfigDir(), '.env');
  if (!existsSync(envPath)) {
    console.error('No existing config found. Run full setup first: endgame-agent setup');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    switch (section) {
      case 'twitter':  await setupTwitterSection(ask); break;
      case 'discord':  await setupDiscordSection(ask); break;
      case 'telegram': await setupTelegramSection(ask); break;
      case 'llm':      await setupLlmSection(ask); break;
    }

    const channels = loadEnvFile().get('MARKETING_CHANNELS') ?? 'none';
    console.log(`\nChannels: ${channels}`);

    const { getStatus, stopService, startService } = await import('./service.js');
    const status = getStatus();
    if (status.running) {
      const restart = (await ask('Agent is running. Restart now to apply changes? (y/n): ')).trim().toLowerCase();
      if (restart === 'y') {
        stopService();
        await new Promise(r => setTimeout(r, 2000));
        startService();
        console.log('Agent restarted with new config.');
      } else {
        console.log('Done! Restart the agent later to apply changes.');
      }
    } else {
      console.log('Done! Start the agent with: endgame-agent start');
    }
  } finally {
    rl.close();
  }
}
