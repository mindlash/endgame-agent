/**
 * Secure key management with Argon2id KDF.
 *
 * Design principles:
 * - Private key NEVER leaves this module
 * - Encrypted at rest with user-chosen password
 * - Argon2id derives the encryption key (memory-hard, GPU-resistant)
 * - NaCl secretbox for symmetric encryption
 * - Signing happens here, in isolation — callers send message bytes, get signatures back
 *
 * Architecture:
 * In production, this module runs as an ISOLATED SUBPROCESS.
 * The main agent process communicates via structured IPC messages:
 *   Main → Signer: { type: 'sign', payload: base58EncodedMessage }
 *   Signer → Main: { type: 'signature', payload: base58EncodedSignature }
 *
 * The LLM/marketing components have ZERO access to this subprocess.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('keystore');

// Argon2id parameters (OWASP recommended minimums)
const ARGON2_TIME_COST = 3;
const ARGON2_MEMORY_COST = 65536; // 64 MB
const ARGON2_PARALLELISM = 1;
const SALT_LENGTH = 32;
const NONCE_LENGTH = 24; // NaCl secretbox nonce

export interface EncryptedKeyfile {
  version: 1;
  algorithm: 'argon2id-nacl-secretbox';
  salt: string;       // base64
  nonce: string;      // base64
  ciphertext: string;  // base64
  argon2: {
    timeCost: number;
    memoryCost: number;
    parallelism: number;
  };
}

/**
 * Encrypt a private key with a password.
 * Returns the keyfile structure to write to disk.
 */
export async function encryptKey(
  privateKey: Uint8Array,
  password: string,
): Promise<EncryptedKeyfile> {
  const argon2 = await import('argon2');
  const nacl = await import('tweetnacl');
  const crypto = await import('node:crypto');

  const salt = crypto.randomBytes(SALT_LENGTH);
  const nonce = crypto.randomBytes(NONCE_LENGTH);

  // Derive 32-byte encryption key from password
  const derivedKey = await argon2.hash(password, {
    type: argon2.argon2id,
    salt,
    timeCost: ARGON2_TIME_COST,
    memoryCost: ARGON2_MEMORY_COST,
    parallelism: ARGON2_PARALLELISM,
    hashLength: 32,
    raw: true,
  });

  // Encrypt with NaCl secretbox
  const ciphertext = nacl.secretbox(privateKey, nonce, derivedKey);

  log.info('Key encrypted successfully');

  return {
    version: 1,
    algorithm: 'argon2id-nacl-secretbox',
    salt: Buffer.from(salt).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    argon2: {
      timeCost: ARGON2_TIME_COST,
      memoryCost: ARGON2_MEMORY_COST,
      parallelism: ARGON2_PARALLELISM,
    },
  };
}

/**
 * Decrypt a private key from an encrypted keyfile.
 * The returned key should be held in memory only — never written to disk.
 */
export async function decryptKey(
  keyfile: EncryptedKeyfile,
  password: string,
): Promise<Uint8Array> {
  const argon2 = await import('argon2');
  const nacl = await import('tweetnacl');

  const salt = Buffer.from(keyfile.salt, 'base64');
  const nonce = Buffer.from(keyfile.nonce, 'base64');
  const ciphertext = Buffer.from(keyfile.ciphertext, 'base64');

  const derivedKey = await argon2.hash(password, {
    type: argon2.argon2id,
    salt,
    timeCost: keyfile.argon2.timeCost,
    memoryCost: keyfile.argon2.memoryCost,
    parallelism: keyfile.argon2.parallelism,
    hashLength: 32,
    raw: true,
  });

  const plaintext = nacl.secretbox.open(ciphertext, nonce, derivedKey);
  if (!plaintext) {
    throw new Error('Decryption failed — wrong password or corrupted keyfile');
  }

  log.info('Key decrypted successfully');
  return plaintext;
}

/**
 * Sign a message with the decrypted private key.
 * Used by the isolated signing subprocess.
 */
export function signMessage(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const nacl = require('tweetnacl') as typeof import('tweetnacl');
  return nacl.sign.detached(message, privateKey);
}
