import { normalizeExchangeResponse, PoE2BulkExchangeClient } from '../../src/services/poe2ExchangeQuotes';
import { bulkResponse, observedAt } from './poe2ExchangeFixtures';

const scope = { league: 'Forbidden Rites', from: 'divine', to: 'exalted', fetchedAt: observedAt };
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it('maps the actual result dictionary and offer direction, quantities and stock', () => {
  const pair = normalizeExchangeResponse(bulkResponse(), scope);
  expect(pair.quotes[0]).toMatchObject({ game: 'poe2', league: 'Forbidden Rites', from: 'divine', to: 'exalted',
    payAmount: 1, receiveAmount: 240, stock: 2044, fees: null,
    provenance: { queryId: 'query-divine-exalted', listingId: 'listing-id', indexedAt: '2026-09-15T20:58:51+00:00', fetchedAt: observedAt, sourceUpdatedAt: null } });
  expect(JSON.stringify(pair)).not.toMatch(/synthetic-do-not-expose|whisper/);
});

it('preserves an unknown stock as unknown and treats a successful empty book as an empty sample', () => {
  expect(normalizeExchangeResponse(bulkResponse('divine', 'exalted', 1, 240, null), scope).quotes[0].stock).toBeNull();
  expect(normalizeExchangeResponse({ id: 'empty', total: 0, result: {} }, scope).quotes).toEqual([]);
});

it.each([
  (data: any) => { data.result['result-map-key-is-not-listing-id'].listing.offers[0].item.currency = 'chaos'; },
  (data: any) => { data.result['result-map-key-is-not-listing-id'].listing.offers[0].exchange.amount = 0; },
  (data: any) => { data.result['result-map-key-is-not-listing-id'].listing.offers[0].item.stock = -1; },
  (data: any) => { data.result['result-map-key-is-not-listing-id'].listing.account.realm = 'pc'; },
])('rejects malformed, wrong-pair or cross-game quote evidence', mutate => {
  const data = bulkResponse(); mutate(data);
  expect(() => normalizeExchangeResponse(data, scope)).toThrow();
});

it('rejects poe.ninja valuations as an offer source', () => {
  expect(() => normalizeExchangeResponse({ core: { primary: 'divine' }, lines: [{ id: 'exalted', primaryValue: 0.0025 }] }, scope)).toThrow(/exchange|schema/i);
});

it('fetches explicit directional pairs anonymously, caps offers, and preserves cache observation time', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date(observedAt));
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const query = JSON.parse(init!.body as string).query;
    return Response.json(bulkResponse(query.have[0], query.want[0]));
  });
  const client = new PoE2BulkExchangeClient();
  const pending = client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'], maxOffersPerPair: 1 });
  await jest.advanceTimersByTimeAsync(1100);
  const book = await pending;
  expect(book.quotes.map(q => [q.from, q.to])).toEqual([['divine', 'exalted'], ['exalted', 'divine']]);
  expect(request).toHaveBeenCalledTimes(2);
  for (const [url, init] of request.mock.calls) {
    expect(String(url)).toBe('https://www.pathofexile.com/api/trade2/exchange/poe2/Forbidden%20Rites');
    expect(init!.credentials).toBe('omit');
    expect(new Headers(init!.headers).has('Cookie')).toBe(false);
    expect(new Headers(init!.headers).has('Authorization')).toBe(false);
  }
  jest.setSystemTime(Date.parse(observedAt) + 5000);
  const cached = await client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] });
  expect(request).toHaveBeenCalledTimes(2);
  expect(cached.quotes[0].provenance.fetchedAt).toBe(book.quotes[0].provenance.fetchedAt);
});

it('stops immediately on anonymous access rejection, retaining the exact source reason', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 8, message: 'Authentication required' } }, { status: 401 }));
  const client = new PoE2BulkExchangeClient();
  await expect(client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] })).rejects.toThrow(/401.*Authentication required/);
  await expect(client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'chaos'] })).rejects.toThrow(/401.*Authentication required/);
  expect(request).toHaveBeenCalledTimes(1);
});

it('honors Retry-After without retrying another pair', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 3, message: 'Rate limit exceeded' } }, { status: 429, headers: { 'retry-after': '90' } }));
  const client = new PoE2BulkExchangeClient();
  await expect(client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] })).rejects.toThrow(/429/);
  await expect(client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] })).rejects.toThrow(/cooldown/i);
  expect(request).toHaveBeenCalledTimes(1);
});

it('uses a conservative cooldown when a 429 supplies an invalid Retry-After', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'Slow down' } }, { status: 429, headers: { 'retry-after': 'invalid' } }));
  const client = new PoE2BulkExchangeClient();
  await expect(client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] })).rejects.toThrow(/429/);
  await expect(client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] })).rejects.toThrow(/cooldown/i);
  expect(request).toHaveBeenCalledTimes(1);
});

it('respects an exhausted successful-response rate-limit window before the next direction', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date(observedAt));
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const query = JSON.parse(init!.body as string).query;
    return Response.json(bulkResponse(query.have[0], query.want[0]), { headers: {
      'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '1:15:60', 'x-rate-limit-ip-state': '1:15:0',
    } });
  });
  const pending = new PoE2BulkExchangeClient().getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'] });
  await jest.advanceTimersByTimeAsync(14000);
  expect(request).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1100);
  expect((await pending).pairs).toHaveLength(2);
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps all cached offer observations while applying a per-call presentation limit', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date(observedAt));
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const query = JSON.parse(init!.body as string).query;
    const response: any = bulkResponse(query.have[0], query.want[0]);
    response.total = 3;
    response.result.second = structuredClone(response.result['result-map-key-is-not-listing-id']);
    response.result.second.id = 'other-listing';
    return Response.json(response);
  });
  const client = new PoE2BulkExchangeClient();
  const first = client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'], maxOffersPerPair: 1 });
  await jest.advanceTimersByTimeAsync(1100);
  const short = await first;
  expect(short.quotes).toHaveLength(2); expect(short.pairs[0].truncated).toBe(true);
  short.quotes[0].stock = 0;
  const full = await client.getQuoteBook({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'], maxOffersPerPair: 20 });
  expect(full.quotes).toHaveLength(4); expect(full.quotes[0].stock).toBe(2044);
  expect(request).toHaveBeenCalledTimes(2);
});
