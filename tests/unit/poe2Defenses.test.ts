import { BuildService } from '../../src/services/buildService.js';
import { handleAnalyzeDefenses, type OptimizationHandlerContext } from '../../src/handlers/optimizationHandlers.js';

// Synthetic data only. The native boundary is faked; evidence selection, XML
// parsing, validation, analysis and formatting all run their production code.
function xml(stats: Record<string, unknown> = {}, selections = ''): string {
  const rows = Object.entries(stats).map(([stat, value]) => `<PlayerStat stat="${stat}" value="${value}"/>`).join('');
  return `<PathOfBuilding2><Build level="90" className="Witch" ascendClassName="Blood Mage">${rows}</Build>${selections}</PathOfBuilding2>`;
}

function fixture(stats: Record<string, unknown> = {}, savedStats: Record<string, unknown> = { Life: 4321 }) {
  const builds = new BuildService('/unused');
  const saved = builds.parseBuildContent(xml(savedStats));
  jest.spyOn(builds, 'readBuild').mockResolvedValue(saved);
  const client = {
    marker: 'native',
    getBuildInfo: jest.fn(async () => ({ name: 'Selected', level: 90, className: 'Witch', game: 'poe2' })),
    exportBuildXml: jest.fn(async () => xml()),
    getStats: jest.fn(async function(this: { marker: string }, fields?: string[]) {
      if (this.marker !== 'native') throw new Error('Lost native client receiver');
      // Default subset deliberately omits fields that need explicit requests.
      const requested = fields ?? ['Life', 'EnergyShield', 'TotalEHP'];
      return Object.fromEntries(requested.filter(key => key in stats).map(key => [key, stats[key]]));
    }),
    loadBuildXml: jest.fn(async () => { throw new Error('Defense analysis must not load builds'); }),
    saveBuild: jest.fn(async () => { throw new Error('Defense analysis must not save builds'); }),
  };
  const context: OptimizationHandlerContext = {
    buildService: builds, treeService: {} as any, pobDirectory: '/unused',
    getLuaClient: () => client as any, ensureLuaClient: async () => {},
  };
  return { context, client, builds, saved };
}

function report(result: Awaited<ReturnType<typeof handleAnalyzeDefenses>>): string {
  return result.content.map(part => 'text' in part ? part.text : '').join('\n');
}

