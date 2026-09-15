/** Public poe.ninja economy data. Reference valuations are not executable quotes. */
export interface CurrencyRate {
  currencyTypeName: string;
  chaosEquivalent: number;
  pay?: { value: number; count: number; listing_count: number };
  receive?: { value: number; count: number; listing_count: number };
  detailsId: string;
}

export interface NewCurrencyLine {
  id: string;
  primaryValue: number;
  volumePrimaryValue?: number;
  maxVolumeCurrency?: string;
  maxVolumeRate?: number;
  sparkline?: { totalChange: number; data: Array<number | null> };
}

export interface NewCurrencyItem {
  id: string;
  name: string;
  image: string;
  category: string;
  detailsId: string;
}

export interface NewCurrencyOverview {
  core: {
    items: NewCurrencyItem[];
    /** Units of the target currency per one core.primary. */
    rates: Record<string, number>;
    primary: string;
    secondary: string;
  };
  lines: NewCurrencyLine[];
  items: NewCurrencyItem[];
}

export interface CurrencyOverview {
  lines: CurrencyRate[];
  currencyDetails: Array<{ id: number; name: string; tradeId?: string }>;
}

export interface ArbitrageOpportunity {
  chain: string[];
  profitPercent: number;
  startAmount: number;
  endAmount: number;
  steps: Array<{ from: string; to: string; rate: number; amount: number }>;
}

export type EconomyGame = 'poe1' | 'poe2';
export interface EconomyProvenance {
  game: EconomyGame;
  league: string;
  category: string;
  source: string;
  fetchedAt: string;
  checkedAt: string;
  cacheAgeSeconds: number;
  // HTTP Date / Last-Modified / Age describe the representation, not its market snapshot.
  sourceUpdatedAt: null;
  sourceAgeSeconds: null;
  httpLastModified: string | null;
}

export interface EconomyRow {
  id: string;
  name: string;
  primaryCurrency: string;
  primaryValue: number;
  values: Record<string, number>;
  sourceKind: 'exchange-valuation' | 'stash-estimate' | 'core-reference';
  detailsId?: string;
  itemId?: string;
  baseType?: string;
  variant?: string;
  corrupted?: boolean;
  listingCount?: number;
  levelRequired?: number;
  volumePrimaryValue?: number;
  trend7d?: number;
}

export interface EconomyOverview {
  rows: EconomyRow[];
  primaryCurrency: string;
  rates: Record<string, number>;
  provenance: EconomyProvenance;
  quoteEvidence: 'missing-directional-quotes';
}

export interface ItemPriceOptions {
  /** Exact API category; omit for a bounded sequential search that stops on an exact name. */
  category?: string;
  baseType?: string;
  variant?: string;
  corrupted?: boolean;
  detailsId?: string;
}

export interface ItemPriceMatch extends EconomyRow {
  chaosValue: number | null;
  divineValue: number | null;
  exaltedValue: number | null;
  provenance: EconomyProvenance;
}

export interface ItemPriceResult {
  game: EconomyGame;
  league: string;
  query: string;
  status: 'priced' | 'ambiguous' | 'not-found';
  /** Set only when one exact item/variant matches. Values are estimates, not offers. */
  price: ItemPriceMatch | null;
  matches: ItemPriceMatch[];
  searchedCategories: string[];
  sources: EconomyProvenance[];
  quoteEvidence: 'missing-directional-quotes';
}

export type CurrencyExchangeOverview = NewCurrencyOverview & { provenance: EconomyProvenance };

type JsonObject = Record<string, unknown>;
interface CacheEntry {
  data: unknown;
  fetchedAt: number;
  checkedAt: number;
  expiresAt: number;
  etag: string | null;
  lastModified: string | null;
  cacheControl: string;
}

const POE2_EXCHANGE = ['Currency', 'Fragments', 'Abyss', 'UncutGems', 'LineageSupportGems',
  'Essences', 'SoulCores', 'Idols', 'Runes', 'Ritual', 'Expedition', 'Delirium', 'Breach', 'Verisium'];
const POE2_STASH = ['UniqueWeapons', 'UniqueArmours', 'UniqueAccessories', 'UniqueFlasks',
  'UniqueCharms', 'UniqueJewels', 'UniqueSanctumRelics', 'UniqueTablets', 'PrecursorTablets'];
const CACHE_TTL = 300000;

