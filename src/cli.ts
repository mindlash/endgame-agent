#!/usr/bin/env node

/**
 * CLI entry point for endgame-agent.
 *
 * Usage:
 *   endgame-agent              — start the agent in foreground
 *   endgame-agent run          — start the agent in foreground
 *   endgame-agent setup        — run the interactive setup wizard
 *   endgame-agent status       — health check report
 *   endgame-agent logs         — tail agent logs
 *   endgame-agent start        — start background service
 *   endgame-agent stop         — stop background service
 *   endgame-agent update       — update to latest release
 *   endgame-agent uninstall    — remove everything
 *   endgame-agent validate     — dry-run validation
 */

const command = process.argv[2] ?? 'run';

switch (command) {
  case 'setup': {
    await import('./cli/setup.js');
    break;
  }

  case 'status': {
    const { generateHealthReport, formatHealthReport } = await import('./cli/health.js');
    const report = await generateHealthReport();
    console.log(formatHealthReport(report));
    break;
  }

  case 'logs': {
    const { existsSync } = await import('node:fs');
    const { getLogPath } = await import('./cli/service.js');
    const logPath = getLogPath();
    if (!existsSync(logPath)) {
      console.error(`No log file found at ${logPath}`);
      process.exit(1);
    }
    const { execFileSync } = await import('node:child_process');
    const lines = process.argv[3] ?? '50';
    try {
      if (process.platform === 'win32') {
        execFileSync('powershell', [
          '-NoProfile', '-Command',
          `Get-Content -Path '${logPath}' -Tail ${lines} -Wait`,
        ], { stdio: 'inherit' });
      } else {
        execFileSync('tail', ['-f', '-n', lines, logPath], { stdio: 'inherit' });
      }
    } catch {
      // User pressed Ctrl+C
    }
    break;
  }

  case 'start': {
    const { startService } = await import('./cli/service.js');
    try {
      startService();
      console.log('Agent started. Check status with: endgame-agent status');
    } catch (err) {
      console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  }

  case 'stop': {
    const { stopService } = await import('./cli/service.js');
    stopService();
    console.log('Agent stopped.');
    break;
  }

  case 'update': {
    const { performUpdate } = await import('./cli/update.js');
    try {
      await performUpdate();
    } catch (err) {
      console.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  }

  case 'uninstall': {
    const { uninstall } = await import('./cli/uninstall.js');
    await uninstall();
    break;
  }

  case 'validate': {
    await import('./validate.js');
    break;
  }

  case 'run':
  case undefined: {
    await import('./index.js');
    break;
  }

  default: {
    console.error(`Unknown command: ${command}`);
    console.log(`
Usage: endgame-agent [command]

Commands:
  run          Start agent in foreground (default)
  setup        Interactive setup wizard
  status       Health check report
  logs [n]     Tail agent logs (default: last 50 lines)
  start        Start background service
  stop         Stop background service
  update       Update to latest release
  uninstall    Remove everything
  validate     Dry-run validation
`);
    process.exit(1);
  }
}
