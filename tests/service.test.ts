/**
 * Tests for service management module.
 * Tests status checking and path resolution without actually
 * installing/starting services.
 */
import { describe, it, expect } from 'vitest';
import { platform } from 'node:os';

describe('service', () => {
  it('getStatus returns valid ServiceStatus shape', async () => {
    const { getStatus } = await import('../src/cli/service.js');
    const status = getStatus();
    expect(typeof status.installed).toBe('boolean');
    expect(typeof status.running).toBe('boolean');
    if (status.pid !== undefined) {
      expect(typeof status.pid).toBe('number');
    }
  });

  it('getLogPath returns a path string', async () => {
    const { getLogPath } = await import('../src/cli/service.js');
    const logPath = getLogPath();
    expect(typeof logPath).toBe('string');
    expect(logPath).toContain('logs');
    expect(logPath).toContain('agent.log');
  });

  it('installService throws on unsupported platform', async () => {
    // This test only makes sense on non-mac/win platforms
    if (platform() !== 'darwin' && platform() !== 'win32') {
      const { installService } = await import('../src/cli/service.js');
      expect(() => installService()).toThrow('Unsupported platform');
    }
  });
});
