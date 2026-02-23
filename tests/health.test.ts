/**
 * Tests for health check report.
 */
import { describe, it, expect } from 'vitest';
import { generateHealthReport, formatHealthReport } from '../src/cli/health.js';

describe('health', () => {
  it('generateHealthReport returns valid report shape', async () => {
    const report = await generateHealthReport();

    expect(typeof report.service.installed).toBe('boolean');
    expect(typeof report.service.running).toBe('boolean');
    expect(typeof report.config.exists).toBe('boolean');
    expect(typeof report.config.path).toBe('string');
    expect(typeof report.keyfile.exists).toBe('boolean');
    expect(typeof report.api.reachable).toBe('boolean');
    expect(typeof report.api.latencyMs).toBe('number');
    expect(typeof report.system.nodeVersion).toBe('string');
    expect(typeof report.system.platform).toBe('string');
    expect(typeof report.system.memoryUsedMb).toBe('number');
    expect(typeof report.system.memoryTotalMb).toBe('number');
    expect(typeof report.logs.errorCount).toBe('number');
  });

  it('formatHealthReport returns readable string', async () => {
    const report = await generateHealthReport();
    const formatted = formatHealthReport(report);

    expect(typeof formatted).toBe('string');
    expect(formatted).toContain('EndGame Agent Status');
    expect(formatted).toContain('Service:');
    expect(formatted).toContain('Node.js:');
    expect(formatted).toContain('Platform:');
  });
});
