import { describe, it, expect } from '@jest/globals';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge.js';
import { handleGetStatBreakdown } from '../../src/handlers/statBreakdownHandler.js';

// Opt in to an already-running PoB2 test runtime. No loading, selection,
// mutation, process launch or shutdown commands are sent by this test.
const port = Number(process.env.POE2_STAT_BREAKDOWN_TEST_PORT);
const native = port && process.env.POB_INSTALL_DIR ? describe : describe.skip;
native('read-only PoE2 stat breakdown evidence', () => {
  it('matches current native outputs, source IDs and active tree names', async () => {
    const client = new PoBLuaTcpClient({ host: '127.0.0.1', port, timeoutMs: 10000 });
    try {
      await client.start();
      const before = await client.getBuildInfo();
      const treeBefore = await client.getTree();
      expect(before.game).toBe('poe2');
      expect(before.treeVersion).toBe('0_5');
      const stats = await client.getStats(['Life', 'FireResist', 'Str', 'CritMultiplier']);
      const context = { ensureLuaClient: async () => {}, getLuaClient: () => client };
      for (const stat of ['Life', 'FireResist', 'Str', 'CritMultiplier']) {
        const use_skill_config = stat === 'CritMultiplier';
        const raw = await client.getStatBreakdown({ stat, use_skill_config });
        const result = await handleGetStatBreakdown(context, { stat, use_skill_config, raw_json: true });
        expect(result.isError).not.toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.output_value).toBe(stats[stat]);
        expect(parsed.inc_sum).toBe(raw.inc_sum);
        expect(parsed.more_multiplier).toBe(raw.more_multiplier);
        expect(parsed.contributions.map(({ sourceHuman, ...c }: any) => c)).toEqual(raw.contributions);
        expect(parsed.source_context.treeVersion).toBe(before.treeVersion);
        if (stat === 'Life') {
          expect(parsed.contributions.find((c: any) => c.source === 'Tree:31223').sourceHuman).toBe('Passive: Crimson Power (31223)');
          expect(parsed.contributions.some((c: any) => c.source.startsWith('Item:') && /\(item \d+\)$/.test(c.sourceHuman))).toBe(true);
          expect(parsed.contributions.some((c: any) => c.source.startsWith('Quest:'))).toBe(true);
        }
        if (use_skill_config) expect(parsed.config).toBe('skill');
      }
      expect(await client.getBuildInfo()).toEqual(before);
      expect(await client.getTree()).toEqual(treeBefore);
    } finally { await client.stop(); } // TCP stop only closes our socket.
  }, 30000);
});
