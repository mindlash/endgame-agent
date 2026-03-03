/**
 * Manual-trigger update — pulls latest source from GitHub and rebuilds.
 *
 * data/ and config/ are never touched during updates.
 * No auto-update (red team recommendation).
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from '../core/config.js';
import { stopService, startService, installService, getStatus } from './service.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('update');

const GITHUB_REPO = 'mindlash/endgame-agent';

function getNodePath(): string {
  const home = resolveHome();
  const localNode = join(home, 'node', 'bin', 'node');
  if (existsSync(localNode)) return localNode;
  // Windows local node
  const localNodeWin = join(home, 'node', 'node.exe');
  if (existsSync(localNodeWin)) return localNodeWin;
  return process.execPath;
}

function getNpmCliPath(): string {
  const home = resolveHome();
  // Local node's npm (Unix)
  const localNpm = join(home, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(localNpm)) return localNpm;
  // Local node's npm (Windows)
  const localNpmWin = join(home, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(localNpmWin)) return localNpmWin;
  // System npm
  return 'npm';
}

function runNpm(args: string[], cwd: string): void {
  const nodePath = getNodePath();
  const npmCli = getNpmCliPath();

  if (npmCli === 'npm') {
    execSync(`npm ${args.join(' ')}`, { cwd, stdio: 'pipe' });
  } else {
    execFileSync(nodePath, [npmCli, ...args], { cwd, stdio: 'pipe' });
  }
}

export async function performUpdate(): Promise<void> {
  const home = resolveHome();
  const appDir = join(home, 'app');
  const backupDir = join(home, 'app.bak');
  const buildDir = join(home, 'build-tmp');

  // 1. Download latest source as zip
  const zipUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
  console.log('Downloading latest source...');

  const res = await fetch(zipUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const tmpZip = join(home, 'update.zip');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tmpZip, Buffer.from(await res.arrayBuffer()));

  // 2. Extract to build directory
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  try {
    // tar can handle zip on macOS/Linux; Windows has tar since Win10
    execFileSync('tar', ['-xf', tmpZip, '-C', buildDir, '--strip-components=1'], { stdio: 'pipe' });
  } catch {
    // Fallback: try PowerShell Expand-Archive on Windows
    try {
      const extractDir = join(buildDir, '_extract');
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'pipe' },
      );
      // Move contents up (strip the top-level folder)
      const { readdirSync } = await import('node:fs');
      const inner = readdirSync(extractDir);
      const sourceDir = inner.length === 1 ? join(extractDir, inner[0]) : extractDir;
      cpSync(sourceDir, buildDir, { recursive: true });
      rmSync(extractDir, { recursive: true, force: true });
    } catch (err) {
      rmSync(tmpZip, { force: true });
      throw new Error(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  rmSync(tmpZip, { force: true });

  // 3. Install dependencies and compile
  console.log('Installing dependencies...');
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], buildDir);

  console.log('Compiling TypeScript...');
  const nodePath = getNodePath();
  const tscBin = join(buildDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(nodePath, [tscBin], { cwd: buildDir, stdio: 'pipe' });

  // 4. Stop service if running
  const status = getStatus();
  if (status.running) {
    console.log('Stopping service...');
    stopService();
    // Wait for process to fully exit (Windows holds file locks briefly after exit)
    await new Promise(r => setTimeout(r, 5000));
  }

  // 5. Backup current app/ and deploy new one
  // Retry cleanup of old backup — Windows may hold file locks briefly
  if (existsSync(backupDir)) {
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(backupDir, { recursive: true, force: true });
        break;
      } catch {
        if (i < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }
    // If still exists, rename it out of the way
    if (existsSync(backupDir)) {
      try { renameSync(backupDir, backupDir + '-' + Date.now()); } catch { /* best effort */ }
    }
  }
  if (existsSync(appDir)) renameSync(appDir, backupDir);
  mkdirSync(appDir, { recursive: true });

  try {
    // Copy compiled output
    cpSync(join(buildDir, 'dist'), appDir, { recursive: true });
    // Copy node_modules (needed at runtime)
    cpSync(join(buildDir, 'node_modules'), join(appDir, 'node_modules'), { recursive: true });
    // Copy package.json (version detection)
    cpSync(join(buildDir, 'package.json'), join(appDir, 'package.json'));
  } catch (err) {
    // Restore backup on failure
    if (existsSync(backupDir)) {
      rmSync(appDir, { recursive: true, force: true });
      renameSync(backupDir, appDir);
    }
    throw new Error(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Cleanup (best effort — locked files on Windows are harmless leftovers)
  try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* ok */ }
  try { if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true }); } catch { /* ok */ }

  // 7. Regenerate service wrappers + restart if it was running
  if (status.installed) {
    console.log('Updating service configuration...');
    installService();
  }
  if (status.running) {
    console.log('Restarting service...');
    startService();
  }

  console.log('Update complete! Your config and data are unchanged.');
}
