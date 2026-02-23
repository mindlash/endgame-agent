/**
 * Health check report — service status, config state, API reachability,
 * disk space, memory usage, Node.js version, and recent log analysis.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { freemem, totalmem, platform } from 'node:os';
import { resolveHome, resolveDataDir, resolveConfigDir } from '../core/config.js';
import { getStatus, getLogPath, type ServiceStatus } from './service.js';

export interface HealthReport {
  service: ServiceStatus;
  config: { exists: boolean; path: string };
  keyfile: { exists: boolean; path: string; permissions?: string };
  personality: { exists: boolean; path: string };
  api: { reachable: boolean; latencyMs: number; error?: string };
  system: {
    nodeVersion: string;
    platform: string;
    memoryUsedMb: number;
    memoryTotalMb: number;
    agentHomePath: string;
  };
  logs: { path: string; exists: boolean; lastLine?: string; errorCount: number };
}

async function checkApiReachability(): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch('https://api.endgame.cash/api/game/status', {
      headers: { Origin: 'https://endgame.cash', Referer: 'https://endgame.cash/' },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    return { reachable: res.ok, latencyMs, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

function getFilePermissions(path: string): string | undefined {
  if (platform() === 'win32') return undefined;
  try {
    const stat = statSync(path);
    return '0' + (stat.mode & 0o777).toString(8);
  } catch {
    return undefined;
  }
}

function analyzeLog(logPath: string): { lastLine?: string; errorCount: number } {
  if (!existsSync(logPath)) return { errorCount: 0 };
  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const errorCount = lines.filter(l => l.includes('"level":"error"')).length;
    return { lastLine, errorCount };
  } catch {
    return { errorCount: 0 };
  }
}

export async function generateHealthReport(): Promise<HealthReport> {
  const home = resolveHome();
  const dataDir = resolveDataDir();
  const configDir = resolveConfigDir();

  const envPath = join(configDir, '.env');
  const keyfilePath = join(dataDir, 'keyfile.json');
  const personalityPath = join(dataDir, 'personality.json');
  const logPath = getLogPath();

  const [service, api, logAnalysis] = await Promise.all([
    Promise.resolve(getStatus()),
    checkApiReachability(),
    Promise.resolve(analyzeLog(logPath)),
  ]);

  return {
    service,
    config: { exists: existsSync(envPath), path: envPath },
    keyfile: {
      exists: existsSync(keyfilePath),
      path: keyfilePath,
      permissions: getFilePermissions(keyfilePath),
    },
    personality: { exists: existsSync(personalityPath), path: personalityPath },
    api,
    system: {
      nodeVersion: process.version,
      platform: platform(),
      memoryUsedMb: Math.round((totalmem() - freemem()) / 1024 / 1024),
      memoryTotalMb: Math.round(totalmem() / 1024 / 1024),
      agentHomePath: home,
    },
    logs: { path: logPath, exists: existsSync(logPath), ...logAnalysis },
  };
}

export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = ['EndGame Agent Status', '====================', ''];

  // Service
  const serviceIcon = report.service.running ? 'RUNNING' : report.service.installed ? 'STOPPED' : 'NOT INSTALLED';
  lines.push(`Service:     ${serviceIcon}${report.service.pid ? ` (PID ${report.service.pid})` : ''}`);

  // Config files
  lines.push(`Config:      ${report.config.exists ? 'OK' : 'MISSING'} (${report.config.path})`);
  lines.push(`Keyfile:     ${report.keyfile.exists ? 'OK' : 'MISSING'}${report.keyfile.permissions ? ` [${report.keyfile.permissions}]` : ''}`);
  lines.push(`Personality: ${report.personality.exists ? 'OK' : 'MISSING'}`);

  // API
  lines.push(`API:         ${report.api.reachable ? `OK (${report.api.latencyMs}ms)` : `UNREACHABLE (${report.api.error})`}`);

  // System
  lines.push('');
  lines.push(`Node.js:     ${report.system.nodeVersion}`);
  lines.push(`Platform:    ${report.system.platform}`);
  lines.push(`Memory:      ${report.system.memoryUsedMb}/${report.system.memoryTotalMb} MB`);
  lines.push(`AGENT_HOME:  ${report.system.agentHomePath}`);

  // Keyfile permissions warning
  if (report.keyfile.exists && report.keyfile.permissions && report.keyfile.permissions !== '0600') {
    lines.push('');
    lines.push(`WARNING: Keyfile permissions are ${report.keyfile.permissions} (should be 0600)`);
  }

  // Logs
  if (report.logs.exists) {
    lines.push('');
    lines.push(`Logs:        ${report.logs.path}`);
    if (report.logs.errorCount > 0) {
      lines.push(`Errors:      ${report.logs.errorCount} errors in log`);
    }
    if (report.logs.lastLine) {
      lines.push(`Last entry:  ${report.logs.lastLine.slice(0, 120)}`);
    }
  }

  return lines.join('\n');
}
