import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { handleGetBuildIssues, formatIssuesResponse } from '../../src/handlers/buildGoalsHandlers.js';
import { handleLuaLoadBuild, handleLuaStart } from '../../src/handlers/luaHandlers.js';
import { getBuildGoalsToolSchemas } from '../../src/server/toolSchemas.js';

const originalGame = process.env.POE_GAME;
beforeEach(() => { process.env.POE_GAME = 'poe2'; });
afterEach(() => { jest.restoreAllMocks(); if (originalGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = originalGame; });

const XML = `<PathOfBuilding2><Build level="84" className="Witch" ascendClassName="Blood Mage"/>
<Tree activeSpec="1"><Spec treeVersion="0_5" nodes=""/></Tree>
<Items activeItemSet="2"><Item id="1">Rarity: MAGIC
Thawing Charm
Used when you become Frozen</Item>
<ItemSet id="1"><Slot name="Charm 1" itemId="1" active="true"/></ItemSet>
<ItemSet id="2"><Slot name="Charm 1" itemId="0" active="false"/></ItemSet></Items></PathOfBuilding2>`;
const stats = {
  Life: 1800, LifeUnreserved: 1800, EnergyShield: 2300, Mana: 920, ManaUnreserved: 0, ManaCost: 0, LifeCost: 18,
  Spirit: 100, SpiritUnreserved: 3, Ward: 240, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 0,
  MissingFireResist: 0, MissingColdResist: 0, MissingLightningResist: 0, MissingChaosResist: 0,
  FireResistOverCap: 25, SpellSuppressionChance: 30, TotalDPS: 0, CombinedDPS: 0,
};

function context(overrides: Record<string, unknown> = {}, outputs: Record<string, unknown> = stats) {
  const client: any = {
    exportBuildXml: jest.fn<() => Promise<string>>().mockResolvedValue(XML),
    getStats: jest.fn<(fields?: string[]) => Promise<any>>().mockImplementation(async fields =>
      Object.fromEntries(Object.entries(outputs).filter(([key]) => !fields || fields.includes(key)))),
    getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ name: 'Synthetic', level: 84, className: 'Witch', ascendClassName: 'Blood Mage' }),
    getItems: jest.fn<() => Promise<any>>().mockResolvedValue([{ slot: 'Flask 3', id: 0 }]),
    getTree: jest.fn<() => Promise<any>>().mockResolvedValue({ nodes: [1, 2, 3], pointsUsed: 2 }),
    getSkills: jest.fn<() => Promise<any>>().mockResolvedValue({ groups: [] }),
    listSpecs: jest.fn<() => Promise<any>>().mockResolvedValue({ specs: [] }),
    listItemSets: jest.fn<() => Promise<any>>().mockResolvedValue({ itemSets: [] }),
    loadBuildXml: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ ready: true }),
    ...overrides,
  };
  return { client, getLuaClient: () => client, ensureLuaClient: async () => {}, stopLuaClient: async () => {}, pobDirectory: '/unused', luaEnabled: true };
}

const issuesText = (result: Awaited<ReturnType<typeof handleGetBuildIssues>>) => result.issues.map(i => i.message).join('\n');

describe('PoE2 quick issue scan', () => {
  it('uses native PoE2 rules instead of life, suppression, flask, overcap or zero-DPS heuristics', async () => {
    const result = await handleGetBuildIssues(context());
    expect(result.issues.filter(i => i.severity !== 'info')).toEqual([]);
    expect(issuesText(result)).not.toMatch(/suppression|wasted|\/5 flask|unspent|does 0 DPS|4000|5000/i);
    expect(issuesText(result)).toMatch(/limited.*PoE2|PoE2.*limited/i);
    expect(issuesText(result)).toMatch(/unknown/i);
  });

  it('checks configured resistance caps and actual Blood Mage skill costs', async () => {
    const result = await handleGetBuildIssues(context({}, { ...stats, MissingFireResist: 5, LifeCost: 1900, SpiritUnreserved: -8 }));
    expect(issuesText(result)).toMatch(/5% missing/);
    expect(issuesText(result)).toMatch(/1900.*life.*1800/i);
    expect(issuesText(result)).toMatch(/8.*Spirit/);
    expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(3);
  });

  it('reads the exported active item set without manufacturing empty gear or immunity', async () => {
    const ctx = context();
    const result = await handleGetBuildIssues(ctx);
    expect(issuesText(result)).toMatch(/Freeze protection is unknown/);
    expect(issuesText(result)).not.toMatch(/Freeze protection is conditional|slot.*empty/i);
    expect(ctx.client.getItems).not.toHaveBeenCalled();
  });

  it.each([{}, { Life: NaN, Mana: '', TotalEHP: Infinity, FireResist: false }])('keeps incomplete outputs unknown: %j', async outputs => {
    const result = await handleGetBuildIssues(context({}, outputs));
    const rendered = formatIssuesResponse(result.issues, result.stats).content[0].text;
    expect(result.issues.filter(i => i.severity !== 'info')).toEqual([]);
    expect(rendered).toMatch(/Life: unknown/);
    expect(rendered).toMatch(/Fire: unknown/);
    expect(rendered).not.toMatch(/NaN|Infinity|healthy|does 0 DPS|DPS: 0|Fire: 0%/);
  });

  it('reports failed XML and native reads without falling back to saved stat zeroes', async () => {
    const unavailable = jest.fn<() => Promise<any>>().mockRejectedValue(new Error('read failed'));
    const result = await handleGetBuildIssues(context({ exportBuildXml: unavailable, getStats: unavailable }));
    expect(issuesText(result)).toMatch(/XML.*unknown|unknown.*XML/i);
    expect(issuesText(result)).toMatch(/outputs.*unknown|unknown.*outputs/i);
    expect(result.issues.filter(i => i.severity !== 'info')).toEqual([]);
  });

  it('rejects a PoE1 export while selected for PoE2', async () => {
    const ctx = context({ exportBuildXml: async () => '<PathOfBuilding><Build level="80"/></PathOfBuilding>' });
    await expect(handleGetBuildIssues(ctx)).rejects.toThrow(/PoE2.*PoE1|PoE1.*PoE2/);
  });

  it('rejects explicit unsupported selection without any client reads', async () => {
    process.env.POE_GAME = 'wrong';
    const ctx = context();
    await expect(handleGetBuildIssues(ctx)).rejects.toThrow(/POE_GAME/);
    expect(ctx.client.getStats).not.toHaveBeenCalled();
  });

  it('exposes the updated scope in the get_build_issues schema', () => {
    const description = getBuildGoalsToolSchemas().find(t => t.name === 'get_build_issues').description;
    expect(description).toMatch(/PoE2/);
    expect(description).toMatch(/unknown/);
    expect(description).not.toMatch(/suppression|low life/);
  });
});

