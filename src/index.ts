/**
 * EndGame Agent — self-hosted auto-claim + AI marketing.
 *
 * Entry point: loads config, starts subsystems, runs until interrupted.
 *
 * Process architecture:
 * ┌──────────────────────────────────────────┐
 * │  Main Process                            │
 * │  ┌─────────────┐  ┌──────────────────┐  │
 * │  │ Round       │  │ Marketing        │  │
 * │  │ Monitor     │  │ Engine           │  │
 * │  │ (claim)     │  │ (content gen)    │  │
 * │  └──────┬──────┘  └──────────────────┘  │
 * │         │ IPC only                       │
 * │  ┌──────┴──────┐                         │
 * │  │ Signer      │  ← isolated subprocess  │
 * │  │ (keys)      │  ← no network access    │
 * │  └─────────────┘                         │
 * └──────────────────────────────────────────┘
 */

import 'dotenv/config';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './core/logger.js';
import { loadConfig, loadChannelCredentials, type ChannelCredentials, type AgentConfig } from './core/config.js';
import { EndGameApi } from './api/client.js';
import { RoundMonitor } from './claim/monitor.js';
import { ClaimExecutor } from './claim/executor.js';
import { MarketingScheduler } from './marketing/scheduler.js';
import { DiscordChannel } from './marketing/channels/discord.js';
import { TelegramChannel } from './marketing/channels/telegram.js';
import { TwitterChannel } from './marketing/channels/twitter.js';
import { generatePersonalitySeed, type Personality, type ChannelAdapter } from './marketing/engine.js';

const log = createLogger('main');
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Signer helpers ─────────────────────────────────────────────────

function spawnSigner(): ChildProcess {
  const signerPath = join(__dirname, 'security', 'signer.js');
  return fork(signerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
}

function waitForMessage(proc: ChildProcess, expectedType: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Signer timeout waiting for '${expectedType}'`));
    }, timeoutMs);
    const onMsg = (msg: { type: string; message?: string }) => {
      if (msg.type === expectedType) { cleanup(); resolve(); }
      else if (msg.type === 'error') { cleanup(); reject(new Error(msg.message ?? 'Signer error')); }
    };
    const cleanup = () => { clearTimeout(timer); proc.removeListener('message', onMsg); };
    proc.on('message', onMsg);
  });
}

// ── Channel builder ────────────────────────────────────────────────

function buildChannels(
  creds: ChannelCredentials,
  enabled: AgentConfig['marketingChannels'],
): ChannelAdapter[] {
  const adapters: ChannelAdapter[] = [];
  for (const ch of enabled) {
    if (ch === 'twitter' && creds.twitter) {
      adapters.push(new TwitterChannel(creds.twitter));
    } else if (ch === 'discord' && creds.discord) {
      adapters.push(new DiscordChannel(creds.discord.webhookUrl));
    } else if (ch === 'telegram' && creds.telegram) {
      adapters.push(new TelegramChannel(creds.telegram.botToken, creds.telegram.chatId));
    } else {
      log.warn('Channel enabled but credentials missing', { channel: ch });
    }
  }
  return adapters;
}

// ── Personality loader ─────────────────────────────────────────────

function loadOrCreatePersonality(): Personality {
  const path = join(process.cwd(), '.agent-data', 'personality.json');
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8')) as Personality;
  }
  log.info('No personality found, generating new seed');
  return generatePersonalitySeed();
}

// ── Main ───────────────────────────────────────────────────────────

let monitor: RoundMonitor | null = null;
let scheduler: MarketingScheduler | null = null;
let signerProc: ChildProcess | null = null;

async function main(): Promise<void> {
  log.info('EndGame Agent starting');

  const config = loadConfig();
  const credentials = loadChannelCredentials();
  const api = new EndGameApi(config.apiBaseUrl, config.apiTimeoutMs);

  // Claim subsystem
  if (config.claimEnabled) {
    signerProc = spawnSigner();
    await waitForMessage(signerProc, 'ready');

    const password = process.env['KEYFILE_PASSWORD'];
    if (!password) throw new Error('KEYFILE_PASSWORD env var required for claim mode');

    signerProc.send({ type: 'unlock', password, keyfilePath: config.encryptedKeyPath });
    await waitForMessage(signerProc, 'unlocked');
    log.info('Signer unlocked');

    const executor = new ClaimExecutor(api, config.walletAddress, signerProc);
    monitor = new RoundMonitor(api, config.walletAddress, (roundId, prize, deadline) =>
      executor.claim(roundId, prize, deadline),
    );
    // Run monitor in background (async loop, never awaited here)
    monitor.start().catch(err =>
      log.error('Monitor crashed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  // Marketing subsystem
  if (config.marketingEnabled && config.marketingChannels.length > 0) {
    if (!config.llmApiKey) throw new Error('LLM_API_KEY required when marketing is enabled');

    const channels = buildChannels(credentials, config.marketingChannels);
    if (channels.length === 0) {
      log.warn('Marketing enabled but no channels have valid credentials');
    } else {
      const personality = loadOrCreatePersonality();
      scheduler = new MarketingScheduler(
        api,
        { provider: config.llmProvider, apiKey: config.llmApiKey, model: config.llmModel },
        channels,
        personality,
        config.referralCode,
        config.postsPerDay,
      );
      scheduler.start().catch(err =>
        log.error('Scheduler crashed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  log.info('Agent ready', {
    wallet: config.walletAddress.slice(0, 8) + '...',
    claim: config.claimEnabled,
    marketing: config.marketingEnabled,
    channels: config.marketingChannels,
  });
}

// ── Graceful shutdown ──────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info(`Shutting down (${signal})`);
  monitor?.stop();
  scheduler?.stop();
  if (signerProc) { signerProc.kill(); signerProc = null; }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
