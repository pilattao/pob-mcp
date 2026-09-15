/** Public PoE2 bulk offers. These are seller quotations, not exchange fills. */
export interface ExchangeQuote {
  id: string;
  game: 'poe2';
  league: string;
  from: string;
  to: string;
  payAmount: number;
  receiveAmount: number;
  /** Advertised units of the receiving currency; missing stock stays unknown. */
  stock: number | null;
  seller: string | null;
  fees: null;
  provenance: {
    apiUrl: string;
    searchUrl: string;
    queryId: string;
    listingId: string;
    offerIndex: number;
    fetchedAt: string;
    indexedAt: string | null;
    sourceUpdatedAt: null;
  };
}
export interface ExchangePairQuotes {
  from: string;
  to: string;
  queryId: string;
  source: string;
  fetchedAt: string;
  totalListings: number;
  returnedListings: number;
  availableQuotes: number;
  truncated: boolean;
  quotes: ExchangeQuote[];
}
export interface ExchangeQuoteBook {
  game: 'poe2';
  league: string;
  currencies: string[];
  quotes: ExchangeQuote[];
  pairs: ExchangePairQuotes[];
  completedAt: string;
  fees: null;
  fillsVerified: false;
}
export interface QuoteBookOptions { league: string; currencies: string[]; maxOffersPerPair?: number }
export interface BulkExchangeQuoteSource { getQuoteBook(options: QuoteBookOptions): Promise<ExchangeQuoteBook> }

const API = 'https://www.pathofexile.com/api/trade2/exchange/poe2/';
const SITE = 'https://www.pathofexile.com/trade2/exchange/poe2/';
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 1000 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid bulk exchange ${label}`);
  return value;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid bulk exchange ${label}`);
  return value;
}

export function normalizeExchangeResponse(value: unknown, scope: {
  league: string; from: string; to: string; fetchedAt: string;
}): ExchangePairQuotes {
  text(scope.league, 'league'); text(scope.from, 'from currency'); text(scope.to, 'to currency');
  if (scope.from === scope.to || !Number.isFinite(Date.parse(scope.fetchedAt))) throw new Error('Invalid bulk exchange pair or observation time');
  if (!object(value) || !object(value.result) || typeof value.id !== 'string' || !value.id ||
      !Number.isSafeInteger(value.total) || value.total < 0 || value.error) throw new Error('Invalid PoE2 bulk exchange response schema');
  const apiUrl = API + encodeURIComponent(scope.league);
  const searchUrl = SITE + encodeURIComponent(scope.league) + '/' + encodeURIComponent(value.id);
  const quotes: ExchangeQuote[] = [];
  const entries = Object.values(value.result);
  for (const entry of entries) {
    if (!object(entry) || !object(entry.listing) || !Array.isArray(entry.listing.offers)) throw new Error('Invalid bulk exchange listing schema');
    const listingId = text(entry.id, 'listing ID');
    const listing = entry.listing;
    if (listing.account?.realm !== undefined && listing.account.realm !== 'poe2') throw new Error('Bulk exchange quote has the wrong game realm');
    if (entry.item?.league !== undefined && entry.item.league !== scope.league) throw new Error('Bulk exchange quote has the wrong league');
    for (const [offerIndex, offer] of listing.offers.entries()) {
      if (!object(offer) || !object(offer.exchange) || !object(offer.item)) throw new Error('Invalid bulk exchange offer schema');
      if (offer.exchange.currency !== scope.from || offer.item.currency !== scope.to) throw new Error('Bulk exchange offer does not match the requested direction');
      const payAmount = positive(offer.exchange.amount, 'pay amount');
      const receiveAmount = positive(offer.item.amount, 'receive amount');
      if (!Number.isFinite(receiveAmount / payAmount)) throw new Error('Bulk exchange quote price exceeds finite limits');
      const stock = offer.item.stock ?? null;
      if (stock !== null && (!Number.isSafeInteger(stock) || stock < 0)) throw new Error('Invalid bulk exchange output stock');
      quotes.push({ id: `${scope.from}:${scope.to}:${listingId}:${offerIndex}`, game: 'poe2', league: scope.league,
        from: scope.from, to: scope.to, payAmount, receiveAmount, stock,
        seller: typeof listing.account?.name === 'string' ? listing.account.name : null, fees: null,
        provenance: { apiUrl, searchUrl, queryId: value.id, listingId, offerIndex, fetchedAt: scope.fetchedAt,
          indexedAt: typeof listing.indexed === 'string' && Number.isFinite(Date.parse(listing.indexed)) ? listing.indexed : null,
          sourceUpdatedAt: null } });
    }
  }
  // No whisper text, message tokens, authentication or action URLs are retained.
  return { from: scope.from, to: scope.to, queryId: value.id, source: apiUrl, fetchedAt: scope.fetchedAt,
    totalListings: value.total, returnedListings: entries.length, availableQuotes: quotes.length,
    truncated: entries.length < value.total, quotes };
}

export class BulkExchangeRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly source: string,
    readonly apiCode: number | string | null = null, readonly retryAfterMs?: number) { super(message); }
}

/** One persistent instance owns pacing, cooldowns and a short observation cache.
 * No accounts, cookies, retries or trade execution are supported.
 */
