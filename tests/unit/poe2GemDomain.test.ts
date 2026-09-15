import { describe, expect, it } from '@jest/globals';
import { SkillGemService as Service } from '../../src/services/skillGemService.js';
import * as optimizer from '../../src/skillLinkOptimizer.js';
const SkillGemService: any = Service;
const { extractPoe2SkillSets, analyzeSkillSetup } = optimizer as any;

// Synthetic fixtures: no character XML or installed game descriptions are redistributed.
const active = { gemId: 'gem/active', name: 'Test Skill', skillId: 'TestPlayer', support: false,
  naturalMaxLevel: 20, maxLevel: 40, tags: ['spell'], qualityLines: ['Test quality bonus'],
  statSets: [{ index: 1, label: 'Hit' }, { index: 2, label: 'Secondary' }],
  perLevel: [{ level: 20, levelRequirement: 90 }] };
const support = { gemId: 'gem/support', name: 'Test Tempo II', skillId: 'SupportTestPlayer', support: true,
  naturalMaxLevel: 1, maxLevel: 1, tags: ['support'], qualityLines: [], statSets: [{ index: 1 }] };
const provider: any = { catalog: async () => [active, support],
  compatibility: async (_group: any, candidates: any[]) => candidates.map(g => ({gemId: g.gemId,
    compatible: true, scope: 'native-base-types', reason: 'Native base skill types match'})) };
function build(): any { return { __xmlRoot: 'PathOfBuilding2', Build: { level: '93', mainSocketGroup: '2' },
  Skills: { activeSkillSet: '7', SkillSet: [
    { id: '1', Skill: { Gem: { nameSpec: 'Inactive setup skill', level: '2' } } },
    { id: '7', title: 'Selected', Skill: [ { enabled: 'false' }, { enabled: 'true', mainActiveSkill: '1',
      Gem: [ { gemId: 'gem/support', nameSpec: 'Test Tempo II', level: '1', quality: '0' },
        { gemId: 'gem/active', skillId: 'TestPlayer', nameSpec: 'Test Skill', level: '18', quality: '10',
          StatSetIndex: { grantedEffect: 'TestPlayer', index: '2' },
          StatSetCalcsIndex: { grantedEffect: 'TestPlayer', index: '1' } } ] } ] }
  ] } }; }

describe('PoE2 gem group evidence', () => {
  it('keeps independent sets, empty groups, native indices and separate stat sets', () => {
    const result = extractPoe2SkillSets(build());
    expect(result.selected.id).toBe('7');
    expect(result.sets).toHaveLength(2);
    expect(result.selected.groups).toHaveLength(2);
    const group = result.selected.groups[1];
    expect(group).toMatchObject({ index: 2, isMainSkill: true, enabled: true });
    expect(group.gems[1]).toMatchObject({ statSet: { TestPlayer: 2 }, statSetCalcs: { TestPlayer: 1 } });
  });
  it('rejects missing selected sets and PoE1 provenance', () => {
    const wrong = build(); wrong.Skills.activeSkillSet = '9';
    expect(() => extractPoe2SkillSets(wrong)).toThrow(/skill set/i);
    wrong.__xmlRoot = 'PathOfBuilding';
    expect(() => extractPoe2SkillSets(wrong)).toThrow(/PoE2/);
  });
  it('classifies supports by native identity even when the support is first', async () => {
    const service = new SkillGemService(provider);
    const analysis = await service.analyzeSkillLinks(build(), 1);
    expect(analysis.activeSkill?.name).toBe('Test Skill');
    expect(analysis.supports).toHaveLength(1);
    expect(analysis.supports[0]).toMatchObject({ name: 'Test Tempo II', level: 1 });
    expect(JSON.stringify(analysis)).not.toMatch(/6-link|level to 40|archetypeMatch|dpsIncrease/);
    await expect(service.analyzeSkillLinks(build(), -1)).rejects.toThrow(/index/i);
    await expect(service.analyzeSkillLinks(build(), 0.5)).rejects.toThrow(/index/i);
  });
  it('uses native quality data and natural levels without leveling supports to 20', async () => {
    const validation = await new SkillGemService(provider).validateGemQuality(build());
    expect(validation.needsQuality).toHaveLength(1);
    expect(validation.needsQuality[0]).toMatchObject({ gem: 'Test Skill', current: 10, recommended: 20 });
    const upgrades = await new SkillGemService(provider).gemUpgradePath(build());
    expect(upgrades.some((u: any) => u.gem === 'Test Skill' && u.action.includes('20'))).toBe(true);
    expect(upgrades.some((u: any) => u.gem === 'Test Tempo II')).toBe(false);
    expect(JSON.stringify(upgrades)).not.toMatch(/Free|Hillock|Exceptional|25%|level to 40/);
  });
  it('excludes disabled and corrupted gems from actionable upgrades by default', async () => {
    const b = build(); const gem = b.Skills.SkillSet[1].Skill[1].Gem[1]; gem.corrupted = 'true';
    expect((await new SkillGemService(provider).validateGemQuality(b)).needsQuality).toHaveLength(0);
    gem.corrupted = 'false'; gem.enabled = 'false';
    expect(await new SkillGemService(provider).gemUpgradePath(b)).toHaveLength(0);
  });
  it('does not diagnose missing links or generic penetration requirements for a short group', () => {
    const group: any = { index: 1, enabled: true, isMainSkill: true, gems: [{name: 'Test Skill',
      enabled: true, level: 20, quality: 0, isSupport: false, data: {...active, qualityLines: []} }] };
    const analysis = analyzeSkillSetup([group], 'PoE2');
    expect(analysis.groupAnalyses[0].issues).toHaveLength(0);
    expect(analysis.generalSuggestions.join(' ')).not.toMatch(/6.link|penetration|aura/i);
  });
});

