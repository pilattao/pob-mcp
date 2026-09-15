import type { EconomyOverview } from '../../src/services/poeNinjaClient';
import type { ExchangeQuote, ExchangeQuoteBook } from '../../src/services/poe2ExchangeQuotes';

export const observedAt = '2026-09-15T21:02:00.000Z';
// Shape from the anonymous trade2 exchange response captured on 2026-09-15.
// Prices are synthetic unless a test explicitly uses a saved live response.
export function bulkResponse(from = 'divine', to = 'exalted', pay = 1, receive = 240, stock: number | null = 2044) {
  return { id: `query-${from}-${to}`, complexity: null, total: 1,
    result: { 'result-map-key-is-not-listing-id': { id: 'listing-id', item: null, listing: {
      indexed: '2026-09-15T20:58:51+00:00', account: { name: 'synthetic-seller', realm: 'poe2', online: { league: 'Forbidden Rites' } },
      offers: [{ exchange: { currency: from, amount: pay }, item: { currency: to, amount: receive, stock, id: 'item-id' } }],
      whisper: 'not quote evidence', whisper_token: 'synthetic-do-not-expose',
    } } } };
}

export function quote(from: string, to: string, pay: number, receive: number, stock: number | null, id = `${from}-${to}`): ExchangeQuote {
  return { id, game: 'poe2', league: 'Forbidden Rites', from, to, payAmount: pay, receiveAmount: receive,
    stock, seller: 'synthetic', fees: null, provenance: { apiUrl: 'https://www.pathofexile.com/api/trade2/exchange/poe2/Forbidden%20Rites',
      searchUrl: 'https://www.pathofexile.com/trade2/exchange/poe2/Forbidden%20Rites/q', queryId: 'q', listingId: id,
      offerIndex: 0, fetchedAt: observedAt, indexedAt: null, sourceUpdatedAt: null } };
}

export function book(quotes: ExchangeQuote[]): ExchangeQuoteBook {
  return { game: 'poe2', league: 'Forbidden Rites', currencies: [...new Set(quotes.flatMap(q => [q.from, q.to]))],
    quotes, pairs: [], completedAt: observedAt, fees: null, fillsVerified: false };
}

export function referenceFixture(): EconomyOverview {
  return { primaryCurrency: 'divine', rates: { divine: 1, exalted: 400, chaos: 10 },
    rows: [
      { id: 'divine', name: 'Divine Orb', primaryCurrency: 'divine', primaryValue: 1, values: { divine: 1 }, sourceKind: 'core-reference' },
      { id: 'exalted', name: 'Exalted Orb', primaryCurrency: 'divine', primaryValue: 0.0025, values: { divine: 0.0025 }, sourceKind: 'exchange-valuation' },
    ], quoteEvidence: 'missing-directional-quotes', provenance: {
      game: 'poe2', league: 'Forbidden Rites', category: 'Currency', source: 'https://poe.ninja/poe2/api/economy/exchange/current/overview?league=Forbidden%20Rites&type=Currency',
      fetchedAt: observedAt, checkedAt: observedAt, cacheAgeSeconds: 0, sourceUpdatedAt: null, sourceAgeSeconds: null, httpLastModified: null,
    } };
}
