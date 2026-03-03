/**
 * Platform-specific background service management.
 *
 * macOS: launchd (user-level LaunchAgent, no root required)
 * Windows: Task Scheduler (LogonTrigger, Limited RunLevel)
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { resolveHome } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('service');

const SERVICE_LABEL = 'cash.endgame.agent';
const TASK_NAME = 'EndGameAgent';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
}

// ── Paths ────────────────────────────────────────────────────────

function getPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function getNodePath(): string {
  const home = resolveHome();
  const localNode = join(home, 'node', 'bin', 'node');
  if (existsSync(localNode)) return localNode;
  return process.execPath; // fallback to system node
}

function getAgentEntryPoint(): string {
  const home = resolveHome();
  // Installed layout: dist/* copied into app/
  const installed = join(home, 'app', 'cli.js');
  if (existsSync(installed)) return installed;
  // Dev mode: use compiled output directly
  return join(home, 'dist', 'cli.js');
}

// ── macOS launchd ────────────────────────────────────────────────

function generatePlist(useCaffeinate: boolean): string {
  const home = resolveHome();
  const nodePath = getNodePath();
  const entryPoint = getAgentEntryPoint();
  const logDir = join(home, 'logs');

  const program = useCaffeinate
    ? `    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/caffeinate</string>
      <string>-i</string>
      <string>${nodePath}</string>
      <string>${entryPoint}</string>
      <string>run</string>
    </array>`
    : `    <key>ProgramArguments</key>
    <array>
      <string>${nodePath}</string>
      <string>${entryPoint}</string>
      <string>run</string>
    </array>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
${program}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AGENT_HOME</key>
      <string>${home}</string>
      <key>NODE_ENV</key>
      <string>production</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${join(logDir, 'agent.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(logDir, 'agent-error.log')}</string>
    <key>WorkingDirectory</key>
    <string>${home}</string>
</dict>
</plist>`;
}

function installMacOS(useCaffeinate: boolean): void {
  const plistPath = getPlistPath();
  const home = resolveHome();

  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });

  const plist = generatePlist(useCaffeinate);
  writeFileSync(plistPath, plist);
  log.info('LaunchAgent plist installed', { path: plistPath });
}

function uninstallMacOS(): void {
  const plistPath = getPlistPath();
  stopMacOS(); // stop before removing
  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
    log.info('LaunchAgent plist removed');
  }
}

function startMacOS(): void {
  const plistPath = getPlistPath();
  if (!existsSync(plistPath)) throw new Error('Service not installed. Run `endgame-agent setup` first.');
  try {
    execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'pipe' });
  } catch {
    // May already be loaded — try kickstart
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`], { stdio: 'pipe' });
  }
  log.info('Service started via launchd');
}

function stopMacOS(): void {
  const plistPath = getPlistPath();
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
  } catch { /* not loaded */ }
}

function getStatusMacOS(): ServiceStatus {
  const plistPath = getPlistPath();
  const installed = existsSync(plistPath);
  if (!installed) return { installed: false, running: false };

  try {
    const output = execSync(`launchctl list | grep ${SERVICE_LABEL}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = output.trim().split(/\s+/);
    const pid = parseInt(parts[0] ?? '', 10);
    return { installed: true, running: !isNaN(pid) && pid > 0, pid: isNaN(pid) ? undefined : pid };
  } catch {
    return { installed: true, running: false };
  }
}

// ── Windows Task Scheduler ───────────────────────────────────────

function installWindows(): void {
  const home = resolveHome();
  const nodePath = getNodePath();
  const entryPoint = getAgentEntryPoint();

  mkdirSync(join(home, 'logs'), { recursive: true });

  // Create a wrapper .cmd that sets AGENT_HOME
  const cmdPath = join(home, 'bin', 'run-agent.cmd');
  mkdirSync(join(home, 'bin'), { recursive: true });
  const logFile = join(home, 'logs', 'agent.log');
  writeFileSync(cmdPath, [
    '@echo off',
    `set AGENT_HOME=${home}`,
    `set NODE_ENV=production`,
    `"${nodePath}" "${entryPoint}" run >> "${logFile}" 2>&1`,
  ].join('\r\n') + '\r\n');

  // Create a VBScript launcher that runs the .cmd hidden (no visible window)
  const vbsPath = join(home, 'bin', 'run-agent.vbs');
  writeFileSync(vbsPath, [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${cmdPath}""", 0, True`,
  ].join('\r\n') + '\r\n');

  // Create scheduled task via schtasks
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${vbsPath}"</Arguments>
      <WorkingDirectory>${home}</WorkingDirectory>
    </Exec>
  </Actions>
  <Principals>
    <Principal>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
</Task>`;

  const xmlPath = join(home, 'bin', 'task.xml');
  writeFileSync(xmlPath, xml);

  execFileSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'], { stdio: 'pipe' });
  log.info('Windows scheduled task created', { name: TASK_NAME });
}

function uninstallWindows(): void {
  stopWindows();
  try {
    execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'pipe' });
    log.info('Windows scheduled task removed');
  } catch { /* not found */ }
}

function startWindows(): void {
  const status = getStatusWindows();
  if (!status.installed) {
    throw new Error('Service not installed. Run `endgame-agent setup` first and choose "Install as background service".');
  }
  // Ensure VBS launcher exists (self-heal after updates from older versions)
  const home = resolveHome();
  const vbsPath = join(home, 'bin', 'run-agent.vbs');
  if (!existsSync(vbsPath)) {
    installWindows();
  }
  execFileSync('schtasks', ['/Run', '/TN', TASK_NAME], { stdio: 'pipe' });
  log.info('Service started via Task Scheduler');
}

function stopWindows(): void {
  try {
    execFileSync('schtasks', ['/End', '/TN', TASK_NAME], { stdio: 'pipe' });
  } catch { /* not running */ }
}

function getStatusWindows(): ServiceStatus {
  try {
    const output = execFileSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const installed = output.includes(TASK_NAME);
    const running = output.includes('Running');
    return { installed, running };
  } catch {
    return { installed: false, running: false };
  }
}

// ── Cross-platform API ───────────────────────────────────────────

export function installService(options: { useCaffeinate?: boolean } = {}): void {
  if (platform() === 'darwin') {
    installMacOS(options.useCaffeinate ?? false);
  } else if (platform() === 'win32') {
    installWindows();
  } else {
    throw new Error(`Unsupported platform: ${platform()}. Only macOS and Windows are supported.`);
  }
}

export function uninstallService(): void {
  if (platform() === 'darwin') uninstallMacOS();
  else if (platform() === 'win32') uninstallWindows();
}

export function startService(): void {
  if (platform() === 'darwin') startMacOS();
  else if (platform() === 'win32') startWindows();
  else throw new Error(`Unsupported platform: ${platform()}`);
}

export function stopService(): void {
  if (platform() === 'darwin') stopMacOS();
  else if (platform() === 'win32') stopWindows();
}

export function getStatus(): ServiceStatus {
  if (platform() === 'darwin') return getStatusMacOS();
  if (platform() === 'win32') return getStatusWindows();
  return { installed: false, running: false };
}

export function getLogPath(): string {
  return join(resolveHome(), 'logs', 'agent.log');
}
