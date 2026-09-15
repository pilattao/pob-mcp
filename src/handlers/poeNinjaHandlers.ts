import { wrapHandler } from '../utils/errorHandling.js';
import { PoeNinjaClient, type EconomyOverview } from '../services/poeNinjaClient.js';
import type { BulkExchangeQuoteSource } from '../services/poe2ExchangeQuotes.js';
import { findArbitrageCycles } from '../services/currencyArbitrage.js';
import { buildArbitrageDiagnostics } from '../services/arbitrageDiagnostics.js';

interface PoeNinjaContext { ninjaClient: PoeNinjaClient; exchangeClient?: BulkExchangeQuoteSource }
type TextResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
const result = (text: string): TextResult => ({ content: [{ type: 'text', text }] });

function sourceSummary(data: EconomyOverview): string {
  const source = data.provenance;
  return `Game: ${source.game}\nLeague: ${source.league}\nPrimary currency: ${data.primaryCurrency}\n` +
    `Source: ${source.source}\nFetched: ${source.fetchedAt}\n` +
    `Retrieval age: ${source.cacheAgeSeconds.toFixed(0)} seconds\n` +
    `Source snapshot age: unknown (no market snapshot timestamp supplied)\n`;
}

export async function handleGetCurrencyRates(context: PoeNinjaContext, args: { league: string }): Promise<TextResult> {
  return wrapHandler('get currency rates', async () => {
    const data = await context.ninjaClient.getEconomyOverview(args.league);
    let output = `=== Currency Reference Valuations ===\n${sourceSummary(data)}\n`;
    for (const row of [...data.rows].sort((a, b) => b.primaryValue - a.primaryValue)) {
      output += `${row.name}: ${row.primaryValue.toPrecision(6)} ${row.primaryCurrency}`;
      if (row.primaryCurrency !== 'chaos' && row.values.chaos !== undefined) output += `; ${row.values.chaos.toPrecision(6)} chaos equivalent`;
      output += '\n';
    }
    output += `\nTotal currencies: ${data.rows.length}\n`;
    if (!data.rows.length) output += 'No priced currency rows supplied by this source.\n';
    output += 'Aggregate reference valuations; missing directional buy/sell quotes, executable quantities and fill evidence.\n';
    return result(output);
  });
}

export interface FindArbitrageArgs {
  league: string;
  min_profit_percent?: number;
  currencies?: string[];
  start_currency?: string;
  start_amount?: number;
  max_steps?: 2 | 3;
  max_quotes_per_pair?: number;
  reference_diagnostic?: boolean;
}

