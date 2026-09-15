import { BuildService } from '../../src/services/buildService.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
import { handleCreateBudgetBuild } from '../../src/handlers/advancedOptimizationHandlers.js';
import { BudgetBuildService, createBudgetBuildPlan, type BudgetBuildOptions, type BudgetNativeOutcome } from '../../src/services/budgetBuildService.js';
import { TradeApiClient } from '../../src/services/tradeClient.js';
import { PoeNinjaClient } from '../../src/services/poeNinjaClient.js';
import { StatMapper } from '../../src/services/statMapper.js';
import type { ItemListing, TradeQuery } from '../../src/types/tradeTypes.js';
import type { PoE2BuildEvidence } from '../../src/services/poe2BuildEvidence.js';

const xml = `<PathOfBuilding2><Build className="Witch" ascendClassName="Blood Mage" level="93" mainSocketGroup="2">
  <PlayerStat stat="Life" value="2100"/><PlayerStat stat="MissingFireResist" value="12"/>
  <PlayerStat stat="Str" value="80"/><PlayerStat stat="Dex" value="90"/><PlayerStat stat="Int" value="220"/>
  </Build><Items activeItemSet="7"><Item id="1">Rarity: RARE
Unused Item
Ruby Ring
Implicits: 0</Item><Item id="22">Rarity: UNIQUE
Selected Unique
Ruby Ring
Implicits: 0
+20% to Fire Resistance</Item><Item id="23">Rarity: RARE
Selected Rare
Ruby Ring
Implicits: 0
+10% to Fire Resistance</Item><Item id="31">Rarity: RARE
Selected Weapon
Test Staff
Implicits: 0</Item>
  <ItemSet id="1"><Slot name="Ring 1" itemId="1"/></ItemSet><ItemSet id="7" useSecondWeaponSet="true">
  <Slot name="Ring 1" itemId="22"/><Slot name="Ring 2" itemId="23"/>
  <Slot name="Weapon 1" itemId="1"/><Slot name="Weapon 1 Swap" itemId="31"/>
  <RuneSlot slotName="Helmet" runeName="Selected Rune"/></ItemSet></Items>
  <Skills activeSkillSet="9"><SkillSet id="1"><Skill><Gem nameSpec="Unselected Skill"/></Skill></SkillSet>
  <SkillSet id="9"><Skill enabled="false"><Gem nameSpec="Disabled Skill"/></Skill>
  <Skill enabled="true" mainActiveSkill="2" mainActiveSkillCalcs="1" includeInFullDPS="true">
  <Gem nameSpec="Auxiliary" gemId="aux" level="4"/>
  <Gem nameSpec="Selected Skill" gemId="skill" level="18" quality="0"><StatSetIndex grantedEffect="Selected" index="2"/></Gem>
  <Gem nameSpec="Actual Support" gemId="support" level="1" quality="0"/>
  <Gem nameSpec="Disabled Support" gemId="disabled" enabled="false"/></Skill>
  <Skill source="Item:31"><Gem nameSpec="Granted Skill" gemId="granted" level="7"/></Skill>
  </SkillSet></Skills><Tree activeSpec="2"><Spec id="1"/><Spec id="2"/></Tree>
  <Config activeConfigSet="3"><ConfigSet id="3"/></Config><Notes>Keep this note.</Notes></PathOfBuilding2>`;

const parser = new BuildService('/unused-budget-fixture');
const gems = new SkillGemService({ catalog: async () => [
  { gemId: 'aux', name: 'Auxiliary', support: false, naturalMaxLevel: 4, tags: [] },
  { gemId: 'skill', name: 'Selected Skill', support: false, naturalMaxLevel: 20, maxLevel: 40, tags: ['spell'],
    perLevel: [{ level: 20, levelRequirement: 90, reqStr: 0, reqDex: 0, reqInt: 200 }] },
  { gemId: 'support', name: 'Actual Support', support: true, naturalMaxLevel: 1, tags: ['support'] },
  { gemId: 'granted', name: 'Granted Skill', support: false, naturalMaxLevel: 20, tags: ['spell'] },
], compatibility: async () => [] });

