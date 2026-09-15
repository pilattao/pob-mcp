import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { BuildService } from '../../src/services/buildService.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
const installed = process.env.POE2_GEM_NATIVE_TEST === '1' ? describe : describe.skip;
installed('installed PoB2 gem definitions and native type compatibility', () => {
  const service = new SkillGemService();
  const build: any = {__xmlRoot: 'PathOfBuilding2', Build: {mainSocketGroup: '1',level: '93'},
    Skills: {activeSkillSet: '1', SkillSet: {id: '1', Skill: {enabled: 'true', mainActiveSkill: '1', Gem: [
      {nameSpec: 'Spark',gemId: 'Metadata/Items/Gems/SkillGemSpark',level: '18',quality: '0'},
      {nameSpec: 'Rapid Casting II',gemId: 'Metadata/Items/Gems/SupportGemArcaneTempoTwo',level: '1',quality: '0'},
    ]}}}};
  it('loads native levels/stat sets and calls the installed compatibility function', async () => {
    const analysis = await service.analyzeSkillLinks(build);
    expect(analysis.notes).toEqual([]);
    expect(analysis.activeSkill?.data).toMatchObject({name: 'Spark',naturalMaxLevel: 20,maxLevel: 40});
    expect(analysis.supports[0].data).toMatchObject({support: true,naturalMaxLevel: 1});
    expect(analysis.group.compatibility?.[0]).toMatchObject({compatible: true, scope: 'native-base-types'});
    expect(analysis.notes).toEqual([]);
    expect(analysis.activeSkill?.data?.statSets?.map(s => s.index)).toEqual([1, 2]);
  });
  it('returns installed support candidates with real descriptions and no numerical estimates', async () => {
    const suggestions = await service.suggestSupportGems(build, 0, {count: 5});
    expect(suggestions).toHaveLength(5);
    expect(suggestions.every(s => s.compatibility.compatible && s.reasoning.length > 20)).toBe(true);
    expect(suggestions.some(s => s.gem === 'Rapid Casting II')).toBe(false);
    console.info('Installed native candidate IDs:', suggestions.map(s => s.gemId));
  });
  it('can analyze the private XML without embedding it in test fixtures', async () => {
    const file = process.env.POE2_GEM_PRIVATE_XML;
    if (!file) return;
    const parser = new BuildService('/tmp/poe2-gem-unused');
    const saved = parser.parseBuildContent(readFileSync(file,'utf8'));
    const model = await service.prepareBuild(saved);
    expect(model.groups.length).toBeGreaterThan(1);
    expect(model.notes).toEqual([]);
    expect(model.groups.flatMap(g => g.gems).filter(g => !g.data).length).toBe(0);
    const analysis = await service.analyzeSkillLinks(saved, model.groups.findIndex(g => g.isMainSkill));
    expect(analysis.activeSkills.length).toBeGreaterThan(0);
    expect(analysis.notes).toEqual([]);
    const upgrades = await service.gemUpgradePath(saved);
    expect(upgrades.some(u => /level 40|Hillock|Exceptional|Free/.test(u.action + u.reason))).toBe(false);
    console.info('Private XML counts only:', {sets: model.sets.length, groups: model.groups.length, upgrades: upgrades.length});
  });
});
