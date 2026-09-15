import { writeFileSync } from 'fs';
import { ShoppingListService } from '../../src/services/shoppingListService.js';
import { TradeApiClient } from '../../src/services/tradeClient.js';
import { StatMapper } from '../../src/services/statMapper.js';
import { PoeNinjaClient } from '../../src/services/poeNinjaClient.js';

// Opt-in public-source reproduction. No character, account, native GUI or order
// endpoint is used. All network requests are serialized below one request/sec.
const live = process.env.POE2_SHOPPING_LIVE === '1' ? describe : describe.skip;
live('PoE2 live body-armour shopping contract', () => {
  it('retains actual ES 100, flat Spirit 40 and current Ward 100 within a 5 divine reference budget', async () => {
    const league = process.env.POE2_SHOPPING_LIVE_LEAGUE;
    if (!league) throw new Error('Set the exact POE2_SHOPPING_LIVE_LEAGUE');
    const originalFetch = globalThis.fetch.bind(globalThis);
    let nextAt = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const task = queue.then(async () => {
        const wait = nextAt - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        nextAt = Date.now() + 1200;
        return originalFetch(input, init);
      });
      queue = task.then(() => undefined, () => undefined);
      return task;
    });
    const game = process.env.POE_GAME;
    process.env.POE_GAME = 'poe2';
    try {
      const client = new TradeApiClient({ game: 'poe2', requestsPerSecond: 0.4 });
      const service = new ShoppingListService(client, new StatMapper(), new PoeNinjaClient({ game: 'poe2' }));
      const requestContext: any = { __xmlRoot: 'PathOfBuilding2', Build: {},
        Items: { activeItemSet: '1', ItemSet: { id: '1', Slot: { name: 'Body Armour', itemId: '0' } } },
        Skills: { activeSkillSet: '1', SkillSet: { id: '1', Skill: [] } } };
      const result = await service.generateShoppingList(requestContext, 'Public query reproduction', league, 'medium', {
        sourceNote: 'Reproduction request only; no character or native build was loaded.',
        slots: ['Body Armour'], priority: 'dps', includeGems: false, maxSearches: 1, limitPerSlot: 2,
        budget: 5, currency: 'divine', itemRequirements: { 'Body Armour': { minES: 100, minSpirit: 40, minWard: 100 } },
      });
      const row = result.items[0];
      const report = { checkedAt: new Date().toISOString(), league, requirements: row.requirements,
        query: row.search.query, summary: result.summary,
        candidates: row.candidates.map(c => ({ listingId: c.listingId, price: c.price, referenceDivineCost: c.priceInBudgetCurrency,
          stats: c.itemEvidence, mods: c.mods, url: c.url, source: c.source })), warnings: [...result.warnings, ...row.warnings] };
      if (process.env.POE2_SHOPPING_LIVE_REPORT) writeFileSync(process.env.POE2_SHOPPING_LIVE_REPORT, JSON.stringify(report, null, 2));
      console.info('Public shopping verification:', JSON.stringify(report));
      expect(row.candidates.length).toBeGreaterThan(0);
      for (const candidate of row.candidates) {
        expect(candidate.itemEvidence.es).toBeGreaterThanOrEqual(100);
        expect(candidate.itemEvidence.spirit).toBeGreaterThanOrEqual(40);
        expect(candidate.itemEvidence.ward).toBeGreaterThanOrEqual(100);
        expect(candidate.price?.amount).toBeGreaterThan(0);
        expect(candidate.priceInBudgetCurrency).toBeLessThanOrEqual(5);
        expect(candidate.mods.some(m => /to Spirit$/.test(m))).toBe(true);
        expect(candidate.url).toContain('/trade2/search/poe2/');
      }
    } finally {
      network.mockRestore();
      if (game === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = game;
    }
  }, 120000);
});
