/**
 * Isolated signing subprocess.
 *
 * This runs as a separate Node.js process with NO access to:
 * - The network (no fetch, no API calls)
 * - The marketing engine or LLM components
 * - Any config beyond the encrypted keyfile path
 *
 * Communication is strictly via parent process IPC:
 *   Parent sends: { type: 'unlock', password: string }
 *   Parent sends: { type: 'sign', message: string }  // base58-encoded
 *   Child replies: { type: 'signature', signature: string }  // base58-encoded
 *   Child replies: { type: 'error', message: string }
 *
 * The private key lives ONLY in this process's memory.
 */

import { readFileSync } from 'node:fs';
import { decryptKey, signMessage, type EncryptedKeyfile } from './keystore.js';

interface UnlockMessage { type: 'unlock'; password: string; keyfilePath: string }
interface SignMessage { type: 'sign'; message: string }
type IncomingMessage = UnlockMessage | SignMessage;

let privateKey: Uint8Array | null = null;

async function handleMessage(msg: IncomingMessage): Promise<void> {
  try {
    if (msg.type === 'unlock') {
      const keyfile: EncryptedKeyfile = JSON.parse(
        readFileSync(msg.keyfilePath, 'utf-8'),
      );
      privateKey = await decryptKey(keyfile, msg.password);
      process.send?.({ type: 'unlocked' });
      return;
    }

    if (msg.type === 'sign') {
      if (!privateKey) {
        process.send?.({ type: 'error', message: 'Signer not unlocked' });
        return;
      }
      const messageBytes = Buffer.from(msg.message, 'base64');
      const signature = signMessage(messageBytes, privateKey);
      process.send?.({
        type: 'signature',
        signature: Buffer.from(signature).toString('base64'),
      });
      return;
    }
  } catch (err) {
    process.send?.({
      type: 'error',
      message: err instanceof Error ? err.message : 'Unknown signing error',
    });
  }
}

// Only run when spawned as a child process
if (process.send) {
  process.on('message', handleMessage);
  process.send({ type: 'ready' });
}