function context() {
  const build = parser.parseBuildContent(xml);
  const buildService = new BuildService('/unused-budget-fixture');
  jest.spyOn(buildService, 'readBuild').mockResolvedValue(build);
  return { build, context: {
    buildService,
    pobDirectory: '/unused-budget-fixture', getLuaClient: () => null,
    ensureLuaClient: async () => {},
    skillGemService: gems, shoppingDependencies: { baseLookup: () => null },
  } };
}

describe('PoE2 budget build handler', () => {
  it('connects to the current unsaved build when build_name is omitted', async () => {
    const fixture = context(); let connected = false;
    const model = await gems.prepareBuild(parser.parseBuildContent(xml));
    const client = { getBuildInfo: async () => ({ name: 'Unsaved Fixture' }), exportBuildXml: async () => xml,
      getStats: async () => ({ Life: 2100 }), getSkills: async () => ({ activeSkillSetId: '9', mainSocketGroup: 2,
        groups: model.groups.map(group => ({ ...group, gems: group.gems.map(gem => ({ ...gem, is_support: gem.isSupport })) })) }),
      getGemDetail: async () => undefined };
    const result = await handleCreateBudgetBuild({ ...fixture.context, ensureLuaClient: async () => { connected = true; },
      getLuaClient: () => connected ? client as any : null }, undefined as any);
    expect(result.structuredContent.snapshot.source).toBe('live');
    expect(result.structuredContent.buildName).toBe('Unsaved Fixture');
  });

  it('uses the selected loadout and keeps tiers free of invented budgets or gem levels', async () => {
    const fixture = context(); const before = JSON.stringify(fixture.build);
    const result = await handleCreateBudgetBuild(fixture.context, 'Fixture', 'league-start');
    const text = result.content[0].text;
    expect(text).toContain('Selected Unique');
    expect(text).toContain('Selected Skill');
    expect(text).toContain('Actual Support');
    expect(text).toMatch(/item set.*7/i);
    expect(text).toMatch(/skill set.*9/i);
    expect(text).not.toMatch(/Tabula|suppression|Chaos Orbs|rustic sash|6-link|4000|5000|Empower/);
    expect(text).toMatch(/numeric.*budget|spending limit.*not/i);
    expect(JSON.stringify(fixture.build)).toBe(before);
  });
});

