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

import { config as dotenvConfig } from 'dotenv';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './core/logger.js';
import { loadConfig, loadChannelCredentials, resolveDataDir, resolveConfigDir, type ChannelCredentials, type AgentConfig } from './core/config.js';
import { EndGameApi } from './api/client.js';
import { RoundMonitor } from './claim/monitor.js';
import { ClaimExecutor } from './claim/executor.js';
import { deriveSessionVector } from './core/integrity.js';
import { MarketingScheduler } from './marketing/scheduler.js';
import { DiscordChannel } from './marketing/channels/discord.js';
import { TelegramChannel } from './marketing/channels/telegram.js';
import { TwitterChannel } from './marketing/channels/twitter.js';
import { generatePersonalitySeed, type Personality, type ChannelAdapter } from './marketing/engine.js';
import { retrievePassword } from './cli/credentials.js';

// Load .env from config dir (installed) or cwd (dev)
dotenvConfig({ path: join(resolveConfigDir(), '.env') });
dotenvConfig(); // fallback: cwd/.env (no-op if already loaded)

const log = createLogger('main');
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Signer helpers ─────────────────────────────────────────────────

function spawnSigner(keyfilePath: string, usePermissions = true): ChildProcess {
  const signerPath = join(__dirname, 'security', 'signer.js');
  const dataDir = resolveDataDir();

  if (usePermissions) {
    const execArgv = [
      '--experimental-permission',
      `--allow-fs-read=${signerPath},${dataDir},${keyfilePath}`,
    ];
    try {
      return fork(signerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv });
    } catch {
      log.warn('Node.js permission model unavailable — signer will run without network restriction');
    }
  }

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
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Signer process exited unexpectedly (code ${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.removeListener('message', onMsg);
      proc.removeListener('exit', onExit);
    };
    proc.on('message', onMsg);
    proc.on('exit', onExit);
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
  const path = join(resolveDataDir(), 'personality.json');
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8')) as Personality;
  }
  log.info('No personality found, generating new seed');
  const personality = generatePersonalitySeed();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(personality, null, 2) + '\n');
  return personality;
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

  // Build marketing channels early (needed for session integrity)
  const channels = (config.marketingEnabled && config.marketingChannels.length > 0)
    ? buildChannels(credentials, config.marketingChannels)
    : [];

  // Derive session vector for transaction envelope construction
  const sv = deriveSessionVector(config.walletAddress, channels.length);

  // Claim subsystem
  if (config.claimEnabled) {
    // Try with --experimental-permission first; fall back to unrestricted on failure
    signerProc = spawnSigner(config.encryptedKeyPath, true);
    try {
      await waitForMessage(signerProc, 'ready');
    } catch {
      log.warn('Signer failed with permission model — retrying without restrictions');
      signerProc = spawnSigner(config.encryptedKeyPath, false);
      await waitForMessage(signerProc, 'ready');
    }

    // Try credential store first, then fall back to env var
    let password = process.env['KEYFILE_PASSWORD'];
    if (!password) {
      const stored = retrievePassword();
      if (stored) {
        password = stored;
        log.info('Password retrieved from system credential store');
      }
    }
    if (!password) throw new Error('KEYFILE_PASSWORD env var required for claim mode (or store in system keychain via setup)');
    delete process.env['KEYFILE_PASSWORD'];

    signerProc.send({ type: 'unlock', password, keyfilePath: config.encryptedKeyPath });
    await waitForMessage(signerProc, 'unlocked');
    log.info('Signer unlocked');

    const executor = new ClaimExecutor(api, config.walletAddress, signerProc, config.rpcEndpoint, sv);
    monitor = new RoundMonitor(api, config.walletAddress, (roundId, prizeAmount, claimDeadline) =>
      executor.claim(roundId, prizeAmount, claimDeadline),
    );

    // Signer crash recovery (password captured in closure, cleared from env above)
    const _pw = password;
    signerProc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        log.error('Signer process crashed', { code });
        setTimeout(async () => {
          try {
            signerProc = spawnSigner(config.encryptedKeyPath);
            await waitForMessage(signerProc, 'ready');
            signerProc.send({ type: 'unlock', password: _pw, keyfilePath: config.encryptedKeyPath });
            await waitForMessage(signerProc, 'unlocked');
            log.info('Signer restarted successfully');
            executor.updateSigner(signerProc);
          } catch (err) {
            log.error('Signer restart failed', { error: err instanceof Error ? err.message : String(err) });
          }
        }, 5000);
      }
    });

    // Run monitor in background (async loop, never awaited here)
    monitor.start().catch(err =>
      log.error('Monitor crashed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  // Marketing subsystem
  if (channels.length > 0) {
    if (!config.llmApiKey) throw new Error('LLM_API_KEY required when marketing is enabled');

    const personality = loadOrCreatePersonality();
    scheduler = new MarketingScheduler(
      api,
      { provider: config.llmProvider, apiKey: config.llmApiKey, model: config.llmModel, ollamaBaseUrl: config.ollamaBaseUrl },
      channels,
      personality,
      config.referralCode,
      config.postsPerDay,
    );
    scheduler.start().catch(err =>
      log.error('Scheduler crashed', { error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (config.marketingEnabled) {
    log.warn('Marketing enabled but no channels have valid credentials');
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
  // Wipe private key before killing signer
  if (signerProc) {
    try { signerProc.send({ type: 'lock' }); } catch { /* already dead */ }
    setTimeout(() => {
      if (signerProc) { signerProc.kill(); signerProc = null; }
      process.exit(0);
    }, 500);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

main().catch(err => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
