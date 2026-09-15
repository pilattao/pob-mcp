import type { ExchangeQuote, ExchangeQuoteBook } from './poe2ExchangeQuotes.js';

export interface ArbitrageCycleOptions {
  startCurrency: string;
  /** Available whole currency units; actual deployed capital is reported separately. */
  startAmount: number;
  minProfitPercent?: number;
  maxSteps?: 2 | 3;
  maxResults?: number;
  maxQuoteAgeSeconds?: number;
  maxScenarios?: number;
  /** Observation cutoff, useful when auditing a saved quote book. Defaults to now. */
  now?: number;
}
export interface QuotedCycle {
  currencies: string[];
  startCurrency: string;
  grossProfitCurrency: string;
  availableStartAmount: number;
  unusedStartAmount: number;
  startAmount: number;
  endAmount: number;
  grossProfit: number;
  grossProfitPercent: number;
  gainType: 'starting-currency' | 'unvalued-residual';
  meetsRequestedProfitPercent: true | null;
  netProfit: null;
  fees: null;
  fillsGuaranteed: false;
  leftovers: Array<{ currency: string; amount: number }>;
  steps: Array<{ from: string; to: string; paid: number; received: number; quote: ExchangeQuote }>;
}
export interface ArbitrageCycleResult {
  opportunities: QuotedCycle[];
  residualCandidates: QuotedCycle[];
  totalOpportunities: number;
  candidatePaths: number;
  sizingScenarios: number;
  excludedQuotes: number;
  searchComplete: boolean;
  marketExhaustive: false;
  opportunitiesAreAlternatives: true;
  sizingModel: string;
  warnings: string[];
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function fraction(value: number): [bigint, bigint] {
  const [coefficient, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, decimal = ''] = coefficient.split('.');
  const shift = Number(exponent) - decimal.length;
  const numerator = BigInt(whole + decimal);
  if (shift >= 0) return [numerator * 10n ** BigInt(shift), 1n];
  const denominator = 10n ** BigInt(-shift), divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}
function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }
function lot(quote: ExchangeQuote): { pay: bigint; receive: bigint } {
  const [a, ad] = fraction(quote.payAmount), [b, bd] = fraction(quote.receiveAmount);
  const scale = ad / gcd(ad, bd) * bd;
  return { pay: a * (scale / ad), receive: b * (scale / bd) };
}
const min = (a: bigint, b: bigint) => a < b ? a : b;
function integer(value: number, label: string, low: number, high: number): void {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new Error(`${label} must be an integer from ${low} to ${high}`);
}

/** Detect gross-positive cycles within the supplied directional quote sample.
 * Whole lot sizing, stock, freshness and residual currencies are explicit. No
 * reverse quote, fee, fill, resale valuation or portfolio profit is inferred.
 */
