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
      // Read from Windows Credential Manager using Win32 CredRead via .NET P/Invoke.
      // cmdkey can store but can't output passwords, so we use the native API.
      const psScript = [
        '$sig = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class CredHelper {',
        '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
        '  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);',
        '  [DllImport("advapi32.dll")]',
        '  public static extern void CredFree(IntPtr cred);',
        '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
        '  public struct CREDENTIAL {',
        '    public int Flags; public int Type;',
        '    public string TargetName; public string Comment;',
        '    public long LastWritten; public int CredentialBlobSize;',
        '    public IntPtr CredentialBlob; public int Persist;',
        '    public int AttributeCount; public IntPtr Attributes;',
        '    public string TargetAlias; public string UserName;',
        '  }',
        '  public static string GetPassword(string target) {',
        '    IntPtr ptr;',
        '    if (!CredRead(target, 1, 0, out ptr)) return null;',
        '    var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));',
        '    var pass = Marshal.PtrToStringUni(cred.CredentialBlob, cred.CredentialBlobSize/2);',
        '    CredFree(ptr);',
        '    return pass;',
        '  }',
        '}',
        '"@',
        'Add-Type -TypeDefinition $sig -Language CSharp',
        `$p = [CredHelper]::GetPassword("${SERVICE_NAME}")`,
        'if ($p) { Write-Output $p }',
      ].join('\n');

      const result = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', psScript,
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