/** Add known trade aliases to an already chaos-denominated map; never guess a rate.
 * Optional source metadata maps additional native currency ids without guessing slugs.
 */
export function withCurrencyAliases(rates: ReadonlyMap<string, number>,
  currencies: ReadonlyArray<{ id: string; name: string }> = []): Map<string, number> {
  const aliases: Record<string, string[]> = {
    'Divine Orb': ['divine', 'div'], 'Chaos Orb': ['chaos', 'c'],
    'Exalted Orb': ['exalted', 'exa', 'ex'], 'Mirror of Kalandra': ['mirror'],
    'Orb of Alchemy': ['alchemy', 'alch'], 'Regal Orb': ['regal'],
    'Orb of Annulment': ['annul'], 'Orb of Chance': ['chance'],
    'Vaal Orb': ['vaal'], 'Gemcutter\'s Prism': ['gcp'],
    'Orb of Fusing': ['fusing', 'fuse'], 'Orb of Regret': ['regret'],
    'Chromatic Orb': ['chrome', 'chromatic'], 'Jeweller\'s Orb': ['jewellers', 'jew'],
    'Orb of Alteration': ['alt', 'alteration'], 'Cartographer\'s Chisel': ['chisel'],
    'Blessed Orb': ['blessed'], 'Orb of Scouring': ['scouring', 'scour'],
  };
  const result = new Map<string, number>();
  for (const [currency, value] of rates) {
    if (!Number.isFinite(value) || value <= 0) continue;
    result.set(currency, value);
    result.set(currency.toLowerCase(), value);
    for (const alias of aliases[currency] ?? []) result.set(alias, value);
  }
  for (const currency of currencies) {
    const value = rates.get(currency.name);
    if (value !== undefined && Number.isFinite(value) && value > 0) result.set(currency.id, value);
  }
  return result;
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid economy schema: ${field}`);
  return value as JsonObject;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid economy schema: ${field}`);
  return value;
}
function name(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing economy metadata: ${field}`);
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid economy price/rate: ${field}`);
  return value;
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return name(value, 'id');
}

/** An instance is fixed to one game. A failed PoE2 request never queries PoE1. */
export class PoeNinjaClient {
  readonly game: EconomyGame;
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<CacheEntry>>();
  private retryAt = 0;

  constructor(options: { game?: EconomyGame } = {}) {
    const game = options.game ?? process.env.POE_GAME ?? 'poe2';
    if (game !== 'poe1' && game !== 'poe2') throw new Error(`Unknown economy game: ${game}`);
    this.game = game;
  }

  async getCurrencyRates(league: string): Promise<CurrencyExchangeOverview> {
    return this.exchange(league, 'Currency');
  }

  async getFragmentRates(league: string): Promise<CurrencyExchangeOverview> {
    return this.exchange(league, this.game === 'poe2' ? 'Fragments' : 'Fragment');
  }

  /** Values remain chaos per unit for existing trade/shopping consumers. */
  async getCurrencyExchangeMap(league: string): Promise<Map<string, number>> {
    const overview = await this.getEconomyOverview(league);
    if (!(overview.rates.chaos > 0)) throw new Error('Missing chaos conversion in this economy response');
    const result = new Map<string, number>();
    for (const row of overview.rows) {
      if (row.values.chaos > 0) result.set(row.name, row.id === 'chaos' ? 1 : row.values.chaos);
    }
    return result;
  }

  /** One explicit category per request; stash variants remain separate rows. */
  async getEconomyOverview(league: string, category = 'Currency'): Promise<EconomyOverview> {
    const { data, provenance, family } = await this.overview(league, category);
    return { ...this.normalize(data, category, family), provenance, quoteEvidence: 'missing-directional-quotes' };
  }

