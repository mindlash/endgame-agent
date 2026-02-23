#!/usr/bin/env tsx

/**
 * esbuild bundler — produces pre-bundled single-file artifacts.
 *
 * Outputs:
 *   dist/endgame-agent.js  — Main agent bundle (everything except signer)
 *   dist/signer.js         — Signer subprocess bundle (isolated, no shared imports)
 *
 * argon2 is marked as external (native addon) — the platform-specific
 * prebuilt binary must be included alongside the bundles in the release archive.
 *
 * Usage:
 *   npx tsx scripts/bundle.ts
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist-bundle');

mkdirSync(DIST, { recursive: true });

const COMMON_OPTIONS = {
  platform: 'node' as const,
  target: 'node20',
  format: 'esm' as const,
  bundle: true,
  minify: false, // keep readable for auditing
  sourcemap: true,
  // Native addons that can't be bundled
  external: ['argon2'],
};

async function bundleMain(): Promise<void> {
  await build({
    ...COMMON_OPTIONS,
    entryPoints: [join(ROOT, 'src', 'cli.ts')],
    outfile: join(DIST, 'endgame-agent.js'),
    banner: {
      js: '#!/usr/bin/env node\n// EndGame Agent — pre-bundled release. Do not edit.',
    },
  });
  console.log('Bundled: dist-bundle/endgame-agent.js');
}

async function bundleSigner(): Promise<void> {
  await build({
    ...COMMON_OPTIONS,
    entryPoints: [join(ROOT, 'src', 'security', 'signer.ts')],
    outfile: join(DIST, 'signer.js'),
    banner: {
      js: '// EndGame Agent Signer — isolated subprocess. Do not edit.',
    },
  });
  console.log('Bundled: dist-bundle/signer.js');
}

async function copyNativeAddon(): Promise<void> {
  // Copy argon2 prebuilt binary for the current platform
  const argon2Path = join(ROOT, 'node_modules', 'argon2', 'prebuilds');
  if (existsSync(argon2Path)) {
    const dest = join(DIST, 'prebuilds');
    cpSync(argon2Path, dest, { recursive: true });
    console.log('Copied: argon2 prebuilds');
  } else {
    console.warn('Warning: argon2 prebuilds not found. Users will need argon2 available.');
  }
}

async function main(): Promise<void> {
  console.log('Building pre-bundled release...\n');

  // Bundle main and signer in parallel
  await Promise.all([bundleMain(), bundleSigner()]);

  // Copy native addons
  await copyNativeAddon();

  console.log('\nBundle complete. Output in dist-bundle/');
}

main().catch(err => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
