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

import { createLogger } from './core/logger.js';

const log = createLogger('main');

async function main(): Promise<void> {
  log.info('EndGame Agent starting');

  // TODO: Implementation
  // 1. Load config from .env / config file
  // 2. Spawn signer subprocess, send unlock message
  // 3. Initialize API client
  // 4. Start round monitor (claim module)
  // 5. Start marketing scheduler (if enabled)
  // 6. Handle graceful shutdown (SIGTERM, SIGINT)

  log.info('Agent ready — monitoring for rounds');
}

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('Shutting down (SIGINT)');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('Shutting down (SIGTERM)');
  process.exit(0);
});

main().catch((err) => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
