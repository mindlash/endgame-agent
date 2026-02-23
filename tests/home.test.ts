/**
 * Tests for AGENT_HOME abstraction (resolveHome, resolveDataDir, resolveConfigDir).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { resolveHome, resolveDataDir, resolveConfigDir } from '../src/core/config.js';

let originalAgentHome: string | undefined;

beforeEach(() => {
  originalAgentHome = process.env['AGENT_HOME'];
});

afterEach(() => {
  if (originalAgentHome === undefined) {
    delete process.env['AGENT_HOME'];
  } else {
    process.env['AGENT_HOME'] = originalAgentHome;
  }
});

describe('resolveHome', () => {
  it('returns AGENT_HOME when set', () => {
    process.env['AGENT_HOME'] = '/custom/agent/home';
    expect(resolveHome()).toBe('/custom/agent/home');
  });

  it('falls back to cwd when AGENT_HOME is not set', () => {
    delete process.env['AGENT_HOME'];
    expect(resolveHome()).toBe(process.cwd());
  });
});

describe('resolveDataDir', () => {
  it('returns AGENT_HOME/data when AGENT_HOME is set', () => {
    process.env['AGENT_HOME'] = '/custom/home';
    expect(resolveDataDir()).toBe(join('/custom/home', 'data'));
  });

  it('returns cwd/data when AGENT_HOME is not set', () => {
    delete process.env['AGENT_HOME'];
    expect(resolveDataDir()).toBe(join(process.cwd(), 'data'));
  });
});

describe('resolveConfigDir', () => {
  it('returns AGENT_HOME/config when AGENT_HOME is set', () => {
    process.env['AGENT_HOME'] = '/custom/home';
    expect(resolveConfigDir()).toBe(join('/custom/home', 'config'));
  });

  it('returns cwd/config when AGENT_HOME is not set', () => {
    delete process.env['AGENT_HOME'];
    expect(resolveConfigDir()).toBe(join(process.cwd(), 'config'));
  });
});
