/**
 * Platform-native secure credential storage for the keyfile password.
 *
 * macOS: Keychain via `security` CLI
 * Windows: Credential Manager via `cmdkey` / PowerShell
 *
 * No native Node.js addons — shells out to OS tools.
 */

import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { createLogger } from '../core/logger.js';

const log = createLogger('credentials');

const SERVICE_NAME = 'endgame-agent';
const ACCOUNT_NAME = 'keyfile-password';

export function isCredentialStoreAvailable(): boolean {
  return platform() === 'darwin' || platform() === 'win32';
}

export function storePassword(password: string): boolean {
  try {
    if (platform() === 'darwin') {
      // Delete existing entry first (ignore errors if not found)
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-s', SERVICE_NAME,
          '-a', ACCOUNT_NAME,
        ], { stdio: 'pipe' });
      } catch { /* entry doesn't exist yet */ }

      execFileSync('security', [
        'add-generic-password',
        '-s', SERVICE_NAME,
        '-a', ACCOUNT_NAME,
        '-w', password,
        '-U', // update if exists
      ], { stdio: 'pipe' });
      log.info('Password stored in macOS Keychain');
      return true;
    }

    if (platform() === 'win32') {
      // cmdkey syntax: /generic:name /user:name /pass:password
      execFileSync('cmdkey', [
        `/generic:${SERVICE_NAME}`,
        `/user:${ACCOUNT_NAME}`,
        `/pass:${password}`,
      ], { stdio: 'pipe' });
      log.info('Password stored in Windows Credential Manager');
      return true;
    }

    return false;
  } catch (err) {
    log.warn('Failed to store password in credential store', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function retrievePassword(): string | null {
  try {
    if (platform() === 'darwin') {
      const result = execFileSync('security', [
        'find-generic-password',
        '-s', SERVICE_NAME,
        '-a', ACCOUNT_NAME,
        '-w', // output password only
      ], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
      return result.trim();
    }

    if (platform() === 'win32') {
      // Use PowerShell to read the credential — cmdkey can't output passwords
      const script = `
        Add-Type -AssemblyName System.Runtime.InteropServices
        $cred = [System.Runtime.InteropServices.Marshal]
        $ptr = [advapi32]::CredRead("${SERVICE_NAME}", 1, 0, [ref]$null)
        # Fallback: use cmdkey to check existence, then CredRead via .NET
        $credential = Get-StoredCredential -Target "${SERVICE_NAME}" -ErrorAction SilentlyContinue
        if ($credential) { Write-Output $credential.GetNetworkCredential().Password }
      `;
      // Simpler approach: use PowerShell's built-in credential cmdlets if available,
      // otherwise use the Windows Credential Manager COM interface
      const result = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; ` +
        `$vault = New-Object Windows.Security.Credentials.PasswordVault; ` +
        `$cred = $vault.Retrieve("${SERVICE_NAME}", "${ACCOUNT_NAME}"); ` +
        `$cred.RetrievePassword(); Write-Output $cred.Password`,
      ], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
      return result.trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}

export function deletePassword(): boolean {
  try {
    if (platform() === 'darwin') {
      execFileSync('security', [
        'delete-generic-password',
        '-s', SERVICE_NAME,
        '-a', ACCOUNT_NAME,
      ], { stdio: 'pipe' });
      log.info('Password removed from macOS Keychain');
      return true;
    }

    if (platform() === 'win32') {
      execFileSync('cmdkey', [`/delete:${SERVICE_NAME}`], { stdio: 'pipe' });
      log.info('Password removed from Windows Credential Manager');
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