export async function handleFindArbitrage(context: PoeNinjaContext, args: FindArbitrageArgs): Promise<TextResult> {
  return wrapHandler('find arbitrage', async () => {
    if (!context.exchangeClient) throw new Error('Bulk exchange quote source is not configured');
    if (context.ninjaClient.game === 'poe1') throw new Error('This bulk quote arbitrage service requires PoE2');
    if (args.reference_diagnostic !== undefined && typeof args.reference_diagnostic !== 'boolean') throw new Error('reference_diagnostic must be a boolean');
    const threshold = args.min_profit_percent ?? 1;
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error('Minimum gross profit must be finite and nonnegative');
    const currencies = args.currencies ?? ['divine', 'exalted', 'chaos'];
    if (args.currencies === null || !Array.isArray(currencies) || currencies.length < 2 || currencies.length > 3 ||
        new Set(currencies).size !== currencies.length || currencies.some(currency => typeof currency !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(currency))) {
      throw new Error('currencies must contain 2 or 3 distinct native currency IDs');
    }
    const startCurrency = args.start_currency ?? currencies[0];
    const startAmount = args.start_amount ?? 1, maxSteps = args.max_steps ?? 3;
    if (!Number.isSafeInteger(startAmount) || startAmount <= 0) throw new Error('start_amount must be positive whole currency units');
    if (maxSteps !== 2 && maxSteps !== 3) throw new Error('max_steps must be 2 or 3');
    if (!currencies.includes(startCurrency)) throw new Error('start_currency must be in currencies');
    const maxOffersPerPair = args.max_quotes_per_pair ?? 10;
    if (!Number.isInteger(maxOffersPerPair) || maxOffersPerPair < 1 || maxOffersPerPair > 20) throw new Error('max_quotes_per_pair must be an integer from 1 to 20');
    const book = await context.exchangeClient.getQuoteBook({ league: args.league, currencies, maxOffersPerPair });
    if (book.league !== args.league || book.game !== 'poe2') throw new Error('Quote book does not match the requested league/game');
    if (book.currencies.length !== currencies.length || book.currencies.some(currency => !currencies.includes(currency))) throw new Error('Quote book does not match the requested currencies');
    const calculation = findArbitrageCycles(book, { startCurrency, startAmount, minProfitPercent: threshold, maxSteps });
    // Optional contextual evidence comes after the quote-only calculation. A
    // missing aggregate source never removes or reprices a quoted candidate.
    let reference: EconomyOverview | undefined;
    let unavailableReason: string | undefined;
    if (args.reference_diagnostic !== false) {
      try { reference = await context.ninjaClient.getEconomyOverview(args.league, 'Currency'); }
      catch (error) {
        unavailableReason = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
      }
    }
    const diagnostics = buildArbitrageDiagnostics(book, calculation, reference, {
      enabled: args.reference_diagnostic !== false, unavailableReason,
    });
    const comparisons = new Map(diagnostics.quoteComparisons.map(comparison => [comparison.quoteId, comparison]));
    const candidateQuoteIds = new Set([...calculation.opportunities, ...calculation.residualCandidates].flatMap(cycle => cycle.steps.map(step => step.quote.id)));
    const formatRate = (value: number) => value.toLocaleString('en-US', { maximumSignificantDigits: 6, useGrouping: false });
    const pairs = book.pairs.map(pair => ({ from: pair.from, to: pair.to, queryId: pair.queryId, source: pair.source,
      fetchedAt: pair.fetchedAt, totalListings: pair.totalListings, returnedListings: pair.returnedListings,
      usedQuotes: pair.quotes.length, truncated: pair.truncated }));
    const lines = ['=== PoE2 Quoted Currency Cycles ===', `Game: ${book.game}`, `League: ${book.league}`,
      `Available starting currency: ${startAmount} ${startCurrency}`, `Minimum gross profit on deployed currency: ${threshold}%`,
      `Observed directional quotes: ${book.quotes.length}; queried pairs: ${book.pairs.length}`, `Book assembled: ${book.completedAt}`,
      'Fees and gold costs: unknown. Net profit: unknown. Fills are not guaranteed.', calculation.sizingModel];
    lines.push(`Reference diagnostic: ${diagnostics.reference.status}${diagnostics.reference.reason ? ` (${diagnostics.reference.reason})` : ''}.`);
    if (diagnostics.reference.provenance) {
      const source = diagnostics.reference.provenance;
      lines.push(`Aggregate reference: ${source.source}; fetched ${source.fetchedAt}; checked ${source.checkedAt}; source snapshot age ${source.sourceAgeSeconds === null ? 'unknown' : `${source.sourceAgeSeconds} seconds`}.`,
        `Quote/reference compares receiving units per paid unit. Divergence outside ${formatRate(1 / diagnostics.reference.deviationFactor)}×–${formatRate(diagnostics.reference.deviationFactor)}× is a diagnostic heuristic; fill verification remains separate.`);
    }
    for (const comparison of diagnostics.quoteComparisons.filter(row => row.flagged && candidateQuoteIds.has(row.quoteId))) {
      lines.push(`REFERENCE DIVERGENCE: quote ${comparison.quoteId}; listing ${comparison.listingId}; quoted ${formatRate(comparison.quoteRate!)} vs aggregate ${formatRate(comparison.referenceRate!)} ${comparison.unit}; quote/reference ${formatRate(comparison.quoteToReferenceRatio!)}×.`);
    }
    for (const shared of diagnostics.sharedQuoteDependencies) {
      lines.push(`Shared quote ${shared.quoteId} (listing ${shared.listingId}) is used by candidates ${shared.candidateNumbers.join(', ')}; advertised stock ${shared.advertisedStock ?? 'unknown'} ${shared.stockCurrency}.` +
        (shared.flaggedByReference ? ` REFERENCE DIVERGENCE: quote/reference ${formatRate(shared.quoteToReferenceRatio!)}×.` : ''));
    }
    if (diagnostics.sharedQuoteDependencies.length) lines.push('Do not sum candidate profits: these alternatives depend on shared quoted stock.');
    for (const pair of pairs) lines.push(`${pair.from} → ${pair.to}: ${pair.usedQuotes} quotes used; observed ${pair.fetchedAt}; source ${pair.source}; query ${pair.queryId}`);
    if (!calculation.opportunities.length) lines.push('No positive gross cycle found in this bounded quote sample at the tested quantities.');
    for (const [index, cycle] of [...calculation.opportunities, ...calculation.residualCandidates].entries()) {
      lines.push('', `${index + 1}. ${cycle.currencies.join(' → ')}`,
        `Quoted scenario: ${cycle.startAmount} → ${cycle.endAmount} ${startCurrency}; gross gain ${cycle.grossProfit} ${startCurrency} (${cycle.grossProfitPercent.toFixed(2)}%).`,
        `Undeployed starting currency: ${cycle.unusedStartAmount} ${startCurrency}`);
      if (cycle.gainType === 'unvalued-residual') lines.push('Starting principal recovered with additional unvalued currency. The requested percentage threshold is not verified for this candidate.');
      for (const step of cycle.steps) {
        lines.push(`  ${step.paid} ${step.from} → ${step.received} ${step.to}; advertised stock ${step.quote.stock} ${step.to}.`,
          `  Observed ${step.quote.provenance.fetchedAt}; listing indexed ${step.quote.provenance.indexedAt ?? 'unknown'}.`,
          `  ${step.quote.provenance.searchUrl}; listing ${step.quote.provenance.listingId}; offer ${step.quote.provenance.offerIndex}`);
        const comparison = comparisons.get(step.quote.id)!;
        lines.push(comparison.status === 'compared' ?
          `  Reference comparison: quoted ${formatRate(comparison.quoteRate!)} vs aggregate ${formatRate(comparison.referenceRate!)} ${comparison.unit}; quote/reference ${formatRate(comparison.quoteToReferenceRatio!)}×${comparison.flagged ? ' — reference divergence' : ''}.` :
          `  Reference comparison: unknown (${comparison.reason}).`);
      }
      if (cycle.leftovers.length) lines.push(`Unvalued intermediate change: ${cycle.leftovers.map(row => `${row.amount} ${row.currency}`).join(', ')}`);
    }
    lines.push('', ...calculation.warnings, `Sizing scenarios checked: ${calculation.sizingScenarios}; excluded quotes: ${calculation.excludedQuotes}.`,
      'No trades or messages were sent.');
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: {
      status: 'evaluated', game: book.game, league: book.league, startCurrency, startAmount,
      quoteCount: book.quotes.length, pairs, ...calculation, diagnostics,
    } };
  });
}

