/**
 * Twitter/X channel adapter — posts via v2 API with OAuth 1.0a signing.
 * Requires a paid Basic tier ($5/month) Twitter developer account.
 * OAuth 1.0a HMAC-SHA1 signing is implemented inline (no external deps).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from '../../core/logger.js';
import type { ChannelAdapter } from '../engine.js';

const log = createLogger('twitter');

const TWEET_MAX_LENGTH = 280;
const TWEETS_ENDPOINT = 'https://api.twitter.com/2/tweets';

export interface TwitterConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

// ── OAuth 1.0a Helpers ──────────────────────────────────────────────

/** Percent-encode per RFC 3986 (required by OAuth 1.0a). */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Generate a random nonce string. */
function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Build the OAuth 1.0a Authorization header value. */
function buildOAuthHeader(
  method: string,
  url: string,
  config: TwitterConfig,
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  // OAuth parameters (sorted alphabetically by key)
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: config.accessToken,
    oauth_version: '1.0',
  };

  // Build the parameter string (all params sorted by key)
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');

  // Build the signature base string
  const signatureBase = `${method}&${percentEncode(url)}&${percentEncode(paramString)}`;

  // Sign with HMAC-SHA1
  const signingKey = `${percentEncode(config.apiSecret)}&${percentEncode(config.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  // Build the Authorization header
  const authParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };

  const header = Object.keys(authParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(authParams[k])}"`)
    .join(', ');

  return `OAuth ${header}`;
}

// ── Twitter Channel Adapter ─────────────────────────────────────────

interface TweetResponse {
  data?: { id: string; text: string };
  errors?: Array<{ message: string }>;
}

export class TwitterChannel implements ChannelAdapter {
  name = 'twitter';
  private config: TwitterConfig;

  constructor(config: TwitterConfig) {
    const { apiKey, apiSecret, accessToken, accessTokenSecret } = config;
    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      throw new Error('Twitter adapter requires apiKey, apiSecret, accessToken, and accessTokenSecret');
    }
    this.config = config;
  }

  async post(content: string, referralLink?: string): Promise<{ postId: string }> {
    let text = content;

    if (referralLink) {
      // Reserve space for newline + link, truncate content if needed
      const linkSuffix = `\n${referralLink}`;
      const maxContentLength = TWEET_MAX_LENGTH - linkSuffix.length;
      if (text.length > maxContentLength) {
        text = text.slice(0, maxContentLength - 1) + '\u2026'; // ellipsis
      }
      text += linkSuffix;
    } else if (text.length > TWEET_MAX_LENGTH) {
      text = text.slice(0, TWEET_MAX_LENGTH - 1) + '\u2026';
    }

    const authorization = buildOAuthHeader('POST', TWEETS_ENDPOINT, this.config);

    const res = await fetch(TWEETS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({ text }),
    });

    if (res.status === 429) {
      const resetHeader = res.headers.get('x-rate-limit-reset');
      log.warn('Twitter rate limited', { resetAt: resetHeader });
      throw new Error(`Twitter rate limited — resets at ${resetHeader ?? 'unknown'}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Twitter API failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as TweetResponse;

    if (data.errors?.length) {
      const msg = data.errors.map((e) => e.message).join('; ');
      throw new Error(`Twitter API errors: ${msg}`);
    }

    if (!data.data?.id) {
      throw new Error('Twitter API returned no tweet ID');
    }

    log.info('Posted to Twitter', { postId: data.data.id });
    return { postId: data.data.id };
  }
}