describe('PoE2 native identities and selection boundaries', () => {
  it('defaults to the selected native main group while keeping explicit zero as group zero', async () => {
    const service = new SkillGemService(provider);
    expect((await service.analyzeSkillLinks(build())).group.index).toBe(2);
    expect((await service.analyzeSkillLinks(build(), 0)).group.index).toBe(1);
  });
  it('matches game IDs plus variants and reports duplicate support families', async () => {
    const b = build(); b.Skills.SkillSet[1].Skill[1].Gem[0].gemId = 'game/support';
    const variantSupport = {...support, gameId: 'game/support', family: ['Tempo']};
    const peer = {...support, gemId: 'gem/peer', name: 'Test Tempo III', skillId: 'SupportTestThree',family: ['Tempo']};
    b.Skills.SkillSet[1].Skill[1].Gem.push({gemId: 'gem/peer',nameSpec: 'Test Tempo III',level: '1',quality: '0'});
    const service = new SkillGemService({...provider, catalog: async () => [active,variantSupport,peer]});
    const a = await service.analyzeSkillLinks(b,1);
    expect(a.supports).toHaveLength(2);
    expect(a.issues.some((i: any) => i.type === 'duplicate_support' && i.message.includes('Tempo'))).toBe(true);
  });
  it('rejects live/XML gem identity races instead of assigning the old stat-set map to a different gem', async () => {
    const service = new SkillGemService(provider);
    const liveSkills = {activeSkillSetId: 7,mainSocketGroup: 2,groups: [{index: 2,enabled: true,gems: [
      {index: 1,gemId: 'gem/other',name: 'Other skill',level: 1,quality: 0,is_support: false}]}]};
    await expect(service.prepareBuild(build(), {liveSkills})).rejects.toThrow(/changed|mismatch/i);
  });
  it('does not suggest spending quality on a gem whose level or quality is malformed', async () => {
    const b = build(); b.Skills.SkillSet[1].Skill[1].Gem[1].quality = '-1';
    const quality = await new SkillGemService(provider).validateGemQuality(b);
    expect(quality.needsQuality).toHaveLength(0);
  });
});

describe('PoE2 generated skill support groups', () => {
  it('checks a separate support group against the enabled item-granted skill in the same slot', async () => {
    const b = build(); b.Build.mainSocketGroup = '1';
    b.Skills.SkillSet[1].Skill = [
      {slot: 'Weapon 1', Gem: {gemId: 'gem/support',level: '1',quality: '0'}},
      {slot: 'Weapon 1',source: 'Item:fixture', Gem: {gemId: 'gem/active',level: '18',quality: '0'}},
    ];
    const candidate = {...support,gemId: 'gem/candidate',name: 'Test Candidate',skillId: 'SupportCandidate'};
    const service = new SkillGemService({catalog: async () => [active,support,candidate],
      compatibility: async (group: any, candidates: any[]) => candidates.map(g => ({gemId: g.gemId,
        compatible: group.gems.some((gem: any) => gem.data?.skillId === 'TestPlayer'), scope: 'native-base-types', reason: 'Native type preflight'}))});
    expect((await service.suggestSupportGems(b)).map((g: any) => g.gem)).toEqual(['Test Candidate']);
    expect((await service.gemUpgradePath(b)).some((u: any) => u.gem === 'Test Skill')).toBe(false);
  });
});