export class PoE2BulkExchangeClient implements BulkExchangeQuoteSource {
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private blocked: BulkExchangeRequestError | null = null;
  private cache = new Map<string, { pair: ExchangePairQuotes; expiresAt: number }>();
  private pending = new Map<string, Promise<ExchangePairQuotes>>();

  async getQuoteBook(options: QuoteBookOptions): Promise<ExchangeQuoteBook> {
    text(options.league, 'league');
    if (!Array.isArray(options.currencies) || options.currencies.length < 2 || options.currencies.length > 3 ||
        new Set(options.currencies).size !== options.currencies.length) throw new Error('Choose 2 or 3 distinct native currency IDs');
    for (const currency of options.currencies) {
      text(currency, 'currency ID');
      if (!/^[a-z0-9][a-z0-9_.-]*$/.test(currency)) throw new Error('Use native trade currency IDs such as divine, exalted or chaos');
    }
    const limit = options.maxOffersPerPair ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('maxOffersPerPair must be an integer from 1 to 20');
    const pairs: ExchangePairQuotes[] = [];
    for (const from of options.currencies) for (const to of options.currencies) {
      if (from === to) continue;
      const pair = structuredClone(await this.getPair(options.league, from, to));
      // Compare prices only within the same directional pair, preserving source amounts.
      pair.quotes.sort((a, b) => b.receiveAmount / b.payAmount - a.receiveAmount / a.payAmount);
      pair.truncated ||= pair.quotes.length > limit;
      pair.quotes = pair.quotes.slice(0, limit);
      pairs.push(pair);
    }
    return { game: 'poe2', league: options.league, currencies: [...options.currencies], pairs,
      quotes: pairs.flatMap(pair => pair.quotes), completedAt: new Date(Date.now()).toISOString(), fees: null, fillsVerified: false };
  }

  private async getPair(league: string, from: string, to: string): Promise<ExchangePairQuotes> {
    if (this.blocked) throw this.blocked;
    const key = JSON.stringify([league, from, to]);
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.pair;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.queue.then(() => this.request(league, from, to));
    this.queue = request.then(() => undefined, () => undefined);
    this.pending.set(key, request);
    try {
      const pair = await request;
      this.cache.set(key, { pair, expiresAt: Date.now() + 30000 });
      return pair;
    } finally { this.pending.delete(key); }
  }

  private async request(league: string, from: string, to: string): Promise<ExchangePairQuotes> {
    if (this.blocked) throw this.blocked;
    const url = API + encodeURIComponent(league);
    const wait = this.nextRequestAt - Date.now();
    if (wait > 20000) throw new BulkExchangeRequestError(`Bulk exchange cooldown: retry after ${Math.ceil(wait / 1000)} seconds; no request sent`, null, url, null, wait);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + 1100; // Below one request per second, including parallel callers.
    const response = await fetch(url, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'poe2-mcp-suite/0.1 (+https://github.com/pilattao/poe_mcp_suite)' },
      body: JSON.stringify({ engine: 'new', query: { status: { option: 'online' }, have: [from], want: [to] }, sort: { have: 'asc' } }) });
    const now = Date.now();
    this.updateCooldown(response, now);
    const reader = response.body?.getReader();
    if (!reader) throw new BulkExchangeRequestError('Bulk exchange response has no body', response.status, url);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Bulk exchange response exceeds size limit'); }
      chunks.push(part.value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let data: any;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!response.ok) {
      const detail = typeof data?.error?.message === 'string' ? data.error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) :
        `non-JSON or unrecognized error response${raw.includes('Just a moment...') ? ' (browser challenge)' : ''}`;
      const error = new BulkExchangeRequestError(`PoE2 bulk exchange HTTP ${response.status}: ${detail}`, response.status, url,
        typeof data?.error?.code === 'number' || typeof data?.error?.code === 'string' ? data.error.code : null,
        Math.max(0, this.nextRequestAt - Date.now()));
      if (response.status === 401 || response.status === 403) this.blocked = error;
      throw error;
    }
    return normalizeExchangeResponse(data, { league, from, to, fetchedAt: new Date(now).toISOString() });
  }

  private updateCooldown(response: Response, now: number): void {
    const retry = response.headers.get('retry-after');
    if (retry) {
      const seconds = Number(retry);
      const until = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(retry);
      if (Number.isFinite(until)) this.nextRequestAt = Math.max(this.nextRequestAt, until);
      else if (response.status === 429) this.nextRequestAt = Math.max(this.nextRequestAt, now + 60000);
    } else if (response.status === 429) this.nextRequestAt = Math.max(this.nextRequestAt, now + 60000);
    for (const rule of (response.headers.get('x-rate-limit-rules') ?? 'Ip').split(',').map(value => value.trim())) {
      const limits = response.headers.get(`x-rate-limit-${rule}`)?.split(',') ?? [];
      const states = response.headers.get(`x-rate-limit-${rule}-state`)?.split(',') ?? [];
      limits.forEach((limit, index) => {
        const [count, period] = limit.split(':').map(Number);
        const [used, statePeriod, restricted] = (states[index] ?? '').split(':').map(Number);
        if (count > 0 && period > 0 && Number.isFinite(used) && period === statePeriod) {
          const seconds = Math.max(restricted || 0, used >= count ? period : 0);
          this.nextRequestAt = Math.max(this.nextRequestAt, now + seconds * 1000);
        }
      });
    }
  }
}
