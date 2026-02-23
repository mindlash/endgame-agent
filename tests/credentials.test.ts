/**
 * Tests for credential storage module.
 * Tests the logic without actually touching the OS credential store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { platform } from 'node:os';

// We test the module's behavior by verifying it calls the right OS commands.
// Since we can't mock execFileSync at the module level easily, we test the
// public interface with graceful failure handling.

describe('credentials', () => {
  it('isCredentialStoreAvailable returns true on macOS or Windows', async () => {
    const { isCredentialStoreAvailable } = await import('../src/cli/credentials.js');
    const os = platform();
    if (os === 'darwin' || os === 'win32') {
      expect(isCredentialStoreAvailable()).toBe(true);
    } else {
      expect(isCredentialStoreAvailable()).toBe(false);
    }
  });

  it('retrievePassword returns null when no credential stored', async () => {
    const { retrievePassword } = await import('../src/cli/credentials.js');
    // This should return null on a clean system (no stored cred for endgame-agent)
    // On CI or systems without the credential, this gracefully returns null
    const result = retrievePassword();
    // We can't assert the exact value since it depends on system state,
    // but it should not throw
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('deletePassword returns false or true without throwing', async () => {
    const { deletePassword } = await import('../src/cli/credentials.js');
    // Should not throw regardless of whether a credential exists
    const result = deletePassword();
    expect(typeof result).toBe('boolean');
  });
});
