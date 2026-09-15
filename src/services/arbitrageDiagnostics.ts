import type { EconomyOverview, EconomyProvenance } from './poeNinjaClient.js';
import type { ExchangeQuote, ExchangeQuoteBook } from './poe2ExchangeQuotes.js';
import type { ArbitrageCycleResult } from './currencyArbitrage.js';

export interface QuoteReferenceComparison {
  quoteId: string;
  listingId: string;
  from: string;
  to: string;
  /** Both rates are receiving currency units per paid currency unit. */
  unit: string;
  status: 'compared' | 'unknown';
  quoteRate: number | null;
  referenceRate: number | null;
  quoteToReferenceRatio: number | null;
  flagged: boolean | null;
  deviation: 'above-reference' | 'below-reference' | 'within-band' | 'unknown';
  reason: string | null;
}
export interface ArbitrageDiagnostics {
  reference: {
    status: 'available' | 'unknown' | 'disabled';
    reason: string | null;
    primaryCurrency: string | null;
    provenance: EconomyProvenance | null;
    deviationFactor: number;
    role: 'annotation-only aggregate reference';
  };
  quoteComparisons: QuoteReferenceComparison[];
  sharedQuoteDependencies: Array<{
    quoteId: string;
    listingId: string;
    candidateNumbers: number[];
    advertisedStock: number | null;
    stockCurrency: string;
    flaggedByReference: boolean | null;
    quoteToReferenceRatio: number | null;
  }>;
  profitsAdditive: false;
  dependencyScope: 'displayed candidates';
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Add context after cycle evaluation. This function cannot reprice, filter,
 * reorder, aggregate profits or otherwise change the supplied cycle result.
 */
export function buildArbitrageDiagnostics(book: ExchangeQuoteBook, calculation: ArbitrageCycleResult,
  overview?: EconomyOverview, options: { enabled?: boolean; unavailableReason?: string; deviationFactor?: number } = {}): ArbitrageDiagnostics {
  const factor = options.deviationFactor ?? 2;
  if (!Number.isFinite(factor) || factor <= 1) throw new Error('Reference deviation factor must be finite and greater than one');
  let status: ArbitrageDiagnostics['reference']['status'] = options.enabled === false ? 'disabled' : 'unknown';
  let reason: string | null = status === 'disabled' ? 'Reference diagnostic disabled by caller' : options.unavailableReason ?? 'Reference overview unavailable';
  if (status !== 'disabled' && overview) {
    if (overview.provenance?.game !== book.game || overview.provenance?.league !== book.league || overview.provenance?.category !== 'Currency') {
      reason = 'Reference game, league or category does not match the quote book';
    } else if (typeof overview.primaryCurrency !== 'string' || !overview.primaryCurrency) {
      reason = 'Reference primary currency unavailable';
    } else { status = 'available'; reason = null; }
  }
  const primaryValues = new Map<string, number>();
  if (status === 'available' && overview) {
    // core.rates expresses target units per primary unit. All comparisons use
    // this one response; item rows fill currencies not present in core.rates.
    for (const [currency, rate] of Object.entries(overview.rates ?? {})) {
      if (positive(rate) && positive(1 / rate)) primaryValues.set(currency, 1 / rate);
    }
    primaryValues.set(overview.primaryCurrency, 1);
    for (const row of Array.isArray(overview.rows) ? overview.rows : []) {
      if (!primaryValues.has(row.id) && row.primaryCurrency === overview.primaryCurrency && positive(row.primaryValue)) primaryValues.set(row.id, row.primaryValue);
    }
  }
  const candidates = [...calculation.opportunities, ...calculation.residualCandidates];
  const quotes = new Map(book.quotes.map(quote => [quote.id, quote]));
  // Annotate the exact observation used by the reported cycle when a supplied
  // book contains multiple observations of the same quote identity.
  for (const cycle of candidates) for (const step of cycle.steps) quotes.set(step.quote.id, step.quote);
  const compare = (quote: ExchangeQuote): QuoteReferenceComparison => {
    const rate = quote.receiveAmount / quote.payAmount;
    const output: QuoteReferenceComparison = { quoteId: quote.id, listingId: quote.provenance.listingId,
      from: quote.from, to: quote.to, unit: `${quote.to} per ${quote.from}`, status: 'unknown',
      quoteRate: positive(rate) ? rate : null, referenceRate: null, quoteToReferenceRatio: null,
      flagged: null, deviation: 'unknown', reason };
    if (status !== 'available') return output;
    const from = primaryValues.get(quote.from), to = primaryValues.get(quote.to);
    if (!positive(from) || !positive(to)) return { ...output, reason: 'A positive reference valuation is missing for one or both currencies' };
    const referenceRate = from / to, ratio = rate / referenceRate;
    if (!positive(rate) || !positive(referenceRate) || !positive(ratio)) return { ...output, reason: 'Rate comparison is outside finite numeric range' };
    return { ...output, status: 'compared', referenceRate, quoteToReferenceRatio: ratio,
      flagged: ratio > factor || ratio < 1 / factor,
      deviation: ratio > factor ? 'above-reference' : ratio < 1 / factor ? 'below-reference' : 'within-band', reason: null };
  };
  const quoteComparisons = [...quotes.values()].map(compare);
  const comparisons = new Map(quoteComparisons.map(comparison => [comparison.quoteId, comparison]));
  const uses = new Map<string, { quote: ExchangeQuote; candidateNumbers: Set<number> }>();
  candidates.forEach((cycle, index) => {
    for (const step of cycle.steps) {
      const row = uses.get(step.quote.id) ?? { quote: step.quote, candidateNumbers: new Set<number>() };
      row.candidateNumbers.add(index + 1); uses.set(step.quote.id, row);
    }
  });
  return { reference: { status, reason, primaryCurrency: status === 'available' ? overview!.primaryCurrency : null,
    provenance: status === 'available' ? { ...overview!.provenance } : null, deviationFactor: factor,
    role: 'annotation-only aggregate reference' }, quoteComparisons,
    sharedQuoteDependencies: [...uses.values()].filter(row => row.candidateNumbers.size > 1).map(({ quote, candidateNumbers }) => ({
      quoteId: quote.id, listingId: quote.provenance.listingId, candidateNumbers: [...candidateNumbers].sort((a, b) => a - b),
      advertisedStock: quote.stock, stockCurrency: quote.to,
      flaggedByReference: comparisons.get(quote.id)?.flagged ?? null,
      quoteToReferenceRatio: comparisons.get(quote.id)?.quoteToReferenceRatio ?? null,
    })), profitsAdditive: false, dependencyScope: 'displayed candidates' };
}
