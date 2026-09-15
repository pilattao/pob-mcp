import fs from 'fs/promises';
import { PoE2BulkExchangeClient, type ExchangeQuoteBook, BulkExchangeRequestError } from '../../src/services/poe2ExchangeQuotes';
import { PoeNinjaClient } from '../../src/services/poeNinjaClient';
import { handleFindArbitrage } from '../../src/handlers/poeNinjaHandlers';

// Two anonymous directional reads. No native PoB, account access, cookies,
// purchases, messages, source fallbacks or repeated requests after rejection.
const live = process.env.POE2_ARBITRAGE_LIVE === '1' ? describe : describe.skip;
live('public PoE2 bulk quote arbitrage handler', () => {
  it('evaluates both quote directions with prices, stocks, provenance and unknown fees', async () => {
    const client = new PoE2BulkExchangeClient();
    const originalFetch = globalThis.fetch.bind(globalThis);
    const requests: Array<{ url: string; query: unknown; requestedAt: string; status?: number }> = [];
    let quoteBook: ExchangeQuoteBook | undefined;
    let sourceError: unknown;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      const record = { url: String(url), query: JSON.parse(init!.body as string), requestedAt: new Date().toISOString(), status: undefined as number | undefined };
      requests.push(record);
      const response = await originalFetch(url, init);
      record.status = response.status;
      return response;
    });
    const source = { getQuoteBook: async (options: Parameters<typeof client.getQuoteBook>[0]) => {
      try { quoteBook = await client.getQuoteBook(options); return quoteBook; }
      catch (error) { sourceError = error; throw error; }
    } };
    try {
      const result = await handleFindArbitrage({ ninjaClient: new PoeNinjaClient({ game: 'poe2' }), exchangeClient: source }, {
        league: 'Forbidden Rites', currencies: ['divine', 'exalted'], start_currency: 'divine', start_amount: 10,
        min_profit_percent: 0, max_steps: 2, max_quotes_per_pair: 20,
        reference_diagnostic: false, // This opt-in transport test remains exactly two source POSTs.
      });
      expect(result.structuredContent).toMatchObject({ status: 'evaluated', game: 'poe2', league: 'Forbidden Rites' });
      expect(requests).toHaveLength(2);
      expect(Date.parse(requests[1].requestedAt) - Date.parse(requests[0].requestedAt)).toBeGreaterThanOrEqual(1000);
      expect(quoteBook!.pairs.map(pair => [pair.from, pair.to])).toEqual([['divine', 'exalted'], ['exalted', 'divine']]);
      expect(quoteBook!.pairs.every(pair => pair.quotes.length > 0)).toBe(true);
      for (const quote of quoteBook!.quotes) {
        expect(quote.payAmount).toBeGreaterThan(0); expect(quote.receiveAmount).toBeGreaterThan(0);
        expect(quote.stock).not.toBeNull(); expect(quote.provenance.queryId).toBeTruthy(); expect(quote.fees).toBeNull();
      }
      const data = result.structuredContent as any;
      for (const cycle of [...data.opportunities, ...data.residualCandidates]) {
        expect(cycle.fillsGuaranteed).toBe(false); expect(cycle.netProfit).toBeNull();
        for (const step of cycle.steps) expect(step.received).toBeLessThanOrEqual(step.quote.stock);
      }
      const evidence = { requests, quoteBook, result: result.structuredContent };
      if (process.env.POE2_ARBITRAGE_REPORT) await fs.writeFile(process.env.POE2_ARBITRAGE_REPORT, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.info(JSON.stringify({ requests, pairs: data.pairs, quoteCount: data.quoteCount,
        qualifiedCycles: data.opportunities.length, residualCandidates: data.residualCandidates.length,
        sizingScenarios: data.sizingScenarios, searchComplete: data.searchComplete, fillsVerified: false, fees: null }));
    } catch (error) {
      const detail = sourceError instanceof BulkExchangeRequestError ? {
        message: sourceError.message, status: sourceError.status, apiCode: sourceError.apiCode, source: sourceError.source,
      } : { message: String(error) };
      if (process.env.POE2_ARBITRAGE_REPORT) await fs.writeFile(process.env.POE2_ARBITRAGE_REPORT,
        JSON.stringify({ requests, status: 'failed', error: detail }, null, 2), { mode: 0o600 });
      throw error;
    } finally { fetchSpy.mockRestore(); }
  }, 60000);
});
