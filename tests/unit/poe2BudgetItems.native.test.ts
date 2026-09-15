import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { resolve } from 'path';
import { BudgetBuildService } from '../../src/services/budgetBuildService.js';
import { createBudgetItemEvaluator } from '../../src/services/budgetItemEvaluator.js';
import { BuildService } from '../../src/services/buildService.js';
import { TradeApiClient } from '../../src/services/tradeClient.js';
import { StatMapper } from '../../src/services/statMapper.js';
import { extractPoe2SkillSets } from '../../src/skillLinkOptimizer.js';
import { convertTradeItemForPob } from '../../src/services/tradeItemConversion.js';
import type { NativeItemEvaluation, NativeItemEvaluationRequest } from '../../src/types/nativeItemTypes.js';

const native = process.env.POE2_BUDGET_NATIVE_TEST === '1' ? describe : describe.skip;
native('Real isolated PoB2 budget item calculations', () => {
  let process: ChildProcessWithoutNullStreams;
  let snapshot: { xml: string; stats: Record<string, number>; name: string };
  let failure = '';
  let pending: { resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  beforeAll(async () => {
    const initial = new Promise<any>((resolve, reject) => { pending = { resolve, reject }; });
    process = spawn(resolve('../.venv/bin/python'), [resolve('../tests/poe2/item_evaluator_worker.py')], { stdio: 'pipe' });
    process.stderr.on('data', data => { failure += data.toString(); });
    process.on('error', error => pending?.reject(error));
    process.on('exit', code => { if (pending) pending.reject(new Error(`Isolated calculator exited ${code}: ${failure}`)); });
    createInterface({ input: process.stdout }).on('line', line => {
      const callback = pending; pending = undefined;
      if (!callback) return;
      try { const value = JSON.parse(line); if (value.error) callback.reject(new Error(value.error)); else callback.resolve(value); }
      catch (error) { callback.reject(new Error(`Invalid native test transport: ${line}`)); }
    });
    snapshot = await initial;
  }, 60000);
  afterAll(() => { process?.stdin.end(); process?.kill(); });
  afterEach(() => jest.restoreAllMocks());
  const evaluateItemReplacements = (request: NativeItemEvaluationRequest) => new Promise<NativeItemEvaluation>((resolve, reject) => {
    if (pending) throw new Error('Native test transport is sequential');
    pending = { resolve, reject }; process.stdin.write(JSON.stringify(request) + '\n');
  });
  function market(pools: Record<string, Array<{ id: string; amount: number; mods: string[]; extra?: Record<string, any> }>>) {
    const tradeClient = new TradeApiClient({ game: 'poe2' });
    const queries: any[] = [];
    jest.spyOn(tradeClient, 'getStats').mockResolvedValue({ result: [] });
    jest.spyOn(tradeClient, 'searchItems').mockImplementation(async (_league, query) => {
      queries.push(query); const name = query.query.name as string;
      return { id: `q${queries.length}`, result: (pools[name] ?? []).map(item => item.id), total: (pools[name] ?? []).length };
    });
    jest.spyOn(tradeClient, 'fetchItems').mockImplementation(async (ids, queryId) => {
      const name = queries[Number(queryId!.slice(1)) - 1].query.name;
      return (pools[name] ?? []).filter(item => ids.includes(item.id)).map(item => ({ id: item.id,
        listing: { price: { amount: item.amount, currency: 'exalted', type: '~b/o' }, indexed: '2026-09-15T20:00:00Z' },
        item: { id: item.id, league: 'Fixture League', frameType: 2, identified: true, ilvl: 80, name, baseType: 'Ruby Ring', typeLine: 'Ruby Ring',
          requirements: [{ name: 'Level', values: [['24', 0]] }], implicitMods: [], explicitMods: item.mods, ...item.extra },
      })) as any;
    });
    return { tradeClient, statMapper: new StatMapper(), shoppingDependencies: { baseLookup: () => null },
      skillGemService: { prepareBuild: async (build: any) => {
        const model = extractPoe2SkillSets(build); return { ...model, groups: model.selected.groups, catalog: [], notes: [] };
      } }, evaluateItemCandidates: createBudgetItemEvaluator({ evaluateItemReplacements }) };
  }
  function evidence() {
    return { build: new BuildService('/unused').parseBuildContent(snapshot.xml), stats: snapshot.stats, source: 'live' as const, note: 'Real isolated PoB2 calculator' };
  }
  function nativeOptions() { return { expectedXml: snapshot.xml, expectedBuildName: snapshot.name }; }

  it('calculates fetched budget rows individually and together, including nonlinear gear interactions', async () => {
    const deps = market({ First: [{ id: 'flat', amount: 2, mods: ['+100 to maximum Life'] }],
      Second: [{ id: 'percent', amount: 2, mods: ['10% increased maximum Life'] }] });
    const plan = await new BudgetBuildService(deps).createPlan(evidence(), snapshot.name, {
      league: 'Fixture League', budget: 4, currency: 'exalted', slots: ['Ring 1', 'Ring 2'], includeGems: false,
      itemRequirements: { 'Ring 1': { itemName: 'First' }, 'Ring 2': { itemName: 'Second' } },
    }, nativeOptions());
    expect(plan.entries.every(entry => entry.decision === 'propose' && entry.native !== undefined)).toBe(true);
    expect(plan.budget.quotedSpend).toBe(4);
    expect(plan.combinedNative?.valid).toBe(true);
    const together = plan.combinedNative!.after.Life - plan.combinedNative!.before.Life;
    const individual = plan.entries.reduce((total, entry) => total + entry.native!.deltas.Life.absolute, 0);
    expect(together).toBeGreaterThan(individual);
    expect(plan.combinedNative?.preservation).toEqual({ xmlUnchanged: true, statsUnchanged: true, selectionsUnchanged: true, undoUnchanged: true,
      catalogUnchanged: true, treeUnchanged: true, cacheUnchanged: true });
  }, 60000);

  it('chooses a positive native gain per currency when a metric is requested', async () => {
    const deps = market({ First: [{ id: 'weak', amount: 2, mods: ['+10 to maximum Life'] }, { id: 'strong', amount: 3, mods: ['+100 to maximum Life'] }] });
    const plan = await new BudgetBuildService(deps).createPlan(evidence(), snapshot.name, {
      league: 'Fixture League', budget: 3, currency: 'exalted', slots: ['Ring 1'], includeGems: false, nativeMetric: 'Life',
      itemRequirements: { 'Ring 1': { itemName: 'First' } },
    }, nativeOptions());
    expect(plan.entries[0].candidate?.listingId).toBe('strong');
    expect(plan.entries[0].native?.deltas.Life.absolute).toBe(105);
    expect(plan.entries[0].native?.deltas.Life.gainPerCurrency).toBe(35);
  }, 60000);

  it('defers incomplete conversion instead of filling in guessed native damage', async () => {
    const deps = market({ First: [{ id: 'unidentified', amount: 1, mods: ['+100 to maximum Life'], extra: { identified: false } }] });
    const plan = await new BudgetBuildService(deps).createPlan(evidence(), snapshot.name, {
      league: 'Fixture League', budget: 3, currency: 'exalted', slots: ['Ring 1'], includeGems: false,
      itemRequirements: { 'Ring 1': { itemName: 'First' } },
    }, nativeOptions());
    expect(plan.entries[0].decision).toBe('defer');
    expect(plan.entries[0].native).toBeUndefined();
    expect(plan.shopping.items[0].warnings.join(' ')).toMatch(/Incomplete native item conversion/);
  });

  it('round-trips real-shaped staff/Choir grants and scaled rune text with zero same-item native deltas', async () => {
    const staff: any = { id: 'staff', name: 'Native Staff Fixture', baseType: 'Voltaic Staff', typeLine: 'Voltaic Staff',
      frameType: 2, identified: true, ilvl: 80, properties: [{ name: 'Quality', values: [['+17%', 1]] }],
      requirements: [{ name: 'Level', values: [['55', 0]] }], sockets: [{ type: 'rune' }, { type: 'rune' }],
      socketedItems: [{ socket: 1, baseType: 'Iron Rune' }], runeMods: [{ description: '50% increased Spell Damage' }],
      grantedSkills: [{ name: 'Grants Skill', values: [['Level 18 Lightning Bolt', 25]] }],
      implicitMods: [], explicitMods: [{ description: '+300 to Intelligence' }, { description: '100% increased effect of Socketed Augment Items' }] };
    const choir: any = { id: 'choir', name: 'Choir of the Storm', baseType: 'Jade Amulet', typeLine: 'Jade Amulet',
      frameType: 3, identified: true, ilvl: 80, requirements: [{ name: 'Level', values: [['55', 0]] }],
      grantedSkills: [{ name: 'Grants Skill', values: [['Level 18 Lightning Bolt', 25]] }], implicitMods: [{ description: '+10 to Dexterity' }],
      explicitMods: [{ description: '+50% to Lightning Resistance' }, { description: 'Critical Hits Ignore Enemy Monster Lightning Resistance' },
        { description: 'Trigger Lightning Bolt Skill on Critical Hit' }] };
    const conversions = [staff, choir].map(convertTradeItemForPob);
    expect(conversions.every(item => item.complete)).toBe(true);
    const slots = ['Weapon 1', 'Amulet'];
    // Initial item lacks printed rune mods; native data derives the named rune's effect.
    const initial = conversions[0].text!.replace('{enchant}{rune}50% increased Spell Damage\n', '').replace('Implicits: 2', 'Implicits: 1');
    snapshot = await new Promise<any>((resolve, reject) => {
      pending = { resolve, reject }; process.stdin.write(JSON.stringify({ fixtureItems: [{ slot: slots[0], text: initial }, { slot: slots[1], text: conversions[1].text }] }) + '\n');
    });
    const selected = evidence().build as any;
    const replacements = conversions.map((conversion, i) => ({ slotName: slots[i], text: conversion.text!, expected: conversion.expected,
      candidateId: conversion.identity, entryId: `equipment:${slots[i]}`, listingId: [staff, choir][i].id }));
    const result = await evaluateItemReplacements({ expectedXml: snapshot.xml, expectedBuildName: snapshot.name, snapshotId: 'same-item-roundtrip',
      itemSetId: String(selected.Items?.activeItemSet), skillSetId: String(selected.Skills?.activeSkillSet), scenarios: [
        { id: 'staff', replacements: [replacements[0]] }, { id: 'choir', replacements: [replacements[1]] }, { id: 'both', replacements },
      ] });
    expect(result.comparisons.map(row => row.error)).toEqual([undefined, undefined, undefined]);
    for (const row of result.comparisons) {
      expect(row.output?.CombinedDPS).toBe(result.baseline.CombinedDPS);
      expect(row.output?.FullDPS).toBe(result.baseline.FullDPS);
      expect(row.skills?.groups.find(group => group.slot === 'Weapon 1')?.gems[0]).toMatchObject({ skillId: 'LightningBoltPlayer', level: 18 });
      expect(row.skills?.groups.find(group => group.slot === 'Amulet')?.gems[0]).toMatchObject({ skillId: 'UniqueBreachLightningBoltPlayer', level: 18 });
    }
    expect(Object.values(result.preservation).every(value => value === true)).toBe(true);
  }, 60000);
});
