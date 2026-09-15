import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { basename, dirname } from 'path';
import { BuildService } from '../../src/services/buildService.js';
import { BudgetBuildService, createBudgetBuildPlan, formatBudgetBuildPlan } from '../../src/services/budgetBuildService.js';

// Local metadata/file reads only: this suite never connects to a PoB runtime or trade endpoint.
const installed = process.env.POE2_BUDGET_NATIVE_DATA_TEST === '1' ? describe : describe.skip;
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
installed('PoE2 budget planning with installed definitions', () => {
  it('preserves native skill/support identities and uses their real progression metadata', async () => {
    const parser = new BuildService('/unused-budget-installed');
    const build = parser.parseBuildContent(`<PathOfBuilding2><Build className="Witch" level="93" mainSocketGroup="1"/>
      <Skills activeSkillSet="1"><SkillSet id="1"><Skill enabled="true"><Gem nameSpec="Spark"
      gemId="Metadata/Items/Gems/SkillGemSpark" level="18" quality="0"/><Gem nameSpec="Rapid Casting II"
      gemId="Metadata/Items/Gems/SupportGemArcaneTempoTwo" level="1" quality="0"/></Skill></SkillSet></Skills></PathOfBuilding2>`);
    const before = JSON.stringify(build);
    const plan = await new BudgetBuildService().createPlan({ build, stats: {}, source: 'file', note: 'Installed metadata fixture.' },
      'Installed fixture', { budget: 0, currency: 'exalted', maxSearches: 0 });
    expect(plan.loadout.groups[0].gems).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Spark', naturalMaxLevel: 20, level: 18, isSupport: false }),
      expect.objectContaining({ name: 'Rapid Casting II', naturalMaxLevel: 1, level: 1, isSupport: true }),
    ]));
    expect(plan.warnings.join(' ')).not.toMatch(/catalog unavailable|metadata unavailable|unresolved gem/i);
    expect(plan.shopping.items.find(row => row.gem?.gemId === 'Metadata/Items/Gems/SkillGemSpark')?.gem).toMatchObject({ targetLevel: 20 });
    expect(plan.shopping.items.some(row => row.gem?.gemId === 'Metadata/Items/Gems/SupportGemArcaneTempoTwo')).toBe(false);
    expect(plan.budget).toMatchObject({ quotedSpend: 0, proposed: 0 });
    expect(JSON.stringify(build)).toBe(before);
  });

  it('reads a private saved build with installed metadata and preserves its bytes', async () => {
    const file = process.env.POE2_BUDGET_PRIVATE_XML;
    if (!file) throw new Error('Set POE2_BUDGET_PRIVATE_XML for the opted-in saved-build verification');
    const before = hash(readFileSync(file));
    const plan = await createBudgetBuildPlan({ buildService: new BuildService(dirname(file)), getLuaClient: () => null }, basename(file),
      { budget: 0, currency: 'exalted', maxSearches: 0 });
    expect(plan.snapshot.source).toBe('file');
    expect(plan.loadout.groups.length).toBeGreaterThan(1);
    expect(plan.loadout.equipment.filter(row => row.state === 'present').length).toBeGreaterThan(0);
    expect(plan.loadout.groups.flatMap(group => group.gems).filter(gem => gem.gemId && !gem.metadataSource)).toEqual([]);
    expect(formatBudgetBuildPlan(plan)).not.toMatch(/Tabula Rasa|spell suppression|rustic sash/);
    expect(plan.budget).toMatchObject({ quotedSpend: 0, remaining: 0, proposed: 0 });
    expect(hash(readFileSync(file))).toBe(before);
    console.info('Private budget evidence (counts only):', { groups: plan.loadout.groups.length,
      equipment: plan.loadout.equipment.length, entries: plan.entries.length, hashUnchanged: true });
  });
});
