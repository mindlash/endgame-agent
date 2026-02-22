/**
 * Tests for the EndGame API client: headers, error handling, response unwrapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EndGameApi } from '../src/api/client.js';

// ── Fetch Mock Setup ─────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helper ──────────────────────────────────────────────────────────

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

// ── Header Tests ────────────────────────────────────────────────────

describe('API client headers', () => {
  it('sends required Origin and Referer headers on GET', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      round_id: 1,
      current_round: 1,
      winner: '',
      prize_amount: '0',
      claim_deadline: 0,
      status: 'active',
      time_remaining_seconds: 60,
      vault_balance: '100',
    }));

    const api = new EndGameApi('https://test.api.com', 5000);
    await api.getGameStatus();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const url = callArgs[0] as string;
    const options = callArgs[1] as RequestInit;

    expect(url).toBe('https://test.api.com/api/game/status');
    expect((options.headers as Record<string, string>)['Origin']).toBe('https://endgame.cash');
    expect((options.headers as Record<string, string>)['Referer']).toBe('https://endgame.cash/');
    expect((options.headers as Record<string, string>)['Accept']).toBe('application/json');
  });

  it('sends required headers plus Content-Type on POST', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      results: [{ roundId: 1, claimable: true }],
    }));

    const api = new EndGameApi('https://test.api.com', 5000);
    await api.verifyClaims([1], 'wallet123');

    const callArgs = mockFetch.mock.calls[0];
    const options = callArgs[1] as RequestInit;

    expect((options.headers as Record<string, string>)['Origin']).toBe('https://endgame.cash');
    expect((options.headers as Record<string, string>)['Referer']).toBe('https://endgame.cash/');
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(options.method).toBe('POST');
  });
});

// ── Error Handling ──────────────────────────────────────────────────

describe('API client error handling', () => {
  it('throws on 404 response', async () => {
    mockFetch.mockResolvedValue(mockResponse({ error: 'Not found' }, 404));

    const api = new EndGameApi('https://test.api.com', 5000);
    await expect(api.getGameStatus()).rejects.toThrow('API 404');
  });

  it('throws on 500 response', async () => {
    mockFetch.mockResolvedValue(mockResponse({ error: 'Internal server error' }, 500));

    const api = new EndGameApi('https://test.api.com', 5000);
    await expect(api.getPrice()).rejects.toThrow('API 500');
  });

  it('throws on 403 response', async () => {
    mockFetch.mockResolvedValue(mockResponse({ error: 'Forbidden' }, 403));

    const api = new EndGameApi('https://test.api.com', 5000);
    await expect(api.getRankings()).rejects.toThrow('API 403');
  });

  it('includes the path in error messages', async () => {
    mockFetch.mockResolvedValue(mockResponse({ error: 'Not found' }, 404));

    const api = new EndGameApi('https://test.api.com', 5000);
    await expect(api.getGameStatus()).rejects.toThrow('/api/game/status');
  });

  it('handles fetch network errors', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const api = new EndGameApi('https://test.api.com', 5000);
    await expect(api.getGameStatus()).rejects.toThrow('fetch failed');
  });
});

// ── Response Unwrapping ─────────────────────────────────────────────

describe('API client response unwrapping', () => {
  it('getRaw returns the body as-is (getGameStatus)', async () => {
    const rawBody = {
      round_id: 42,
      current_round: 42,
      winner: 'wallet123',
      prize_amount: '5000000',
      claim_deadline: 1234567890,
      status: 'winner_selected',
      time_remaining_seconds: 300,
      vault_balance: '500000000',
    };
    mockFetch.mockResolvedValue(mockResponse(rawBody));

    const api = new EndGameApi('https://test.api.com', 5000);
    const result = await api.getGameStatus();

    expect(result).toEqual(rawBody);
  });

  it('get unwraps { success, data } wrapper (getPrice)', async () => {
    const wrappedBody = {
      success: true,
      data: {
        price_usd: 0.05,
        change_24h: 12.5,
        volume_24h: 50000,
        liquidity: 100000,
      },
      timestamp: '2026-02-22T00:00:00Z',
    };
    mockFetch.mockResolvedValue(mockResponse(wrappedBody));

    const api = new EndGameApi('https://test.api.com', 5000);
    const result = await api.getPrice();

    expect(result).toEqual({
      price_usd: 0.05,
      change_24h: 12.5,
      volume_24h: 50000,
      liquidity: 100000,
    });
  });

  it('get falls back to raw body when no data wrapper', async () => {
    const rawBody = {
      price_usd: 0.05,
      change_24h: 12.5,
    };
    mockFetch.mockResolvedValue(mockResponse(rawBody));

    const api = new EndGameApi('https://test.api.com', 5000);
    const result = await api.getPrice();

    // When there's no .data property, it returns the body as-is
    expect(result).toEqual(rawBody);
  });

  it('getCurrentRound is an alias for getGameStatus', async () => {
    const rawBody = {
      round_id: 10,
      current_round: 10,
      winner: '',
      prize_amount: '1000',
      claim_deadline: 0,
      status: 'active',
      time_remaining_seconds: 60,
      vault_balance: '100000',
    };
    mockFetch.mockResolvedValue(mockResponse(rawBody));

    const api = new EndGameApi('https://test.api.com', 5000);
    const result = await api.getCurrentRound();

    expect(result).toEqual(rawBody);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0][0] as string)).toContain('/api/game/status');
  });
});

// ── POST Method ─────────────────────────────────────────────────────

describe('API client POST methods', () => {
  it('verifyClaims sends correct payload', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      results: [
        { roundId: 1, claimable: true },
        { roundId: 2, claimable: false, reason: 'Already claimed' },
      ],
    }));

    const api = new EndGameApi('https://test.api.com', 5000);
    const result = await api.verifyClaims([1, 2], 'walletABC');

    const callArgs = mockFetch.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const body = JSON.parse(options.body as string);

    expect(body).toEqual({
      roundIds: [1, 2],
      walletAddress: 'walletABC',
    });
    expect(result).toEqual({
      results: [
        { roundId: 1, claimable: true },
        { roundId: 2, claimable: false, reason: 'Already claimed' },
      ],
    });
  });
});

// ── AbortController / Timeout ───────────────────────────────────────

describe('API client timeout', () => {
  it('passes an AbortSignal to fetch', async () => {
    mockFetch.mockResolvedValue(mockResponse({ round_id: 1, current_round: 1, winner: '', prize_amount: '0', claim_deadline: 0, status: 'active', time_remaining_seconds: 60, vault_balance: '0' }));

    const api = new EndGameApi('https://test.api.com', 5000);
    await api.getGameStatus();

    const callArgs = mockFetch.mock.calls[0];
    const options = callArgs[1] as RequestInit;

    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
