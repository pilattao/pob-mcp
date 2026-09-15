import { describe, expect, it } from '@jest/globals';
import { BuildService } from '../../src/services/buildService.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
import { handleAnalyzeSkillLinks, handleCompareGemSetups, handleSuggestSupportGems,
  handleFindOptimalLinks, handleGemUpgradePath, handleValidateGemQuality } from '../../src/handlers/skillGemHandlers.js';
import { handleOptimizeSkillLinks } from '../../src/handlers/advancedOptimizationHandlers.js';
const xml = '<PathOfBuilding2><Build level="93" mainSocketGroup="1"/><Skills activeSkillSet="1"><SkillSet id="1"><Skill mainActiveSkill="1"><Gem gemId="fixture/skill" skillId="FixturePlayer" nameSpec="Fixture Skill" level="18" quality="10"/><Gem gemId="fixture/support" nameSpec="Fixture Tempo" level="1" quality="0"/></Skill></SkillSet></Skills></PathOfBuilding2>';
const detail: any = { 'fixture/skill': { name: 'Fixture Skill', gemId: 'fixture/skill', skillId: 'FixturePlayer',
  support: false, tags: ['spell'], naturalMaxLevel: 20, maxLevel: 40, qualityLines: ['Fixture quality bonus'],
  perLevel: [{ level: 20, levelRequirement: 90 }] },
  'fixture/support': { name: 'Fixture Tempo', gemId: 'fixture/support', support: true,
    tags: ['support'], naturalMaxLevel: 1, maxLevel: 1, qualityLines: [] },
  'fixture/candidate': { name: 'Fixture Focus', gemId: 'fixture/candidate', support: true,
    tags: ['support'], naturalMaxLevel: 1, maxLevel: 1, qualityLines: [], description: 'A fixture tradeoff' } };
function context(liveName = 'Requested') {
  const buildService = new BuildService('/tmp/poe2-gem-evidence-unused');
  const saved = buildService.parseBuildContent(xml);
  const mutations: string[] = [];
  const client: any = {
    getBuildInfo: async () => ({ name: liveName, level: 93 }), exportBuildXml: async () => xml,
    getStats: async () => ({}), getSkills: async () => ({ activeSkillSetId: 1, mainSocketGroup: 1,
      groups: [{index: 1, mainActiveSkill: 1, enabled: true, gems: [
        { index: 1, gemId: 'fixture/skill', skillId: 'FixturePlayer', name: 'Fixture Skill', level: 18, quality: 10, enabled: true, is_support: false },
        { index: 2, gemId: 'fixture/support', name: 'Fixture Tempo', level: 1, quality: 0, enabled: true, is_support: true }] }] }),
    getGemDetail: async ({ gemName }: any) => detail[gemName],
    evaluateGemSetups: async (params: any) => {
      const row = {name: 'Fixture comparison', valid: true, output: {CombinedDPS: 12, ManaCost: 3},
        deltas: {CombinedDPS: {absolute: 2, percent: 20}}, gems: [
          {name: 'Fixture Skill', gemId: 'fixture/skill', level: 18, quality: 10, support: false},
          {name: 'Fixture Focus', gemId: 'fixture/candidate', level: 1, quality: 0, support: true}],
        supports: [{name: 'Fixture Focus', status: 'applied', description: 'A fixture tradeoff'}], warnings: []};
      return {baseline: {CombinedDPS: 10}, metric: 'CombinedDPS', setups: params.setups ? params.setups.map((s: any) => ({...row,name:s.name})) : [row], ranking: [row], conditions: {},
        search: {algorithm: 'fixture', evaluations: 1, eligibleCandidates: 1, truncated: false, budget: 48},
        rollback: {xmlUnchanged: true, statsUnchanged: true, selectionsUnchanged: true, undoUnchanged: true}};
    },
    loadBuildXml: async () => { mutations.push('load'); throw new Error('Unexpected live mutation'); },
    addGem: async () => { mutations.push('add'); throw new Error('Unexpected live mutation'); },
    setGemLevel: async () => { mutations.push('level'); throw new Error('Unexpected live mutation'); },
  };
  const provider: any = { catalog: async () => Object.values(detail), compatibility: async (_g: any, candidates: any[]) =>
    candidates.map(g => ({gemId: g.gemId, compatible: true, scope: 'native-base-types', reason: 'Native compatibility preflight'})) };
  return {buildService: {parseBuildContent: buildService.parseBuildContent.bind(buildService), readBuild: async () => saved} as any,
    skillGemService: new (SkillGemService as any)(provider), getLuaClient: () => client,
    ensureLuaClient: async () => {}, pobDirectory: '/tmp/poe2-gem-evidence-unused', mutations, client};
}
const text = (result: any) => result.content.map((c: any) => c.text).join('\n');
describe('PoE2 gem handlers use read-only evidence', () => {
  it('analyzes the current live build without requiring a filename', async () => {
    const ctx = context(); const output = text(await handleAnalyzeSkillLinks(ctx));
    expect(output).toContain('Fixture Skill'); expect(output).toContain('current PoB2');
    expect(ctx.mutations).toEqual([]);
  });
  it('keeps a differently named saved build independent of live skills', async () => {
    const ctx = context('Another'); ctx.client.getSkills = async () => { throw new Error('Wrong build queried'); };
    const output = text(await handleAnalyzeSkillLinks(ctx, { build_name: 'Requested' }));
    expect(output).toContain('saved PoB2 XML'); expect(output).toContain('Fixture Skill');
    expect(ctx.mutations).toEqual([]);
  });
  it('returns concrete native candidates without made-up damage or cost claims', async () => {
    const output = text(await handleSuggestSupportGems(context(), {build_name: 'Requested'}));
    expect(output).toContain('Fixture Focus'); expect(output).toContain('A fixture tradeoff');
    expect(output).not.toMatch(/Est\. DPS|fully optimized|appears optimal|Chaos|Exceptional/i);
  });
  it('compares native outputs without committing gem edits', async () => {
    const ctx = context(); const output = text(await handleCompareGemSetups(ctx, {build_name: 'Requested',
      setups: [{name: 'A', gems: ['Fixture Skill', 'Fixture Tempo']}, {name: 'B', gems: ['Fixture Skill', 'Fixture Focus']}] }));
    expect(output).toContain('Fixture Focus'); expect(output).toContain('Native');
    expect(output).not.toMatch(/More.*multipliers|add_gem|Est\. DPS/);
    expect(ctx.mutations).toEqual([]);
  });
  it('accepts a two-gem target without equipment six-link rules', async () => {
    const output = text(await handleFindOptimalLinks(context(), {build_name: 'Requested', link_count: 2}));
    expect(output).toContain('Fixture Skill'); expect(output).not.toMatch(/6-link|Total Est\. DPS|🏆/);
  });
  it('quality and upgrade handlers use the same caps and selected-set evidence', async () => {
    const ctx = context(); const q = text(await handleValidateGemQuality(ctx, {build_name: 'Requested'}));
    expect(q).toContain('Fixture quality bonus');
    const u = text(await handleGemUpgradePath(ctx, {build_name: 'Requested'}));
    expect(u).toContain('natural level 20'); expect(u).not.toMatch(/Hillock|Free|25%|Exceptional/);
  });
  it('advanced optimizer never loads a requested file into the live build', async () => {
    const ctx = context('Another');
    // The advanced handler constructs its own service and can still read native gem details.
    const output = text(await handleOptimizeSkillLinks(ctx, 'Requested'));
    expect(output).toContain('Fixture Skill'); expect(output).toContain('saved PoB2 XML');
    expect(ctx.mutations).toEqual([]);
  });
});