describe('PoE2 load summary and connection message', () => {
  it('includes ES, Mana, Spirit and Ward after load, without false health warnings', async () => {
    const ctx = context();
    const result = await handleLuaLoadBuild(ctx, undefined, XML, 'Synthetic');
    const text = result.content[0].text;
    expect(text).toMatch(/ES: 2,300/);
    expect(text).toMatch(/Mana: 920/);
    expect(text).toMatch(/Spirit: 100/);
    expect(text).toMatch(/Ward: 240/);
    expect(text).not.toMatch(/suppression|wasted|\/5 flask|unspent|does 0 DPS|No critical issues detected/);
    expect(text).toMatch(/unknown/);
    expect(ctx.client.loadBuildXml).toHaveBeenCalledWith(XML, 'Synthetic', '');
  });

  it('preserves unknown resource values and failed checks in the summary', async () => {
    const ctx = context({ getStats: async () => { throw new Error('stats unavailable'); } });
    const text = (await handleLuaLoadBuild(ctx, undefined, XML)).content[0].text;
    expect(text).toMatch(/ES: unknown/);
    expect(text).toMatch(/Mana: unknown/);
    expect(text).toMatch(/outputs.*unknown|unknown.*outputs/i);
    expect(text).not.toMatch(/DPS: 0|Life: 0|No critical issues detected/);
  });

  it('reports connection readiness without obsolete updater instructions', async () => {
    const text = (await handleLuaStart(context())).content[0].text;
    expect(text).toMatch(/started successfully|connected/i);
    expect(text).not.toMatch(/Update|Claude|Main\.lua|LaunchPoBWithAPI/);
  });
});

describe('PoE2 passive evidence in the quick scan', () => {
  it('counts selected XML allocations per weapon set using native node definitions', async () => {
    const native = await import('../../src/services/pobTreeDataLoader.js');
    jest.spyOn(native, 'getPobTreeData').mockReturnValue({ nodes: {
      '1': { skill: 1, type: 'ClassStart' }, '2': { skill: 2 }, '3': { skill: 3 }, '4': { skill: 4 },
      '5': { skill: 5, ascendancyName: 'Synthetic Ascendancy' }, '6': { skill: 6, isFreeAllocate: false },
    } } as any);
    const xml = `<PathOfBuilding2><Build level="80"/><Tree activeSpec="2">
      <Spec treeVersion="0_5" nodes="99"/>
      <Spec treeVersion="0_5" nodes="1,2,3,4,5,6"><WeaponSet1 nodes="3"/><WeaponSet2 nodes="4"/></Spec>
      </Tree></PathOfBuilding2>`;
    const ctx = context({ exportBuildXml: async () => xml });
    const text = issuesText(await handleGetBuildIssues(ctx));
    expect(text).toMatch(/weapon set 1 2 \/ 103; weapon set 2 2 \/ 103/);
    expect(text).toMatch(/Shared 1; weapon-specific 1 \/ 1/);
    expect(text).toMatch(/quest completion is unverified/);
    expect(text).not.toMatch(/unspent/);
    expect(ctx.client.getTree).not.toHaveBeenCalled();
  });

  it('does not use the last spec when the active selection is missing', async () => {
    const xml = `<PathOfBuilding2><Build level="80"/><Tree activeSpec="3">
      <Spec treeVersion="0_5" nodes=""/><Spec treeVersion="0_5" nodes=""/></Tree></PathOfBuilding2>`;
    const text = issuesText(await handleGetBuildIssues(context({ exportBuildXml: async () => xml })));
    expect(text).toMatch(/passive budget unknown.*selected tree spec/);
    expect(text).not.toMatch(/PoE2 passive spending/);
  });

  it('does not report partial spending when native allocated node definitions are missing', async () => {
    const native = await import('../../src/services/pobTreeDataLoader.js');
    jest.spyOn(native, 'getPobTreeData').mockReturnValue({ nodes: {} } as any);
    const xml = '<PathOfBuilding2><Build level="80"/><Tree><Spec treeVersion="0_5" nodes="999"/></Tree></PathOfBuilding2>';
    const text = issuesText(await handleGetBuildIssues(context({ exportBuildXml: async () => xml })));
    expect(text).toMatch(/passive budget unknown.*allocated node definitions/);
    expect(text).not.toMatch(/PoE2 passive spending/);
  });
});
