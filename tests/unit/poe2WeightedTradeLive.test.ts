import { createHash } from 'crypto';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge';
import { TradeApiClient } from '../../src/services/tradeClient';
import { handleFindWeightedTradeItems } from '../../src/handlers/tradeHandlers';

// Opt-in private probe: existing native PoB2 at the supplied port, one anonymous
// weighted search, <=3 listings, and at most one HTTP request per second. No build
// loading, mutation, cookies, authentication, whispers or process restarts.
const live = process.env.POE2_WEIGHTED_TRADE_LIVE === '1' ? describe : describe.skip;
live('native PoE2 weighted query through anonymous trade2 search and fetch', () => {
  it('renders real listings and preserves the loaded build', async () => {
    const native = new PoBLuaTcpClient({ host: '127.0.0.1',
      port: Number(process.env.POE2_WEIGHTED_TRADE_PORT ?? '55698'), timeoutMs: 45000 });
    const tradeClient = new TradeApiClient({ game: 'poe2', requestsPerSecond: 1 });
    await native.start();
    const hash = (xml: string) => createHash('sha256').update(xml).digest('hex');
    const before = hash(await native.exportBuildXml());
    const fetch = globalThis.fetch.bind(globalThis);
    const http = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.has('Cookie')).toBe(false);
      expect(headers.has('Authorization')).toBe(false);
      const response = await fetch(url, init);
      if (!response.ok) console.info('Weighted source rejection:', response.status, await response.clone().text());
      return response;
    });
    try {
      const result = await handleFindWeightedTradeItems({ tradeClient,
        getLuaClient: () => native, ensureLuaClient: async () => {} }, {
        league: 'Forbidden Rites', slot: 'Boots', limit: 3,
        // Minimal native scope for the anonymous complexity allowance. The
        // generated query itself is kept intact; no weights or filters are stripped.
        options: { statWeights: [{ label: 'Movement Speed', stat: 'MovementSpeedMod', weightMult: 1 }], includeMirrored: true },
      });
      const text = result.content[0].text;
      expect(text).toContain('Game: poe2');
      expect(text).toContain('/trade2/search/poe2/Forbidden%20Rites/');
      expect(text).toContain('Active weighted mods:');
      expect(text.match(/Listing ID:/g)?.length).toBeGreaterThan(0);
      expect(text.match(/Listing ID:/g)?.length).toBeLessThanOrEqual(3);
      expect(text).toMatch(/Price: \d+(?:\.\d+)? [a-z]+/);
      console.info(text);
    } finally {
      http.mockRestore();
      expect(hash(await native.exportBuildXml())).toBe(before);
      console.info('Native build XML hash unchanged:', before);
      await native.stop(); // Disconnect this client; the native application remains running.
    }
  }, 60000);
});