const originalGame = process.env.POE_GAME;
beforeAll(() => { process.env.POE_GAME = 'poe2'; });
beforeEach(() => {
  const original = console.error;
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[StatMapper] Loaded ')) return;
    original(...args);
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => { if (originalGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = originalGame; });

function evidence(): PoE2BuildEvidence {
  return { build: parser.parseBuildContent(xml), source: 'file', note: 'Saved fixture; stats may be stale.',
    stats: { Life: 2100, MissingFireResist: 12, Str: 80, Dex: 90, Int: 220 } };
}
function listing(id: string, amount?: number, currency = 'exalted', name = 'Selected Unique'): ItemListing {
  return { id, listing: { price: amount === undefined ? undefined : { amount, currency, type: '~b/o' },
    indexed: '2026-09-15T00:00:00Z', account: {}, method: 'psapi', whisper: '' },
    item: { id, league: 'Fixture League', baseType: 'Ruby Ring', typeLine: 'Ruby Ring', name, identified: true,
      explicitMods: ['+80 to maximum Life', '+50% to Fire Resistance'] } } as ItemListing;
}
function market(pools: Record<string, ItemListing[]>, rates = new Map<string, number>()) {
  const queries: TradeQuery[] = [];
  const client = new TradeApiClient({ game: 'poe2' });
  const ninja = new PoeNinjaClient({ game: 'poe2' });
  jest.spyOn(ninja, 'getCurrencyExchangeMap').mockResolvedValue(rates);
  jest.spyOn(ninja, 'getItemPrice').mockResolvedValue({ status: 'unpriced', price: null, matches: [] } as any);
  jest.spyOn(client, 'getStats').mockResolvedValue({ result: [{ label: 'Pseudo', entries: [
    { id: 'pseudo.pseudo_total_fire_resistance', text: '+#% total to Fire Resistance', type: 'pseudo' },
  ] }] });
  jest.spyOn(client, 'searchItems').mockImplementation(async (league, query) => {
    expect(league).toBe('Fixture League');
    queries.push(structuredClone(query));
    const key = query.query.name ?? query.query.type ?? '';
    const pool = pools[typeof key === 'string' ? key : ''] ?? [];
    return { id: `query-${queries.length}`, result: pool.map(row => row.id), total: pool.length };
  });
  jest.spyOn(client, 'fetchItems').mockImplementation(async (ids, queryId) => {
    const query = queries[Number(queryId!.split('-')[1]) - 1];
    const key = query.query.name ?? query.query.type ?? '';
    return (pools[typeof key === 'string' ? key : ''] ?? []).filter(row => ids.includes(row.id));
  });
  return { dependencies: { tradeClient: client, ninjaClient: ninja, statMapper: new StatMapper(), skillGemService: gems,
    shoppingDependencies: { baseLookup: () => null } }, client, queries };
}
const options: BudgetBuildOptions = { league: 'Fixture League', budget: 10, currency: 'exalted', includeGems: false,
  slots: ['Ring 1', 'Ring 2'], itemRequirements: { 'Ring 2': { itemName: 'Second Ring' } } };

describe('PoE2 budget allocation', () => {
  it('retains both weapon sets, disabled groups and exact gem selections without altering the snapshot', async () => {
    const source = evidence(), before = JSON.stringify(source);
    const plan = await new BudgetBuildService({ skillGemService: gems, shoppingDependencies: { baseLookup: () => null } }).createPlan(source, 'Fixture');
    expect(plan.loadout.selection).toEqual({ itemSetId: '7', weaponSet: 2, skillSetId: '9' });
    expect(plan.loadout.equipment.map(row => row.itemId)).toEqual(['22', '23', '1', '31']);
    expect(plan.loadout.equipment.find(row => row.slot === 'Weapon 1')?.activeWeaponSet).toBe(false);
    expect(plan.loadout.mainGroupIndex).toBe(2);
    expect(plan.loadout.groups[0].enabled).toBe(false);
    expect(plan.loadout.groups[1]).toMatchObject({ mainActiveSkill: 2, mainActiveSkillCalcs: 1 });
    expect(plan.loadout.groups[1].gems[1]).toMatchObject({ level: 18, statSet: { Selected: 2 }, naturalMaxLevel: 20 });
    expect(plan.loadout.groups[1].gems[2]).toMatchObject({ level: 1, isSupport: true });
    expect(plan.loadout.groups[1].gems[3].level).toBeUndefined();
    expect(plan.loadout.groups[2].source).toBe('Item:31');
    expect(plan.loadout.runes.find(row => row.slot === 'Helmet')?.occupied).toEqual(['Selected Rune']);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('allocates the cheapest quoted alternatives within one total allowance without reusing a listing', async () => {
    const m = market({ 'Selected Unique': [listing('shared', 2), listing('expensive', 8)],
      'Second Ring': [listing('shared', 2), listing('second', 4, 'exalted', 'Second Ring')] });
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', { ...options, budget: 5 });
    expect(plan.entries.map(row => row.candidate?.listingId)).toEqual(['shared', undefined]);
    expect(plan.budget).toMatchObject({ quotedSpend: 2, remaining: 3, proposed: 1, deferred: 1 });
    expect(plan.entries[0].native).toBeUndefined();
    expect(m.queries[0].query.name).toBe('Selected Unique');
    expect(plan.shopping.items[0].requirements.fireResist).toBe(32);
    const affordable = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', { ...options, budget: 6 });
    expect(affordable.entries.map(row => row.candidate?.listingId)).toEqual(['shared', 'second']);
    expect(affordable.budget).toMatchObject({ quotedSpend: 6, remaining: 0 });
  });

  it('accounts in the explicit currency only when an exchange rate is known', async () => {
    const m = market({ 'Selected Unique': [listing('quoted', 5)] }, new Map([['exalted', 2], ['divine', 200]]));
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', {
      ...options, budget: 0.1, currency: 'Divine Orb', slots: ['Ring 1'], itemRequirements: undefined,
    });
    expect(plan.budget).toMatchObject({ currency: 'divine', quotedSpend: 0.05, remaining: 0.05 });
    expect(plan.entries[0].candidate).toMatchObject({ listingId: 'quoted', price: { amount: 5, currency: 'exalted' },
      source: { league: 'Fixture League', queryId: 'query-1', indexed: '2026-09-15T00:00:00Z' } });
    expect(plan.entries[0].candidate?.url).toContain('/trade2/search/poe2/Fixture%20League/query-1');
  });

  it('keeps missing prices, zero prices and missing conversion rates out of proposed spending', async () => {
    const m = market({ 'Selected Unique': [listing('missing'), listing('zero', 0), listing('foreign', 1, 'divine')] });
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', options);
    expect(plan.budget).toMatchObject({ quotedSpend: 0, remaining: 10, proposed: 0 });
    expect(plan.entries.every(row => row.decision === 'defer')).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/valuation|value is unknown/);
  });

  it('keeps a zero purchase allowance while preserving all current equipment', async () => {
    const m = market({ 'Selected Unique': [listing('priced', 1)] });
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', { ...options, budget: 0 });
    expect(plan.budget).toMatchObject({ quotedSpend: 0, remaining: 0, proposed: 0 });
    expect(plan.loadout.equipment).toHaveLength(4);
  });

  it('fits exact decimal asking prices at the total budget boundary', async () => {
    const m = market({ 'Selected Unique': [listing('first', 0.1)], 'Second Ring': [listing('second', 0.2, 'exalted', 'Second Ring')] });
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', { ...options, budget: 0.3 });
    expect(plan.budget).toMatchObject({ proposed: 2, quotedSpend: 0.3, remaining: 0 });
  });

  it('rejects a PoE1 market client before using any listings or exchange quotes', async () => {
    const m = market({ 'Selected Unique': [listing('wrong-game', 1)] });
    Object.defineProperty(m.dependencies.tradeClient, 'game', { value: 'poe1' });
    await expect(new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', options)).rejects.toThrow(/PoE2.*market|market.*PoE2/i);
    expect(m.queries).toHaveLength(0);
  });

  it.each([NaN, Infinity, -1, '10', false])('rejects invalid numeric budgets (%s)', async budget => {
    await expect(new BudgetBuildService().createPlan(evidence(), 'Fixture', { budget: budget as number, currency: 'exalted' })).rejects.toThrow(/finite/);
  });
  it('requires a currency and rejects unknown tiers and PoE1 inputs', async () => {
    const service = new BudgetBuildService();
    await expect(service.createPlan(evidence(), 'Fixture', { budget: 10 })).rejects.toThrow(/currency/);
    await expect(service.createPlan(evidence(), 'Fixture', { budgetTier: 'cheapish' })).rejects.toThrow(/tier/);
    const poe1 = evidence(); poe1.build.__xmlRoot = 'PathOfBuilding';
    await expect(service.createPlan(poe1, 'Fixture')).rejects.toThrow(/PathOfBuilding2/);
  });

  it('does not turn blank or malformed saved outputs into measured zeros', async () => {
    const source = evidence();
    source.stats = { Life: '  ', EnergyShield: [], Armour: false, Evasion: 'NaN', MissingFireResist: 0 };
    const plan = await new BudgetBuildService({ skillGemService: gems, shoppingDependencies: { baseLookup: () => null } }).createPlan(source, 'Fixture');
    expect(plan.snapshot.stats).toEqual({ MissingFireResist: 0 });
  });

  it('defers a target gem when its real level or attribute requirements are unmet or unknown', async () => {
    const gemListing = listing('gem', 1, 'exalted', '');
    gemListing.item.typeLine = 'Selected Skill'; gemListing.item.baseType = 'Selected Skill';
    gemListing.item.properties = [{ name: 'Level', values: [['20', 0]], displayMode: 0 }];
    const m = market({ 'Selected Skill': [gemListing] });
    for (const intelligence of [100, undefined]) {
      const source = evidence(); source.stats.Int = intelligence;
      const plan = await new BudgetBuildService(m.dependencies).createPlan(source, 'Fixture', { ...options, slots: [], itemRequirements: undefined, includeGems: true });
      expect(plan.entries.find(row => row.kind === 'gem')).toMatchObject({ decision: 'defer' });
      expect(plan.budget.proposed).toBe(0);
    }
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', { ...options, slots: [], itemRequirements: undefined, includeGems: true });
    expect(plan.entries.find(row => row.kind === 'gem')).toMatchObject({ decision: 'propose', candidate: { listingId: 'gem' } });
    expect(plan.shopping.items.filter(row => row.kind === 'gem')).toHaveLength(1);
    expect(plan.shopping.items[0].gem).toMatchObject({ currentLevel: 18, targetLevel: 20, requirementsMet: true });
  });

  it('retains actionable search requirements when market access fails or the search bound is reached', async () => {
    const m = market({});
    jest.spyOn(m.client, 'searchItems').mockRejectedValue(new Error('Synthetic HTTP 429'));
    const plan = await new BudgetBuildService(m.dependencies).createPlan(evidence(), 'Fixture', { ...options, maxSearches: 1 });
    expect(plan.shopping.items[0].search.query).toBeDefined();
    expect(plan.shopping.items[0].warnings.join(' ')).toContain('429');
    expect(plan.shopping.items[1].warnings.join(' ')).toMatch(/search limit/);
    expect(plan.budget.proposed).toBe(0);
  });
});

describe('PoE2 native budget evidence', () => {
  it('defers equipment whose combined native requirements fail despite valid individual results', async () => {
    const m = market({ 'Selected Unique': [listing('first', 2)], 'Second Ring': [listing('second', 3, 'exalted', 'Second Ring')] });
    const source = evidence(); source.source = 'live';
    const preservation = { xmlUnchanged: true, statsUnchanged: true, selectionsUnchanged: true, undoUnchanged: true,
      catalogUnchanged: true, treeUnchanged: true, cacheUnchanged: true };
    const service = new BudgetBuildService({ ...m.dependencies, evaluateItemCandidates: async request => request.combined
      ? { outcomes: [], failures: [], combined: { entryIds: request.candidates.map(candidate => candidate.entryId), before: { Life: 2100 },
          after: { Life: 2400 }, valid: false, warnings: ['Insufficient Int'], checkedAt: '2026-09-15T20:00:00Z', conditions: {}, preservation } }
      : { failures: [], outcomes: request.candidates.map(candidate => ({ snapshotId: request.snapshotId, entryId: candidate.entryId,
          listingId: candidate.quote.listingId, candidateFingerprint: candidate.candidateFingerprint, engine: 'PoB2' as const,
          checkedAt: '2026-09-15T20:00:00Z', valid: true, before: { Life: 2100 }, after: { Life: 2200 },
          conditions: { calculationMode: 'CALCULATOR' }, rollback: preservation })) } });
    const plan = await service.createPlan(source, 'Fixture', options, { expectedXml: xml, expectedBuildName: 'Fixture' });
    expect(plan.entries.every(entry => entry.decision === 'defer')).toBe(true);
    expect(plan.budget).toMatchObject({ quotedSpend: 0, remaining: 10, proposed: 0 });
    expect(plan.combinedNative?.valid).toBe(false);
  });

  it('uses unsaved matching native selections and outputs through read-only calls', async () => {
    const fixture = context();
    const unsaved = xml.replace('Selected Unique', 'Unsaved Unique');
    const groupModel = await gems.prepareBuild(parser.parseBuildContent(unsaved));
    const client = { getBuildInfo: async () => ({ name: 'Fixture', className: 'Witch', level: 93 }),
      exportBuildXml: async () => unsaved, getStats: async () => ({ Life: 2300, MissingFireResist: 4 }),
      getSkills: async () => ({ activeSkillSetId: '9', mainSocketGroup: 2, groups: groupModel.groups.map(group => ({
        ...group, gems: group.gems.map(gem => ({ ...gem, is_support: gem.isSupport })),
      })) }), getGemDetail: async () => undefined };
    const plan = await createBudgetBuildPlan({ ...fixture.context, getLuaClient: () => client as any }, 'Fixture.xml');
    expect(plan.snapshot).toMatchObject({ source: 'live', stats: { Life: 2300, MissingFireResist: 4 } });
    expect(plan.loadout.equipment[0].name).toBe('Unsaved Unique');
    expect(JSON.stringify(fixture.build)).not.toContain('Unsaved Unique');
  });

  it('excludes another live build and does not start or load a runtime to obtain stats', async () => {
    const fixture = context();
    const client = { getBuildInfo: async () => ({ name: 'Different' }) };
    const plan = await createBudgetBuildPlan({ ...fixture.context, getLuaClient: () => client as any }, 'Fixture');
    expect(plan.snapshot.source).toBe('file');
    expect(plan.snapshot.stats.Life).toBe(2100);
  });

  it('detects changes to the live build during planning before returning a mixed snapshot', async () => {
    const fixture = context(); let reads = 0;
    const client = { getBuildInfo: async () => ({ name: 'Fixture' }),
      exportBuildXml: async () => ++reads === 1 ? xml : xml.replace('Selected Unique', 'Changed Unique'),
      getStats: async () => ({ Life: 2100 }), getSkills: async () => ({ activeSkillSetId: '9', groups: [] }),
      getGemDetail: async () => undefined };
    await expect(createBudgetBuildPlan({ ...fixture.context, getLuaClient: () => client as any }, 'Fixture')).rejects.toThrow(/changed|missing/i);
  });

  it('reports only snapshot-matched native deltas with rollback and never adds individual effects', async () => {
    const firstListing = listing('first', 2);
    const m = market({ 'Selected Unique': [firstListing], 'Second Ring': [listing('second', 3, 'exalted', 'Second Ring')] });
    const source = evidence(); source.source = 'live';
    const initial = await new BudgetBuildService(m.dependencies).createPlan(source, 'Fixture', options);
    const native: BudgetNativeOutcome[] = initial.entries.map((entry, index) => ({
      snapshotId: initial.snapshot.id, entryId: entry.id, listingId: entry.candidate!.listingId,
      candidateFingerprint: entry.candidateFingerprint!,
      engine: 'PoB2', checkedAt: '2026-09-15T12:00:00Z', valid: true,
      before: { Life: 2100 }, after: { Life: 2200 + index * 100 }, conditions: { enemy: 'fixture' },
      rollback: { xmlUnchanged: true, statsUnchanged: true, selectionsUnchanged: true, undoUnchanged: true },
    }));
    const service = new BudgetBuildService({ ...m.dependencies, evaluateItemCandidates: async () => ({ outcomes: native, failures: [] }) });
    const plan = await service.createPlan(source, 'Fixture', options, { expectedXml: xml, expectedBuildName: 'Fixture' });
    expect(plan.entries[0].native?.deltas.Life).toMatchObject({ before: 2100, after: 2200, absolute: 100 });
    expect(plan.entries[1].native?.deltas.Life.absolute).toBe(200);
    expect(plan.snapshot.stats.Life).toBe(2100);
    expect(plan.warnings.join(' ')).toMatch(/cannot be summed/);
    firstListing.item.explicitMods!.push('+5 to maximum Life');
    const changedItem = await service.createPlan(source, 'Fixture', options, { expectedXml: xml, expectedBuildName: 'Fixture' });
    expect(changedItem.entries[0].native).toBeUndefined();
    firstListing.item.explicitMods!.pop();
    source.stats.Life = 2000;
    const stale = await service.createPlan(source, 'Fixture', options, { expectedXml: xml, expectedBuildName: 'Fixture' });
    expect(stale.entries.every(entry => entry.native === undefined)).toBe(true);
    source.stats.Life = 2100; native[0].rollback.xmlUnchanged = false;
    const unsafe = await service.createPlan(source, 'Fixture', options, { expectedXml: xml, expectedBuildName: 'Fixture' });
    expect(unsafe.entries[0].decision).toBe('defer');
    expect(unsafe.shopping.items[0].warnings.join(' ')).toMatch(/rollback/);
  });
});
