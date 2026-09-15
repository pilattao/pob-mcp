import { ValidationService } from '../../src/services/validationService.js';
import type { PoBBuild } from '../../src/types.js';

const service = new ValidationService();
const build = (stats: Record<string, unknown> = {}): PoBBuild => ({
  __xmlRoot: 'PathOfBuilding2', Build: { level: '93', PlayerStat: Object.entries(stats).map(([stat, value]) => ({ stat, value: String(value) })) },
  Tree: { Spec: { treeVersion: '0_5' } },
});
const report = (b: PoBBuild, stats?: any) => service.formatValidation(service.validateBuild(b, null, stats));

describe('PoE2 native validation', () => {
  it('does not apply PoE1 life, flask, aura, suppression or damage-scaling heuristics', () => {
    const b = build({ Life: 2502, EnergyShield: 2022, Mana: 983, ManaUnreserved: 983, ManaRegenRecovery: 45.8, ManaCost: 0, SpiritUnreserved: 4, PhysicalMaximumHitTaken: 7053, LifeLeechGainRate: 560.448, FireResist: 75 });
    const text = report(b);
    expect(text).not.toMatch(/5500|Scion|Staunching.*suffix|of Heat|Pantheon|suppression|Discipline|Enlighten|Elreon|Precision|Clarity|\/3 Defensive|Life Pool Too Low/i);
    expect(text).toContain('7053');
    expect(text).toMatch(/configuration/i);
  });

  it('uses native missing resistance and resource costs, including zeros', () => {
    const v = service.validateBuild(build(), null, { FireResist: 75, MissingFireResist: 5, ManaCost: 60, ManaUnreserved: 0, SpiritUnreserved: -10 });
    expect(v.criticalIssues.find(i => i.category === 'resistances')).toMatchObject({ currentValue: 75, recommendedValue: 80 });
    expect(v.criticalIssues.find(i => i.category === 'mana')).toMatchObject({ currentValue: 0, recommendedValue: 60 });
    expect(JSON.stringify(v)).toMatch(/Spirit/);
  });

  it('preserves missing, non-finite and partial live data as unknown', () => {
    for (const stats of [{}, { Life: NaN, ManaUnreserved: Infinity, FireResist: '' }, { Mana: 500 }]) {
      const v = service.validateBuild(build({ FireResist: 0, Life: 1 }), null, stats);
      expect(v.criticalIssues).toEqual([]);
      expect(v.warnings).toEqual([]);
      expect(v.overallScore).toBeNull();
      expect(v.summary).toMatch(/unknown|unavailable|limited/i);
      expect(report(build(), stats)).not.toMatch(/Build looks great|ready for endgame|NaN|Infinity/);
    }
  });

  it('reports equipped charm protection conditionally, without treating flask flags as proof', () => {
    const b: any = build();
    b.Items = { activeItemSet: '2', Item: [
      { id: '1', '#text': 'Rarity: MAGIC\nMistbound Thawing Charm of the Doctor\nImplicits: 1\nUsed when you become Frozen' },
      { id: '2', '#text': 'Rarity: MAGIC\nStaunching Charm\nUsed when you start Bleeding' },
    ], ItemSet: [ { id: '1', Slot: { name: 'Charm 1', itemId: '2', active: 'true' } }, { id: '2', Slot: { name: 'Charm 1', itemId: '1', active: 'true' } } ] };
    const v = service.validateBuild(b, { hasFreezeImmunity: false, hasBleedImmunity: true } as any);
    const text = service.formatValidation(v);
    expect(text).toMatch(/Freeze protection.*conditional/i);
    expect(text).toMatch(/charges.*duration/i);
    expect(text).not.toMatch(/No Freeze Immunity|No Bleed Immunity|of Heat|Pantheon|Staunching/);
    expect(text).toMatch(/Bleeding protection.*unknown/i);
  });

  it('keeps explicit PoE1 validation even if the runtime is configured for PoE2', () => {
    const saved = process.env.POE_GAME; process.env.POE_GAME = 'poe2';
    try {
      const b = build({ Life: 2502 }); b.__xmlRoot = 'PathOfBuilding'; b.Tree = { Spec: { treeVersion: '3_26' } };
      expect(report(b)).toContain('5500');
    } finally { if (saved === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = saved; }
  });

  it('does not mistake keywords, inactive item sets or broken selections for charm protection', () => {
    const b: any = build();
    b.Items = { activeItemSet: '1', ItemSet: { id: '1', Slot: { name: 'Charm 1', Item: 'Rarity: MAGIC\nRuby Charm\nImplicits: 1\nCannot gain Charges while Frozen' } } };
    expect(report(b)).toMatch(/Freeze protection is unknown/);
    b.Items.activeItemSet = '99';
    b.Items.ItemSet.Slot.Item = 'Rarity: MAGIC\nThawing Charm';
    expect(report(b)).toMatch(/Freeze protection is unknown/);
  });

  it('labels disabled charms and conditional native avoidance without promising permanent immunity', () => {
    const b: any = build();
    b.Items = { ItemSet: { id: '1', Slot: { name: 'Charm 1', Item: 'Rarity: MAGIC\nThawing Charm', active: 'false' } } };
    const text = report(b, { FreezeAvoidChance: 100 });
    expect(text).toMatch(/not enabled in PoB/);
    expect(text).toMatch(/FreezeAvoidChance is 100% in this configuration/);
    expect(text).toMatch(/Permanent immunity is not established/);
  });

  it('checks actual native resource/attribute deficits but accepts low-cost skills and zero-cost triggers', () => {
    expect(service.validateBuild(build(), null, { ManaUnreserved: 10, ManaCost: 5, LifeUnreserved: 1, LifeCost: 0, SpiritUnreserved: 0 }).criticalIssues).toEqual([]);
    const v = service.validateBuild(build(), null, { LifeUnreserved: 10, LifeCost: 11, Str: 20, ReqStr: 30, NetManaRegen: -5, HitChance: 0 });
    expect(v.criticalIssues).toHaveLength(2);
    expect(v.warnings.some(i => i.title.includes('Mana Recovery'))).toBe(true);
    expect(v.recommendations.some(i => i.title.includes('Hit Chance'))).toBe(true);
  });
});
