import type { TradeGame } from './tradeClient.js';
import type { TradeQuery } from '../types/tradeTypes.js';

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate before JSON serialization can replace non-finite numbers with null. */
function finiteTree(value: unknown, path: string, seen = new Set<object>()): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} must be finite`);
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${path} contains a circular value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) finiteTree(child, `${path}.${key}`, seen);
  if (object(value)) {
    for (const key of ['min', 'max', 'weight']) {
      if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
        throw new Error(`${path}.${key} must be finite`);
      }
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) throw new Error(`${path}: min exceeds max`);
  }
  seen.delete(value);
}

export function validateWeightedTradeOptions(options?: Record<string, unknown>): void {
  if (options === undefined) return;
  if (!object(options)) throw new Error('Weighted search options must be an object');
  finiteTree(options, 'options');
  for (const key of ['maxPrice', 'maxLevel', 'sockets']) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`options.${key} must be finite and nonnegative`);
    }
  }
}

/** Preserve native weights, bounds, disabled flags, filters, engine and sort.
 * Only equivalent wire encodings and a disclosed missing-status default are changed.
 * Unknown metadata remains an error in TradeApiClient; filters are never dropped to retry.
 */
export function prepareWeightedTradeQuery(value: unknown, game: TradeGame): {
  query: TradeQuery; weightedMods: number; changes: string[];
} {
  if (!object(value) || !object(value.query)) throw new Error('PoB returned no valid weighted query object');
  finiteTree(value, 'PoB query');
  const copy = structuredClone(value);
  const query = copy.query;
  if (!Array.isArray(query.stats)) throw new Error('PoB query requires active nonzero weighted stats');
  let weightedMods = 0;
  for (const group of query.stats) {
    if (!object(group) || !Array.isArray(group.filters)) throw new Error('Invalid weighted query stat group');
    for (const filter of group.filters) {
      if (!object(filter) || typeof filter.id !== 'string') throw new Error('Invalid weighted query stat filter');
      if (group.type !== 'weight') continue;
      if (!object(filter.value) || typeof filter.value.weight !== 'number') throw new Error('Stat weight must be finite');
      if (!group.disabled && !filter.disabled && filter.value.weight !== 0) weightedMods++;
    }
  }
  if (!weightedMods) throw new Error('PoB query requires active nonzero weighted stats');
  const changes: string[] = [];
  const status = query.status;
  if (status === undefined || (Array.isArray(status) && !status.length) ||
      (object(status) && !Object.keys(status).length)) {
    query.status = { option: 'online' };
    changes.push('PoB supplied no online status; defaulted to online.');
  }
  if (game === 'poe2') {
    const trade = query.filters?.trade_filters?.filters;
    if (trade?.sale_type?.option === 'priced') {
      delete trade.sale_type;
      changes.push('Legacy sale_type=priced mapped to the omitted PoE2 buyout/fixed-price default.');
    }
    const misc = query.filters?.misc_filters?.filters;
    if (object(misc)) {
      for (const [key, entry] of Object.entries(misc)) {
        if (typeof entry === 'boolean') {
          misc[key] = { option: String(entry) };
          changes.push(`Native ${key}=${entry} encoded as its PoE2 boolean option.`);
        }
      }
    }
  }
  // TradeQuery currently omits value.weight and statgroup sort keys. The original
  // native fields remain present at runtime; the schema owner can extend the type.
  return { query: copy as TradeQuery, weightedMods, changes };
}
