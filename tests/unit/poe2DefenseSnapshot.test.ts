import fs from 'fs';
import path from 'path';
import { BuildService } from '../../src/services/buildService.js';
import { handleAnalyzeDefenses } from '../../src/handlers/optimizationHandlers.js';

// Opt-in file-only check. Private XML stays at its original path and no native
// connection is created. Set POE2_DEFENSE_SNAPSHOT to the local snapshot path.
const snapshot = process.env.POE2_DEFENSE_SNAPSHOT;
const local = snapshot ? describe : describe.skip;
local('private PoE2 snapshot defense evidence', () => {
  it('reports saved native hybrid/max-hit measurements without altering the snapshot', async () => {
    const originalGame = process.env.POE_GAME;
    const before = fs.readFileSync(snapshot!);
    try {
      process.env.POE_GAME = 'poe2';
      const buildService = new BuildService(path.dirname(snapshot!));
      const result = await handleAnalyzeDefenses({
        buildService, treeService: {} as any, pobDirectory: path.dirname(snapshot!),
        getLuaClient: () => null, ensureLuaClient: async () => {},
      }, path.basename(snapshot!));
      const text = result.content[0].text;
      // Read recorded scalars independently of the evidence service and analyzer.
      for (const [key, label] of [
        ['Life', 'Life'], ['EnergyShield', 'Energy Shield'], ['Mana', 'Mana'],
        ['TotalEHP', 'Native TotalEHP'], ['PhysicalMaximumHitTaken', 'Physical maximum hit'],
        ['ChaosMaximumHitTaken', 'Chaos maximum hit'], ['LifeLeechGainRate', 'Life leech and on-hit gain'],
      ]) {
        const value = before.toString('utf8').match(new RegExp(`<PlayerStat\\b[^>]*stat="${key}"[^>]*value="([^"]+)"`))?.[1];
        expect(value).toBeDefined();
        expect(text).toContain(`${label}: ${Number(value)}`);
      }
      expect(text).toContain('Ward: unknown');
      expect(text).toContain('saved stats can be stale');
      expect(text).toContain('Overall viability: unknown');
      expect(text).not.toMatch(/suppression|5500|Determination|CRITICAL.*Life Pool|%.*EHP (gain|increase)/i);
      expect(fs.readFileSync(snapshot!)).toEqual(before);
    } finally {
      if (originalGame === undefined) delete process.env.POE_GAME;
      else process.env.POE_GAME = originalGame;
    }
  });
});
