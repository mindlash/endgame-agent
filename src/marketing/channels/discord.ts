/**
 * Discord channel adapter — posts via webhook URL.
 * Simplest adapter: just POST JSON to the webhook endpoint.
 */

import { createLogger } from '../../core/logger.js';
import type { ChannelAdapter } from '../engine.js';

const log = createLogger('discord');

const MAX_CONTENT_LENGTH = 2000;

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      throw new Error('Invalid Discord webhook URL — must start with https://discord.com/api/webhooks/');
    }
    this.webhookUrl = webhookUrl;
  }

  async post(content: string, referralLink?: string): Promise<{ postId: string }> {
    let text = content;
    if (referralLink) {
      text += `\n${referralLink}`;
    }

    if (text.length > MAX_CONTENT_LENGTH) {
      text = text.slice(0, MAX_CONTENT_LENGTH);
      log.warn('Discord message truncated to 2000 chars');
    }

    // Append ?wait=true so Discord returns the message object with id
    const url = this.webhookUrl + (this.webhookUrl.includes('?') ? '&wait=true' : '?wait=true');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      log.warn('Discord rate limited', { retryAfter: body['retry_after'] });
      throw new Error(`Discord rate limited — retry after ${body['retry_after'] ?? 'unknown'}s`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { id: string };
    log.info('Posted to Discord', { postId: data.id });
    return { postId: data.id };
  }
}
