import { describe, expect, it } from '@jest/globals';
import { createHash } from 'crypto';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge.js';
import { BuildService } from '../../src/services/buildService.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
import { handleAnalyzeSkillLinks, handleSuggestSupportGems, handleValidateGemQuality,
  handleGemUpgradePath, handleCompareGemSetups } from '../../src/handlers/skillGemHandlers.js';
import { handleOptimizeSkillLinks } from '../../src/handlers/advancedOptimizationHandlers.js';
const live = process.env.POE2_GEM_LIVE_TEST === '1' ? describe : describe.skip;
const hash = (xml: string) => createHash('sha256').update(xml).digest('hex');
live('Parent-only deployed native gem evaluator smoke', () => {
  it('evaluates gem scenarios transactionally and leaves the main-owned build unchanged', async () => {
    const client = new PoBLuaTcpClient({host: process.env.POE2_GEM_TEST_HOST ?? '127.0.0.1',
      port: Number(process.env.POE2_GEM_TEST_PORT ?? '55698'), timeoutMs: 15000});
    await client.start();
    try {
      const before = hash(await client.exportBuildXml());
      const context = {buildService: new BuildService('/tmp/unused-poe2-gem-live'), skillGemService: new SkillGemService(),
        getLuaClient: () => client, ensureLuaClient: async () => {}, pobDirectory: '/tmp/unused-poe2-gem-live'};
      const results = [];
      // Sequential reads respect the single-request native transport.
      results.push(await handleAnalyzeSkillLinks(context));
      results.push(await handleSuggestSupportGems(context, {count: 3}));
      results.push(await handleValidateGemQuality(context));
      results.push(await handleGemUpgradePath(context, {}));
      results.push(await handleOptimizeSkillLinks(context));
      for (const result of results) {
        expect((result as any).isError).not.toBe(true);
        const output = result.content[0].text;
        expect(output).toContain('current PoB2');
        expect(output).not.toMatch(/Installed gem catalog unavailable|gem metadata unavailable|Est\. DPS|6-link|Hillock/);
      }
      const skills = await client.getSkills();
      const group = skills.groups.find((g: any) => g.index === skills.mainSocketGroup);
      if (group?.gems.some((g: any) => g.is_support === false)) {
        const names = group.gems.map((g: any) => g.name);
        const comparison = await handleCompareGemSetups(context, {build_name: '', setups: [
          {name: 'Current',gems: names},{name: 'Same metadata baseline',gems: names}]});
        expect((comparison as any).isError).not.toBe(true);
        expect(comparison.content[0].text).toContain('Verified rollback');
        expect(comparison.content[0].text).toContain('Native baseline');
      }
      expect(hash(await client.exportBuildXml())).toBe(before);
      console.info('Native transactional gem handlers verified; serialized build hash unchanged.');
    } finally { await client.stop(); }
  }, 60000);
});