describe('PoE2 defense evidence and analysis', () => {
  const originalGame = process.env.POE_GAME;
  beforeEach(() => { process.env.POE_GAME = 'poe2'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalGame === undefined) delete process.env.POE_GAME;
    else process.env.POE_GAME = originalGame;
  });

  it('analyzes the unsaved current build without a filename and accepts CI life', async () => {
    const { context, client, builds } = fixture({ Life: 1, EnergyShield: 7123, ChaosResist: 100, MissingChaosResist: 0 });
    const result = await handleAnalyzeDefenses(context);
    expect(report(result)).toMatch(/Life: 1\b/);
    expect(report(result)).toContain('Energy Shield: 7123');
    expect(report(result)).toContain('including unsaved selections');
    expect(report(result)).not.toMatch(/empty state|critical.*life|life.*too low/i);
    expect(builds.readBuild).not.toHaveBeenCalled();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
    expect(client.saveBuild).not.toHaveBeenCalled();
  });

  it('keeps unsaved selections and native outputs when the requested identity matches', async () => {
    const { context, client } = fixture({ Life: 2345, Ward: 210 });
    client.exportBuildXml.mockResolvedValue(xml({}, `
      <Tree activeSpec="2"><Spec title="Saved tree"/><Spec title="Unsaved tree"/></Tree>
      <Items activeItemSet="7"><ItemSet id="1" title="Saved gear"/><ItemSet id="7" title="Unsaved gear"/></Items>
      <Skills activeSkillSet="3"><SkillSet id="3" title="Unsaved skills" mainSocketGroup="2"/></Skills>
      <Config activeConfigSet="2"><ConfigSet id="1" title="Inactive"><Input name="enemyPhysicalDamage" number="98765"/></ConfigSet>
      <ConfigSet id="2" title="Unsaved config"><Input name="enemyPhysicalDamage" number="1234"/><Input name="conditionLeeching" boolean="false"/></ConfigSet></Config>`));
    const result = await handleAnalyzeDefenses(context, 'Selected.xml');
    const text = report(result);
    for (const expected of ['Life: 2345', 'Ward: 210', 'Unsaved tree', 'Unsaved gear', 'Unsaved skills', 'Unsaved config', 'enemyPhysicalDamage: 1234', 'conditionLeeching: false']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/4321|98765|Saved tree|Saved gear/);
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('excludes a different live build including same-basename collisions', async () => {
    const { context, client } = fixture({ Life: 99999, TotalEHP: 88888 }, { Life: 2222, EnergyShield: 3333 });
    client.getBuildInfo.mockResolvedValue({ name: 'Other/Selected', level: 90, className: 'Witch', game: 'poe2' });
    const result = await handleAnalyzeDefenses(context, 'Folder/Selected.xml');
    expect(report(result)).toContain('Life: 2222');
    expect(report(result)).toContain('Energy Shield: 3333');
    expect(report(result)).toContain('live build is excluded');
    expect(report(result)).not.toMatch(/99999|88888/);
    expect(client.getStats).not.toHaveBeenCalled();
    expect(client.exportBuildXml).not.toHaveBeenCalled();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('reports saved native measurements when the live connection is unavailable', async () => {
    const { context } = fixture({}, { Life: 1, EnergyShield: 6123, PhysicalMaximumHitTaken: 8123 });
    context.ensureLuaClient = async () => { throw new Error('Offline'); };
    context.getLuaClient = () => null;
    const result = await handleAnalyzeDefenses(context, 'Selected.xml');
    expect(report(result)).toContain('saved stats can be stale');
    expect(report(result)).toContain('Physical maximum hit: 8123');
  });

  it('does not replace a missing requested file with the active build', async () => {
    const { context, builds, client } = fixture({ Life: 99999 });
    jest.spyOn(builds, 'readBuild').mockRejectedValue(new Error('Requested file missing'));
    await expect(handleAnalyzeDefenses(context, 'Absent.xml')).rejects.toThrow('Requested file missing');
    expect(client.getStats).not.toHaveBeenCalled();
  });

  it('reads an explicitly named unsaved native build when no saved XML exists', async () => {
    const { context, builds, client } = fixture({ Life: 1, EnergyShield: 7123, Ward: 0 });
    jest.spyOn(builds, 'readBuild').mockRejectedValue(Object.assign(new Error('Saved XML absent'), { code: 'ENOENT' }));
    const text = report(await handleAnalyzeDefenses(context, 'Selected.xml'));
    expect(text).toContain('Life: 1');
    expect(text).toContain('Energy Shield: 7123');
    expect(text).toContain('Ward: 0');
    expect(text).toContain('including unsaved selections');
    expect(client.loadBuildXml).not.toHaveBeenCalled();
    expect(client.saveBuild).not.toHaveBeenCalled();
  });

  it('rejects a missing file whose basename matches a different native path', async () => {
    const { context, builds, client } = fixture({ Life: 99999 });
    jest.spyOn(builds, 'readBuild').mockRejectedValue(Object.assign(new Error('Saved XML absent'), { code: 'ENOENT' }));
    client.getBuildInfo.mockResolvedValue({ name: 'Other/Selected', level: 90, className: 'Witch', game: 'poe2' });
    await expect(handleAnalyzeDefenses(context, 'Folder/Selected.xml')).rejects.toThrow();
    expect(client.getStats).not.toHaveBeenCalled();
    expect(client.exportBuildXml).not.toHaveBeenCalled();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('rejects a named unsaved read if the native build changes while collecting evidence', async () => {
    const { context, builds, client } = fixture({ Life: 99999 });
    jest.spyOn(builds, 'readBuild').mockRejectedValue(Object.assign(new Error('Saved XML absent'), { code: 'ENOENT' }));
    client.getBuildInfo.mockResolvedValueOnce({ name: 'Selected', level: 90, className: 'Witch', game: 'poe2' });
    client.getBuildInfo.mockResolvedValue({ name: 'Other', level: 90, className: 'Witch', game: 'poe2' });
    await expect(handleAnalyzeDefenses(context, 'Selected.xml')).rejects.toThrow();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('does not hide file permission errors behind a matching live build', async () => {
    const { context, builds, client } = fixture({ Life: 99999 });
    jest.spyOn(builds, 'readBuild').mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    await expect(handleAnalyzeDefenses(context, 'Selected.xml')).rejects.toThrow('Permission denied');
    expect(client.getStats).not.toHaveBeenCalled();
  });

  it('returns an evidence error when neither a filename nor live build is available', async () => {
    const { context } = fixture();
    context.getLuaClient = () => null;
    await expect(handleAnalyzeDefenses(context)).rejects.toThrow(/No current live PoB2 build/);
  });

  it('does not fill missing live outputs with saved file statistics', async () => {
    const { context } = fixture({ Life: 0, EnergyShield: 3200 }, { Life: 4321, TotalEHP: 88888, Ward: 999 });
    const text = report(await handleAnalyzeDefenses(context, 'Selected.xml'));
    expect(text).toContain('Life: 0');
    expect(text).toContain('Native TotalEHP: unknown');
    expect(text).toContain('Ward: unknown');
    expect(text).not.toMatch(/4321|88888|999/);
  });

  it('requests actual hybrid, maximum-hit, recovery and configured avoidance outputs', async () => {
    const { context } = fixture({
      Life: 2100, LifeUnreserved: 1700, LifeRecoverable: 1500,
      EnergyShield: 1900, EnergyShieldRecoveryCap: 1800, Mana: 950, ManaUnreserved: 800, Ward: 250,
      TotalEHP: 27123, PhysicalMaximumHitTaken: 6345, FireMaximumHitTaken: 18000,
      ColdMaximumHitTaken: 17000, LightningMaximumHitTaken: 16000, ChaosMaximumHitTaken: 4000,
      LifeRegenRecovery: 32.5, LifeLeechGainRate: 440, EnergyShieldRegenRecovery: 22,
      EnergyShieldLeechGainRate: 55, EnergyShieldRecharge: 320, EnergyShieldRechargeDelay: 3.25,
      WardRechargeDelay: 4.5, ManaRegenRecovery: 38, ManaLeechGainRate: 60,
      Evasion: 10000, EvadeChance: 17, ConfiguredEvadeChance: 0, EffectiveBlockChance: 0, BlockChance: 70,
      DeflectChance: 31, DeflectEffect: 42, Armour: 4000, PhysicalDamageReduction: 18,
      sharedMindOverMatter: 25, PhysicalTotalPool: 4750, ChaosTotalPool: 3700,
    });
    const text = report(await handleAnalyzeDefenses(context));
    for (const expected of [
      'Life recoverable: 1500', 'Mana unreserved: 800', 'Energy Shield recovery cap: 1800', 'Ward: 250',
      'Native TotalEHP: 27123', 'Physical maximum hit: 6345', 'Chaos maximum hit: 4000',
      'Life regeneration/recovery: 32.5/s', 'Life leech and on-hit gain: 440/s',
      'Energy Shield regeneration/recovery: 22/s', 'Energy Shield leech and on-hit gain: 55/s',
      'Energy Shield recharge: 320/s', 'Energy Shield recharge delay: 3.25s', 'Ward recharge delay: 4.5s',
      'Mana regeneration/recovery: 38/s', 'Mana leech and on-hit gain: 60/s', 'Evade chance: 17%',
      'Configured evade chance: 0%', 'Effective block chance: 0%', 'Deflect chance: 31%', 'Deflect effect: 42%',
      'Shared damage taken from mana before life: 25%', 'Physical native pool: 4750',
    ]) expect(text).toContain(expected);
    expect(text).toMatch(/lowest measured maximum hit.*Chaos.*4000/i);
    expect(text).toMatch(/leech.*selected skill|selected skill.*leech/i);
    expect(text).toMatch(/recharge.*delay|delay.*recharge/i);
    expect(text).not.toMatch(/5500|Determination|suppression|endurance charges|\/3|excellent|defenses look solid/i);
  });

  it.each([undefined, 0, 100])('preserves native TotalEHP %s without a mitigation estimate', async totalEhp => {
    const { context } = fixture({ Life: 2000, EnergyShield: 3000, Mana: 4000, Ward: 5000, PhysicalDamageReduction: 50, TotalEHP: totalEhp });
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toContain(`Native TotalEHP: ${totalEhp ?? 'unknown'}`);
    expect(text).not.toMatch(/EHP: (10000|14000|28000)|%.*EHP (gain|increase)|Overall:.*(POOR|GOOD|CRITICAL)/);
  });

  it('does not estimate evasion from rating or confuse missing with measured zero', async () => {
    const { context } = fixture({ Evasion: 40000, EvadeChance: undefined, EffectiveBlockChance: 0, BlockChance: 75 });
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toContain('Evade chance: unknown');
    expect(text).toContain('Effective block chance: 0%');
    expect(text).not.toMatch(/~.*evade|all hits land|no significant avoidance/i);
  });

  it('keeps invalid or nonfinite numbers unknown and does not emit false deficits', async () => {
    const { context } = fixture({ Life: true, Mana: '', Ward: 'garbage', TotalEHP: Infinity, EvadeChance: NaN, FireResist: false });
    const text = report(await handleAnalyzeDefenses(context));
    for (const label of ['Life', 'Mana', 'Ward', 'Native TotalEHP', 'Evade chance']) expect(text).toContain(`${label}: unknown`);
    expect(text).not.toMatch(/NaN|Infinity|Fire Resistance Below|CRITICAL|No issues found/);
  });

  it('compares resistance with the native missing amount instead of assuming a 75% cap', async () => {
    const { context } = fixture({ FireResist: 75, MissingFireResist: 5, ColdResist: 80, MissingColdResist: 0, ColdResistOverCap: 0, ChaosResist: 0 });
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toMatch(/Fire: 75%; configured cap: 80%; missing: 5%/);
    expect(text).toMatch(/Cold: 80%; configured cap: 80%; missing: 0%/);
    expect(text).toMatch(/Chaos: 0%; configured cap: unknown; missing: unknown/);
    expect(text).toContain('Fire Resistance Below Configured Cap');
    expect(text).not.toMatch(/Cold.*overcapped/i);
  });

  it('reports measured recovery deficits without calling conditional leech permanent sustain', async () => {
    const { context } = fixture({ Life: 1700, LifeRegenRecovery: -12, LifeLeechGainRate: 500, NetManaRegen: -6, ManaUnreserved: 0, ManaCost: 15 });
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toContain('Life regeneration/recovery: -12/s');
    expect(text).toContain('Selected Skill Mana Cost Exceeds Available Pool');
    expect(text).toContain('Configured Mana Recovery Deficit');
    expect(text).toMatch(/Life.*recovery deficit/i);
    expect(text).not.toMatch(/leech: active|sustain: excellent|%.*EHP/i);
  });

  it('labels the minimum as only the lowest measured maximum hit when types are missing', async () => {
    const { context } = fixture({ PhysicalMaximumHitTaken: 4000, FireMaximumHitTaken: 0 });
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toMatch(/lowest measured maximum hit.*Fire.*0/i);
    expect(text).toContain('Cold maximum hit: unknown');
    expect(text).toMatch(/unmeasured damage types.*unknown/i);
  });

  it('does not borrow configuration from an invalid selected set or label placeholders explicit', async () => {
    const { context, client } = fixture({ Life: 2000 });
    client.exportBuildXml.mockResolvedValue(xml({}, '<Config activeConfigSet="99"><ConfigSet id="1" title="Other config"><Input name="enemyPhysicalDamage" number="76543"/></ConfigSet></Config>'));
    let text = report(await handleAnalyzeDefenses(context));
    expect(text).not.toMatch(/76543|Other config/);
    expect(text).toMatch(/configuration.*unknown/i);
    client.exportBuildXml.mockResolvedValue(xml({}, '<Config><Input name="enemyPhysicalDamage" number="0"/><Placeholder name="enemyPhysicalDamage" number="9876"/></Config>'));
    text = report(await handleAnalyzeDefenses(context));
    expect(text).toContain('enemyPhysicalDamage: 0');
    expect(text).not.toContain('9876');
  });

  it('keeps charm protection tied to the unsaved selected item set', async () => {
    const { context, client } = fixture({ FreezeAvoidChance: 100 });
    client.exportBuildXml.mockResolvedValue(xml({}, `<Items activeItemSet="2">
      <Item id="1">Rarity: MAGIC\nStaunching Charm</Item><Item id="2">Rarity: MAGIC\nThawing Charm</Item>
      <ItemSet id="1"><Slot name="Charm 1" itemId="1" active="true"/></ItemSet>
      <ItemSet id="2"><Slot name="Charm 1" itemId="2" active="false"/></ItemSet></Items>`));
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toMatch(/Freeze protection is conditional/);
    expect(text).toMatch(/not enabled in PoB/);
    expect(text).toMatch(/Permanent immunity is not established/);
    expect(text).toMatch(/Bleeding protection is unknown/);
  });

  it('uses native XML locations for the selected skill group and weapon set', async () => {
    const { context, client } = fixture({ Life: 1700 });
    client.exportBuildXml.mockResolvedValue(xml({}, `
      <Items activeItemSet="2"><ItemSet id="1" useSecondWeaponSet="false"/><ItemSet id="2" useSecondWeaponSet="true"/></Items>
      <Skills activeSkillSet="4"><SkillSet id="4" title="Current skills"/></Skills>`)
      .replace('<Build ', '<Build mainSocketGroup="3" '));
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toContain('main group: 3');
    expect(text).toContain('Weapon set: 2');
  });

  it('shows recharge destination so a life-recharge mechanic is not reported as ES sustain', async () => {
    const { context } = fixture({ Life: 1900, EnergyShieldRecharge: 400,
      EnergyShieldRechargeAppliesToLife: true, EnergyShieldRechargeAppliesToEnergyShield: false });
    const text = report(await handleAnalyzeDefenses(context));
    expect(text).toContain('Energy Shield recharge applies to Life: true');
    expect(text).toContain('Energy Shield recharge applies to Energy Shield: false');
  });

  it('falls back to only saved measurements when the supplemental native read fails', async () => {
    const { context, client } = fixture({ Life: 99999, Ward: 7777 }, { Life: 2222 });
    client.getStats.mockImplementationOnce(async () => ({ Life: 99999, Ward: 7777 }));
    client.getStats.mockRejectedValue(new Error('Native derived output unavailable'));
    const text = report(await handleAnalyzeDefenses(context, 'Selected.xml'));
    expect(text).toContain('Life: 2222');
    expect(text).toContain('Ward: unknown');
    expect(text).not.toMatch(/99999|7777/);
  });

  it('discards all live fields if the active build changes during the evidence read', async () => {
    const { context, client } = fixture({ Life: 99999, Ward: 7777 }, { Life: 2222 });
    client.getBuildInfo.mockResolvedValueOnce({ name: 'Selected', level: 90, className: 'Witch', game: 'poe2' });
    client.getBuildInfo.mockResolvedValue({ name: 'Different', level: 90, className: 'Witch', game: 'poe2' });
    const result = await handleAnalyzeDefenses(context, 'Selected.xml');
    expect(report(result)).toContain('Life: 2222');
    expect(report(result)).not.toMatch(/99999|7777/);
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('rejects PoE1 XML in the PoE2 analysis path', async () => {
    const { context, client } = fixture({ Life: 2000 });
    client.exportBuildXml.mockResolvedValue('<PathOfBuilding><Build level="90"/></PathOfBuilding>');
    await expect(handleAnalyzeDefenses(context)).rejects.toThrow('PathOfBuilding2');
  });
});