export function findArbitrageCycles(book: ExchangeQuoteBook, options: ArbitrageCycleOptions): ArbitrageCycleResult {
  if (book.game !== 'poe2' || !book.league) throw new Error('A single explicit PoE2 league is required');
  if (!book.currencies.includes(options.startCurrency)) throw new Error('Starting currency must be in the quote book');
  integer(options.startAmount, 'Starting amount', 1, Number.MAX_SAFE_INTEGER);
  const maxSteps = options.maxSteps ?? 3, maxResults = options.maxResults ?? 20, maxScenarios = options.maxScenarios ?? 100000;
  integer(maxSteps, 'maxSteps', 2, 3); integer(maxResults, 'maxResults', 1, 20); integer(maxScenarios, 'maxScenarios', 1, 100000);
  const threshold = options.minProfitPercent ?? 1, maxAge = options.maxQuoteAgeSeconds ?? 300, now = options.now ?? Date.now();
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('Minimum profit must be finite and nonnegative');
  if (!Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(now)) throw new Error('Invalid quote observation age/cutoff');
  const [thresholdNumerator, thresholdDenominator] = fraction(threshold);
  const byCurrency = new Map<string, Array<{ quote: ExchangeQuote; pay: bigint; receive: bigint }>>();
  const result: ArbitrageCycleResult = { opportunities: [], residualCandidates: [], totalOpportunities: 0,
    candidatePaths: 0, sizingScenarios: 0, excludedQuotes: 0,
    searchComplete: true, marketExhaustive: false, opportunitiesAreAlternatives: true,
    sizingModel: 'Whole multiples of supplied quote amounts, scaled to whole currency units. Intermediate leftovers are not valued.',
    warnings: ['Seller stock and quotes are observations, not guaranteed fills; observations may have different timestamps.',
      'Fees, gold costs, additional seller minimums and execution costs are unknown. Net profit is unavailable.',
      'Candidates are alternatives that may share quoted inventory; their profits cannot be added together.'] };
  const seen = new Set<string>();
  for (const quote of book.quotes) {
    if (quote.game !== book.game || quote.league !== book.league) throw new Error('Quote game/league does not match the book');
    if (!book.currencies.includes(quote.from) || !book.currencies.includes(quote.to) || quote.from === quote.to) throw new Error('Invalid quote currency pair');
    if (![quote.payAmount, quote.receiveAmount].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new Error('Invalid quote amount/price');
    if (quote.stock !== null && (!Number.isSafeInteger(quote.stock) || quote.stock < 0)) throw new Error('Invalid quote stock');
    const age = (now - Date.parse(quote.provenance.fetchedAt)) / 1000;
    if (seen.has(quote.id) || quote.stock === null || quote.stock === 0 || !Number.isFinite(age) || age < 0 || age > maxAge) {
      result.excludedQuotes++; continue;
    }
    seen.add(quote.id);
    const row = { quote, ...lot(quote) };
    const list = byCurrency.get(quote.from) ?? [];
    list.push(row); byCurrency.set(quote.from, list);
  }
  for (const edges of byCurrency.values()) edges.sort((a, b) => b.quote.receiveAmount / b.quote.payAmount - a.quote.receiveAmount / a.quote.payAmount);
  type Edge = NonNullable<ReturnType<typeof byCurrency.get>>[number];
  const budget = BigInt(options.startAmount);

  const evaluate = (path: Edge[]) => {
    result.candidatePaths++;
    // Exact arithmetic avoids floating-point "arbitrage" around a product of 1.
    if (path.reduce((value, edge) => value * edge.receive, 1n) <= path.reduce((value, edge) => value * edge.pay, 1n)) return;
    const first = path[0];
    const maximumLots = min(budget / first.pay, BigInt(first.quote.stock!) / first.receive);
    let best: QuotedCycle | undefined;
    let residual: QuotedCycle | undefined;
    for (let firstLots = 1n; firstLots <= maximumLots; firstLots++) {
      if (result.sizingScenarios >= maxScenarios) { result.searchComplete = false; break; }
      result.sizingScenarios++;
      const deployed = firstLots * first.pay;
      let current = deployed;
      const steps: QuotedCycle['steps'] = [], leftovers: QuotedCycle['leftovers'] = [];
      for (const edge of path) {
        const count = min(current / edge.pay, BigInt(edge.quote.stock!) / edge.receive);
        if (!count) { current = 0n; break; }
        const paid = count * edge.pay, received = count * edge.receive;
        if (received > MAX) { current = 0n; break; }
        if (current > paid) leftovers.push({ currency: edge.quote.from, amount: Number(current - paid) });
        steps.push({ from: edge.quote.from, to: edge.quote.to, paid: Number(paid), received: Number(received), quote: edge.quote });
        current = received;
      }
      const profit = current - deployed;
      if (steps.length !== path.length || profit < 0n) continue;
      const onlyResidue = profit === 0n && leftovers.length > 0;
      if (!onlyResidue && (profit === 0n || profit * 100n * thresholdDenominator < deployed * thresholdNumerator)) continue;
      const candidate: QuotedCycle = { currencies: [options.startCurrency, ...path.map(edge => edge.quote.to)],
        startCurrency: options.startCurrency, grossProfitCurrency: options.startCurrency,
        availableStartAmount: options.startAmount, unusedStartAmount: Number(budget - deployed),
        startAmount: Number(deployed), endAmount: Number(current), grossProfit: Number(profit),
        grossProfitPercent: Number(profit) / Number(deployed) * 100,
        gainType: onlyResidue ? 'unvalued-residual' : 'starting-currency', meetsRequestedProfitPercent: onlyResidue ? null : true,
        netProfit: null, fees: null, fillsGuaranteed: false, steps, leftovers };
      // Recovering the principal plus another currency is useful evidence, but
      // no percentage valuation for the residue is invented to pass the filter.
      if (onlyResidue) { residual ??= candidate; continue; }
      if (!best || candidate.grossProfit > best.grossProfit ||
          (candidate.grossProfit === best.grossProfit && candidate.grossProfitPercent > best.grossProfitPercent)) best = candidate;
    }
    if (best) result.opportunities.push(best);
    else if (residual) result.residualCandidates.push(residual);
  };
  const visit = (currency: string, path: Edge[], visited: Set<string>) => {
    for (const edge of byCurrency.get(currency) ?? []) {
      if (!result.searchComplete) return;
      if (edge.quote.to === options.startCurrency) {
        if (path.length) evaluate([...path, edge]);
      } else if (path.length + 1 < maxSteps && !visited.has(edge.quote.to)) {
        visit(edge.quote.to, [...path, edge], new Set([...visited, edge.quote.to]));
      }
    }
  };
  visit(options.startCurrency, [], new Set([options.startCurrency]));
  result.opportunities.sort((a, b) => b.grossProfit - a.grossProfit || b.grossProfitPercent - a.grossProfitPercent);
  result.totalOpportunities = result.opportunities.length;
  result.opportunities = result.opportunities.slice(0, maxResults);
  result.residualCandidates = result.residualCandidates.slice(0, Math.max(0, maxResults - result.opportunities.length));
  if (!result.searchComplete) result.warnings.push('The sizing-scenario budget was reached; further cycles or profitable quantities may exist.');
  if (book.pairs.some(pair => pair.truncated)) result.warnings.push('Only a bounded subset of available listings/offers was supplied.');
  return result;
}
