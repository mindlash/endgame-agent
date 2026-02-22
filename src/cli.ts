#!/usr/bin/env node

/**
 * CLI entry point for endgame-agent.
 *
 * Usage:
 *   endgame-agent setup   — run the interactive setup wizard
 *   endgame-agent         — start the agent (round monitor + marketing)
 */

if (process.argv[2] === 'setup') {
  await import('./cli/setup.js');
} else {
  await import('./index.js');
}