  /** Named currency/unique/category estimate, preserving variants and per-response units. */
  async getItemPrice(league: string, itemName: string, options: ItemPriceOptions = {}): Promise<ItemPriceResult> {
    if (typeof itemName !== 'string' || !itemName.trim()) throw new Error('Supply a nonempty item name');
    for (const field of ['category', 'baseType', 'variant', 'detailsId'] as const) {
      if (options[field] !== undefined && typeof options[field] !== 'string') throw new Error(`Invalid item price filter: ${field}`);
    }
    if (options.corrupted !== undefined && typeof options.corrupted !== 'boolean') throw new Error('Invalid corrupted filter');
    const categories = options.category !== undefined ? [options.category] : this.game === 'poe2' ?
      ['Currency', 'UniqueAccessories', ...POE2_STASH.filter(category => category !== 'UniqueAccessories'),
        ...POE2_EXCHANGE.filter(category => category !== 'Currency')] : ['Currency', 'Fragment'];
    const sources: EconomyProvenance[] = [];
    const searchedCategories: string[] = [];
    let matches: ItemPriceMatch[] = [];
    const query = itemName.trim();
    for (const category of categories) {
      const data = await this.getEconomyOverview(league, category);
      sources.push(data.provenance);
      searchedCategories.push(category);
      const named = data.rows.filter(row => row.name.toLowerCase() === query.toLowerCase());
      matches = named.filter(row =>
        (['baseType', 'variant', 'corrupted', 'detailsId'] as const).every(field =>
          options[field] === undefined || row[field] === options[field]))
        .map(row => ({ ...row, chaosValue: row.values.chaos ?? null,
          divineValue: row.values.divine ?? null, exaltedValue: row.values.exalted ?? null, provenance: data.provenance }));
      // Search every variant in the matched category; no fuzzy substitution or cross-category minimum.
      if (named.length) break;
    }
    return { game: this.game, league, query,
      status: matches.length === 1 ? 'priced' : matches.length ? 'ambiguous' : 'not-found',
      price: matches.length === 1 ? matches[0] : null, matches, searchedCategories, sources,
      quoteEvidence: 'missing-directional-quotes' };
  }

  /** Compatibility result. The supported overview source supplies no bid/ask evidence. */
  async findArbitrageOpportunities(league: string, minProfitPercent = 1): Promise<ArbitrageOpportunity[]> {
    if (!Number.isFinite(minProfitPercent)) throw new Error('Minimum profit must be finite');
    await this.getEconomyOverview(league); // Validate source availability instead of claiming an empty successful scan.
    return [];
  }

  clearCache(): void { this.cache.clear(); }

  private async exchange(league: string, category: string): Promise<CurrencyExchangeOverview> {
    const { data, provenance } = await this.overview(league, category);
    return { ...data, items: data.items ?? [], provenance } as unknown as CurrencyExchangeOverview;
  }

  private async overview(league: string, category: string): Promise<{
    data: JsonObject; provenance: EconomyProvenance; family: 'exchange' | 'stash';
  }> {
    if (typeof league !== 'string' || !league.trim() || league !== league.trim()) throw new Error('Supply an exact economy league');
    const exchangeTypes = this.game === 'poe2' ? POE2_EXCHANGE : ['Currency', 'Fragment'];
    const family = exchangeTypes.includes(category) ? 'exchange' :
      this.game === 'poe2' && POE2_STASH.includes(category) ? 'stash' : null;
    if (!family) throw new Error(`Unsupported ${this.game} economy category: ${category}`);
    const base = `https://poe.ninja/${this.game}/api/economy`;
    const leagues = await this.request(`${base}/leagues`, value => {
      for (const league of array(value, 'leagues')) name(object(league, 'league').id, 'league.id');
    });
    if (!(leagues.data as JsonObject[]).some(entry => entry.id === league)) throw new Error(`Unknown ${this.game} economy league: ${league}`);
    const tail = family === 'exchange' ? 'exchange/current/overview' : 'stash/current/item/overview';
    const url = `${base}/${tail}?league=${encodeURIComponent(league)}&type=${encodeURIComponent(category)}`;
    const entry = await this.request(url, value => { this.normalize(value, category, family); });
    const provenance: EconomyProvenance = {
      game: this.game, league, category, source: url,
      fetchedAt: new Date(entry.fetchedAt).toISOString(), checkedAt: new Date(entry.checkedAt).toISOString(),
      cacheAgeSeconds: Math.max(0, (Date.now() - entry.fetchedAt) / 1000),
      sourceUpdatedAt: null, sourceAgeSeconds: null, httpLastModified: entry.lastModified,
    };
    return { data: object(entry.data, 'overview'), provenance, family };
  }