export interface TradingProfitArgs {
  league: string;
  currency_chain: string[];
  start_amount?: number;
  /** Per leg: units received per one unit spent. User assumptions, not sourced quotes. */
  user_rates?: number[];
  /** Per leg: deducted after conversion, in that leg's destination currency. */
  step_costs?: number[];
}

export async function handleCalculateTradingProfit(context: PoeNinjaContext, args: TradingProfitArgs): Promise<TextResult> {
  return wrapHandler('calculate trading profit', async () => {
    const { currency_chain: chain, start_amount: start = 1, user_rates: userRates, step_costs: costs } = args;
    if (!Array.isArray(chain) || chain.length < 2 || chain.length > 100 || chain.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('Currency chain must contain 2 to 100 nonempty currency names');
    }
    if (!Number.isFinite(start) || start <= 0) throw new Error('Starting amount must be finite and positive');
    if (userRates !== undefined && (!Array.isArray(userRates) || userRates.length !== chain.length - 1 || userRates.some(rate => !Number.isFinite(rate) || rate <= 0))) {
      throw new Error('Supply one finite positive user rate per conversion step');
    }
    if (costs !== undefined && (!Array.isArray(costs) || costs.length !== chain.length - 1 || costs.some(cost => !Number.isFinite(cost) || cost < 0))) {
      throw new Error('Supply one finite nonnegative cost per conversion step');
    }
    const data = await context.ninjaClient.getEconomyOverview(args.league);
    const valuations = new Map(data.rows.map(row => [row.name, row.primaryValue]));
    // Validate the whole chain before rendering any result, including a user-rate scenario.
    for (const currency of chain) {
      if (!(valuations.get(currency)! > 0)) throw new Error(`Currency "${currency}" has no positive reference valuation in this source`);
    }
    let output = `=== Trading Chain Scenario ===\n${sourceSummary(data)}\nChain: ${chain.join(' → ')}\n`;
    output += userRates ? 'Rate basis: user-supplied directional rates (unverified assumptions).\n' :
      'Rate basis: ratios of aggregate reference valuations; missing directional quote evidence.\n';
    output += costs ? 'Costs: user-supplied, deducted in each destination currency.\n' :
      'Costs: not supplied; assumed zero for this calculation. Gold, slippage, time and unpriced costs are excluded.\n';
    let amount = start;
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1], to = chain[i];
      const rate = userRates?.[i - 1] ?? valuations.get(from)! / valuations.get(to)!;
      const cost = costs?.[i - 1] ?? 0;
      const next = amount * rate - cost;
      if (!Number.isFinite(rate) || !Number.isFinite(next)) throw new Error('Rate or amount exceeds finite calculation limits');
      if (next < 0) throw new Error(`Step ${i} cost exceeds available ${to}`);
      output += `${i}. ${amount.toFixed(4)} ${from} × ${rate.toPrecision(8)} − ${cost.toFixed(4)} ${to} = ${next.toFixed(4)} ${to}\n`;
      amount = next;
    }
    const finalCurrency = chain[chain.length - 1];
    output += `\nResult: ${amount.toFixed(4)} ${finalCurrency}\n`;
    if (chain[0] === finalCurrency) {
      const difference = amount - start;
      const percent = difference / start * 100;
      if (!Number.isFinite(percent)) throw new Error('Profit percentage exceeds finite calculation limits');
      output += `${userRates ? 'User-scenario profit/loss' : 'Reference valuation change'}: ${difference.toFixed(4)} ${finalCurrency} (${percent.toFixed(2)}%)\n`;
    } else {
      output += 'Start and end currencies differ; unit counts alone are not a profit comparison.\n';
    }
    output += 'No trades were executed. This calculation does not establish executable profit.\n';
    return result(output);
  });
}
