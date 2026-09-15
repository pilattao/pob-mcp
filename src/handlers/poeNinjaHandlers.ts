import { wrapHandler } from '../utils/errorHandling.js';
import { PoeNinjaClient, type EconomyOverview } from '../services/poeNinjaClient.js';

interface PoeNinjaContext { ninjaClient: PoeNinjaClient }
type TextResult = { content: Array<{ type: string; text: string }> };
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

export async function handleFindArbitrage(context: PoeNinjaContext,
  args: { league: string; min_profit_percent?: number }): Promise<TextResult> {
  return wrapHandler('find arbitrage', async () => {
    const threshold = args.min_profit_percent ?? 1;
    if (!Number.isFinite(threshold)) throw new Error('Minimum profit must be finite');
    const data = await context.ninjaClient.getEconomyOverview(args.league);
    return result(`=== Arbitrage Evidence ===\n${sourceSummary(data)}\nRequested minimum profit: ${threshold}%\n` +
      'Assessment unavailable: missing directional buy/sell quotes, available quantities, costs and fill evidence.\n' +
      'This source supplies aggregate reference valuations. Ratios between them do not establish an executable trading opportunity.\n' +
      'Verified opportunities: none established. No trades were executed.\n');
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