  private normalize(value: unknown, category: string, family: 'exchange' | 'stash') {
    const data = object(value, 'overview');
    const core = object(data.core, 'core');
    const primary = name(core.primary, 'core.primary');
    const rates: Record<string, number> = {};
    for (const [currency, rate] of Object.entries(object(core.rates, 'core.rates'))) {
      const valid = number(rate, `core.rates.${currency}`);
      if (valid > 0) rates[currency] = valid;
    }
    rates[primary] = 1;
    const items = new Map<string, JsonObject>();
    for (const raw of [...array(data.items ?? [], 'items'), ...array(core.items, 'core.items')]) {
      const item = object(raw, 'item');
      name(item.name, 'item.name');
      items.set(id(item.id), item);
    }
    const makeRow = (line: JsonObject, sourceKind: EconomyRow['sourceKind']): EconomyRow => {
      const itemId = id(line.id);
      const metadata = family === 'stash' ? line : items.get(itemId);
      const primaryValue = number(line.primaryValue, 'primaryValue');
      const values: Record<string, number> = {};
      for (const [currency, rate] of Object.entries(rates)) values[currency] = number(primaryValue * rate, `converted ${currency}`);
      const row: EconomyRow = { id: itemId, name: name(metadata?.name, 'line item name'),
        primaryCurrency: primary, primaryValue, values, sourceKind };
      for (const field of ['detailsId', 'itemId', 'baseType', 'variant'] as const) {
        const fieldValue = line[field] ?? metadata?.[field];
        if (typeof fieldValue === 'string') row[field] = fieldValue;
      }
      if (typeof line.corrupted === 'boolean') row.corrupted = line.corrupted;
      for (const field of ['listingCount', 'levelRequired', 'volumePrimaryValue'] as const) {
        if (line[field] !== undefined) row[field] = number(line[field], field);
      }
      const trend = line.sparkline ?? line.sparkLine;
      if (trend && typeof trend === 'object') {
        const change = (trend as JsonObject).totalChange;
        if (typeof change === 'number' && Number.isFinite(change)) row.trend7d = change;
      }
      return row;
    };
    const rows = array(data.lines, 'lines').map(line => makeRow(object(line, 'line'), family === 'stash' ? 'stash-estimate' : 'exchange-valuation'));
    // The primary reference often exists only in core.items, not the exchange lines.
    if (category === 'Currency' && rows.length && items.has(primary) && !rows.some(row => row.id === primary)) {
      rows.push(makeRow({ id: primary, primaryValue: 1 }, 'core-reference'));
    }
    return { rows, primaryCurrency: primary, rates };
  }

  private async request(url: string, validate: (data: unknown) => void): Promise<CacheEntry> {
    const cached = this.cache.get(url);
    if (cached && Date.now() < cached.expiresAt) return cached;
    const existing = this.pending.get(url);
    if (existing) return existing;
    if (Date.now() < this.retryAt) throw new Error('poe.ninja rate limited (429); wait for Retry-After');
    const pending = (async () => {
      const headers: Record<string, string> = { 'User-Agent': 'pob-mcp-server/1.0 (public economy client)' };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: 'error' });
      const now = Date.now();
      const cacheControl = response.headers.get('cache-control') ?? (response.status === 304 ? cached?.cacheControl : '') ?? '';
      const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
      const age = Math.max(0, Number(response.headers.get('age')) || 0);
      const ttl = /\bno-cache\b/i.test(cacheControl) ? 0 : maxAge ?
        Math.max(0, Math.min(CACHE_TTL, (Number(maxAge[1]) - age) * 1000)) : CACHE_TTL;
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        this.retryAt = Math.max(now + 1000, seconds !== null ? now + seconds * 1000 : Date.parse(retry ?? '') || now + 60000);
      }
      if (response.status === 304 && cached) {
        const entry = { ...cached, checkedAt: now, expiresAt: now + ttl, cacheControl,
          etag: response.headers.get('etag') ?? cached.etag,
          lastModified: response.headers.get('last-modified') ?? cached.lastModified };
        if (/\bno-store\b/i.test(cacheControl)) this.cache.delete(url); else this.cache.set(url, entry);
        return entry;
      }
      if (!response.ok) throw new Error(`poe.ninja ${this.game} economy request failed (${response.status})`);
      const data: unknown = await response.json();
      validate(data); // Malformed or cross-game responses are never successful cache entries.
      const entry: CacheEntry = { data, fetchedAt: now, checkedAt: now, expiresAt: now + ttl, cacheControl,
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
      if (/\bno-store\b/i.test(cacheControl)) this.cache.delete(url); else this.cache.set(url, entry);
      return entry;
    })();
    this.pending.set(url, pending);
    try { return await pending; } finally { this.pending.delete(url); }
  }
}
