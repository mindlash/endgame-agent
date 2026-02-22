/**
 * Agent configuration loaded from .env and setup wizard.
 * All secrets are read once at startup and never logged.
 */

export interface AgentConfig {
  // Wallet
  walletAddress: string;

  // Claim settings
  claimEnabled: boolean;
  claimRetryAttempts: number;
  claimRetryDelayMs: number;

  // Marketing
  marketingEnabled: boolean;
  marketingChannels: ('twitter' | 'discord' | 'telegram')[];
  referralCode: string;
  postsPerDay: number;

  // API
  apiBaseUrl: string;
  apiTimeoutMs: number;

  // Security
  encryptedKeyPath: string;
}

export interface SecureConfig {
  // Never persisted, never logged — lives only in the signing subprocess
  privateKey: Uint8Array;
}
