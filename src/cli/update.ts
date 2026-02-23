/**
 * Manual-trigger update — checks for new releases and replaces app/ files.
 *
 * data/ and config/ are never touched during updates.
 * No auto-update (red team recommendation).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import { resolveHome } from '../core/config.js';
import { stopService, startService, getStatus } from './service.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('update');

const GITHUB_REPO = 'endgame-agent/endgame-agent';
const RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(
      execFileSync('node', ['-e', 'process.stdout.write(require("./package.json").version)'], {
        cwd: resolveHome(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    return typeof pkg === 'string' ? pkg : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getPlatformAssetName(): string {
  const os = platform() === 'darwin' ? 'darwin' : 'win32';
  const a = arch() === 'arm64' ? 'arm64' : 'x64';
  return `endgame-agent-${os}-${a}.tar.gz`;
}

export async function checkForUpdate(): Promise<{ available: boolean; current: string; latest: string }> {
  const current = getCurrentVersion();
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const release = (await res.json()) as GitHubRelease;
    const latest = release.tag_name.replace(/^v/, '');
    return { available: latest !== current, current, latest };
  } catch (err) {
    log.warn('Failed to check for updates', { error: err instanceof Error ? err.message : String(err) });
    return { available: false, current, latest: current };
  }
}

export async function performUpdate(): Promise<void> {
  const { available, current, latest } = await checkForUpdate();

  if (!available) {
    console.log(`Already on latest version (${current})`);
    return;
  }

  console.log(`Update available: ${current} -> ${latest}`);
  const home = resolveHome();
  const appDir = join(home, 'app');
  const backupDir = join(home, 'app.bak');

  // 1. Download the new release
  const assetName = getPlatformAssetName();
  const res = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10_000),
  });
  const release = (await res.json()) as GitHubRelease;
  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(`No release asset found for ${assetName}. Available: ${release.assets.map(a => a.name).join(', ')}`);
  }

  console.log(`Downloading ${assetName}...`);
  const downloadRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
  if (!downloadRes.ok) throw new Error(`Download failed: HTTP ${downloadRes.status}`);

  const tmpFile = join(home, 'update.tar.gz');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tmpFile, Buffer.from(await downloadRes.arrayBuffer()));

  // 2. Stop service if running
  const status = getStatus();
  if (status.running) {
    console.log('Stopping service...');
    stopService();
    // Give it a moment to shut down
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. Backup current app/ and extract new one
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });
  if (existsSync(appDir)) renameSync(appDir, backupDir);
  mkdirSync(appDir, { recursive: true });

  try {
    execFileSync('tar', ['-xzf', tmpFile, '-C', appDir], { stdio: 'pipe' });
  } catch (err) {
    // Restore backup on failure
    if (existsSync(backupDir)) {
      rmSync(appDir, { recursive: true });
      renameSync(backupDir, appDir);
    }
    throw new Error(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Cleanup
  rmSync(tmpFile, { force: true });
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });

  // 5. Restart service if it was running
  if (status.running) {
    console.log('Restarting service...');
    startService();
  }

  console.log(`Updated to ${latest}`);
}
