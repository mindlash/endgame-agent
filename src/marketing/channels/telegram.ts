/**
 * Telegram channel adapter — posts via Bot API (raw HTTP).
 * Requires a bot token from @BotFather and a chat/channel ID.
 */

import { createLogger } from '../../core/logger.js';
import type { ChannelAdapter } from '../engine.js';

const log = createLogger('telegram');

const MAX_CONTENT_LENGTH = 4096;
const API_BASE = 'https://api.telegram.org';
const FETCH_TIMEOUT_MS = 30_000;

interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: {
    message_id: number;
  };
}

export class TelegramChannel implements ChannelAdapter {
  name = 'telegram';
  private botToken: string;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    if (!botToken || !chatId) {
      throw new Error('Telegram adapter requires both botToken and chatId');
    }
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async delete(postId: string): Promise<void> {
    const url = `${API_BASE}/bot${this.botToken}/deleteMessage`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, message_id: parseInt(postId, 10) }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram delete failed (${res.status}): ${body}`);
      }

      const data = (await res.json()) as TelegramResponse;
      if (!data.ok) {
        throw new Error(`Telegram delete error: ${data.description ?? 'unknown error'}`);
      }
      log.info('Deleted Telegram message', { postId, chatId: this.chatId });
    } finally {
      clearTimeout(timer);
    }
  }

  async post(content: string, referralLink?: string): Promise<{ postId: string }> {
    let text = content;
    if (referralLink) {
      text += `\n${referralLink}`;
    }

    if (text.length > MAX_CONTENT_LENGTH) {
      text = text.slice(0, MAX_CONTENT_LENGTH);
      log.warn('Telegram message truncated to 4096 chars');
    }

    const url = `${API_BASE}/bot${this.botToken}/sendMessage`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram API failed (${res.status}): ${body}`);
      }

      const data = (await res.json()) as TelegramResponse;

      if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description ?? 'unknown error'}`);
      }

      const postId = String(data.result!.message_id);
      log.info('Posted to Telegram', { postId, chatId: this.chatId });
      return { postId };
    } finally {
      clearTimeout(timer);
    }
  }
}
