/**
 * Clean uninstall — stops service, removes credentials, optionally deletes data.
 */

import { existsSync, rmSync } from 'node:fs';
import * as readline from 'node:readline';
import { resolveHome } from '../core/config.js';
import { uninstallService, getStatus } from './service.js';
import { deletePassword } from './credentials.js';

export async function uninstall(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  const home = resolveHome();
  console.log('\n=== EndGame Agent Uninstall ===\n');
  console.log(`Agent home: ${home}`);

  // 1. Stop and deregister service
  const status = getStatus();
  if (status.installed) {
    console.log('Stopping and removing background service...');
    uninstallService();
    console.log('Service removed.');
  }

  // 2. Remove credential store entry
  console.log('Removing stored credentials...');
  deletePassword();

  // 3. Optionally delete all data
  const deleteData = (await ask('Delete all agent data (keyfile, personality, post history, logs)? (y/n): ')).trim().toLowerCase();
  if (deleteData === 'y') {
    if (existsSync(home)) {
      rmSync(home, { recursive: true, force: true });
      console.log(`Deleted ${home}`);
    }
  } else {
    console.log(`Data preserved at ${home}`);
  }

  console.log('\nUninstall complete.\n');
  rl.close();
}
