import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeFileSync, rmSync } from 'fs';
import { useNativeCraftFixture, coeFixture } from '../fixtures/coreCraftNative';
import { handleAnalyzeItemMods } from '../../src/handlers/analyzeItemModsHandler';
import { handleListCraftableModsForBase } from '../../src/handlers/listCraftableModsHandler';
import { handleCalculateModOdds, type CalculateModOddsArgs } from '../../src/handlers/calculateModOddsHandler';
import { buildEligiblePool } from '../../src/services/oddsCalculator';
import { getBase } from '../../src/services/pobBaseDataLoader';

let fixture: ReturnType<typeof useNativeCraftFixture>;
beforeEach(() => { fixture=useNativeCraftFixture(); });
afterEach(() => fixture.cleanup());
const text=(r:{content:Array<{text:string}>})=>r.content.map(c=>c.text).join('\n');
const json=(r:{content:Array<{text:string}>})=>JSON.parse(text(r));
const fullPrefixes=['LocalIncreasedPhysicalDamagePercent1','LocalAddedFireDamageTwoHand1','LocalAddedColdDamageTwoHand1'];
function odds(overrides: Record<string,unknown>={}) {
  return handleCalculateModOdds({base_name:'Makeshift Crossbow',ilvl:86,method:'exalt',item_rarity:'rare',
    existing_mod_ids:fullPrefixes,targets:[{group:'Strength',min_tier:1}],raw_json:true,...overrides} as unknown as CalculateModOddsArgs);
}

describe('native PoE2 item definitions',()=>{
  it('matches native base, affix, absolute source tier and next tier without loading essence or bench data',async()=>{
    const r=json(await handleAnalyzeItemMods({base_name:'makeshift crossbow',ilvl:20,mod_lines:['+10 to Strength'],raw_json:true}));
    expect(r.game).toBe('poe2');expect(r.base.name).toBe('Makeshift Crossbow');
    expect(r.lines[0].match).toMatchObject({best:{id:'Strength2',affix:'of the Wrestler'},tier:2,tier_max:3,next_tier:{id:'Strength8',level:74}});
    expect(r.weight_semantics).toBe('eligibility-only');
  });
  it('does not call a PoE1 bench or lose natural analysis for a crafted annotation',async()=>{
    const r=json(await handleAnalyzeItemMods({base_name:'Makeshift Crossbow',mod_lines:['+10 to Strength','+20 to Strength {crafted}'],raw_json:true}));
    expect(r.lines[0].match.best.id).toBe('Strength2');
    expect(r.lines[1]).toMatchObject({source:'crafted',match:null,master_craft:null});
    expect(r.lines[1].coverage_gap).toMatch(/PoE2.*bench/i);
  });
  it('refuses out-of-range and impossible-ilvl best guesses as native matches',async()=>{
    const r=json(await handleAnalyzeItemMods({base_name:'Makeshift Crossbow',ilvl:1,mod_lines:['+999 to Strength','+10 to Strength'],raw_json:true}));
    expect(r.lines.every((line:{match:{best:unknown}})=>line.match.best===null)).toBe(true);
  });
  it('collapses actual hybrid templates but does not collapse repeated single-stat lines',async()=>{
    const r=json(await handleAnalyzeItemMods({base_name:'Makeshift Crossbow',ilvl:20,
      mod_lines:['17% increased Physical Damage','+18 to Accuracy Rating','+10 to Strength','+10 to Strength'],raw_json:true}));
    expect(r.lines[1].is_hybrid_continuation).toBe(true);
    expect(r.lines[1].match.best.id).toBe('LocalIncreasedPhysicalDamagePercentAndAccuracyRating1');
    expect(r.lines[3].is_hybrid_continuation).toBe(false);
  });
  it('lists absolute tiers after ilvl filtering and labels 1/0 flags as eligibility',async()=>{
    const r=json(await handleListCraftableModsForBase({base_name:'Makeshift Crossbow',ilvl:20,stat_contains:'Strength',raw_json:true}));
    expect(r.game).toBe('poe2');expect(r.weight_semantics).toBe('eligibility-only');
    expect(r.groups[0].entries[0]).toMatchObject({id:'Strength2',tier:2,weight:1,spawn_weight:null});
    expect(text(await handleListCraftableModsForBase({base_name:'Makeshift Crossbow'}))).toMatch(/not.*probabilit/i);
  });
  it('exposes zero-eligibility definitions only as unvalidated special-method entries',async()=>{
    const r=json(await handleListCraftableModsForBase({base_name:'Makeshift Crossbow',hide_unrollable:false,raw_json:true}));
    const special=r.groups.flatMap((g:{entries:unknown[]})=>g.entries).find((e:{id:string})=>e.id==='EssenceOnly');
    expect(special).toMatchObject({weight:0,tier:null,applicability:'special-method-unverified'});
  });
  it('does not send jewel or flask bases through the ordinary item pool',async()=>{
    expect((await handleListCraftableModsForBase({base_name:'Ruby'})).isError).toBe(true);
    expect((await handleAnalyzeItemMods({base_name:'Ruby',mod_lines:['+10 to Strength']})).isError).toBe(true);
  });
  it('blocks native eligibility values at the legacy probability-pool boundary',()=>{
    expect(()=>buildEligiblePool(getBase('Makeshift Crossbow')!,86)).toThrow(/eligibility.*probabilit/i);
  });
});

describe('bounded CoE-weighted PoE2 operations',()=>{
  it('calculates a single exalt from estimated CoE weights, not equal PoB eligibility',async()=>{
    const r=json(await odds());
    // Full prefixes leave 500+500 Strength, 500 Dexterity, 1000 attack speed.
    expect(r.combined_probability).toBeCloseTo(500/2500,12);
    expect(r.pool.total_weight).toBe(2500);
    expect(r.source).toMatchObject({game:'poe2',patch:'4.5.5.1.5',weight_kind:'estimated'});
    expect(r.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.estimated_attempts).toBeNull();expect(r.operation.added_modifiers).toBe(1);
  });
  it('uses the magic side cap for augmentation',async()=>{
    const r=json(await odds({method:'augment',item_rarity:'magic',existing_mod_ids:[fullPrefixes[0]]}));
    expect(r.combined_probability).toBeCloseTo(.2,12);
    expect(r.operation).toMatchObject({rarity_before:'magic',rarity_after:'magic',added_modifiers:1});
  });
  it('regals into rare affix limits while retaining the existing magic modifier',async()=>{
    const r=json(await odds({method:'regal',item_rarity:'magic',existing_mod_ids:[fullPrefixes[0]]}));
    expect(r.pool.total_weight).toBe(4300);
    expect(r.combined_probability).toBeCloseTo(500/4300,12);
    expect(r.operation).toMatchObject({rarity_before:'magic',rarity_after:'rare'});
  });
  it('keeps source tier ranks absolute at low item levels',async()=>{
    const r=json(await odds({ilvl:1}));
    expect(r.combined_probability).toBe(0);
    expect(r.targets[0].qualifying_mod_ids).toEqual(['Strength2']);
  });
  it('accounts for existing targets and cannot add two unmet families in one draw',async()=>{
    expect(json(await odds({targets:[{group:'Strength'},{group:'Dexterity'}]})).combined_probability).toBe(0);
    expect(json(await odds({targets:[{group:'LocalPhysicalDamagePercent'}]})).combined_probability).toBe(1);
    expect(json(await odds({targets:[{group:'LocalPhysicalDamagePercent',min_tier:1}]})).combined_probability).toBe(0);
  });
  it('blocks every group sharing an existing family, including another CoE group ID',async()=>{
    const b=coeFixture();b.data.modgroups.entries.find(g=>g.id===49)!.families=[147];writeFileSync(fixture.bundlePath,JSON.stringify(b));
    const r=json(await odds({existing_mod_ids:[...fullPrefixes,'Strength1'],targets:[{group:'AttackSpeed'}]}));
    expect(r.pool.total_weight).toBe(1000);expect(r.combined_probability).toBe(1);
  });
  it('honors max item levels and excludes essence/corrupted pools even when their weights are positive',async()=>{
    const b=coeFixture();b.data.mods.entries.find(m=>m.key==='Strength1')!.maxlvl=10;writeFileSync(fixture.bundlePath,JSON.stringify(b));
    const r=json(await odds());expect(r.pool.total_weight).toBe(2000);expect(r.combined_probability).toBe(.25);
  });
  it('accepts an unresolved stat ID in an excluded special pool but withholds odds if it affects an ordinary pool',async()=>{
    const b=coeFixture();
    const special=b.data.mods.entries.find(m=>m.key==='EssenceOnly')!;
    (special.stats[0] as {index:number|null}).index=null;
    writeFileSync(fixture.bundlePath,JSON.stringify(b));
    expect(json(await odds()).combined_probability).toBe(.2);
    (b.data.mods.entries.find(m=>m.key==='Strength1')!.stats[0] as {index:number|null}).index=null;
    writeFileSync(fixture.bundlePath,JSON.stringify(b));
    expect(json(await odds()).combined_probability).toBeNull();
  });
  it.each(['chaos','alt','essence','exalted_greater'])('returns a coverage gap for unmodeled method %s',async method=>{
    const r=await odds({method});expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({game:'poe2',coverage:'gap',combined_probability:null});
  });
  it('requires item rarity and complete existing IDs, not guessed slot counts',async()=>{
    for(const overrides of [{item_rarity:undefined},{existing_mod_ids:undefined},{prefix_count:3},
      {existing_mod_ids:['UnknownMod']},{existing_mod_ids:[...fullPrefixes,'Strength1','Dexterity1','LocalIncreasedAttackSpeed1']},
      {method:'augment',item_rarity:'rare'},{existing_mod_ids:['Strength1','Strength2']}]){
      const r=await odds(overrides);expect(r.isError).toBe(true);expect(json(r).combined_probability).toBeNull();
    }
  });
  it('returns no numerical odds for missing, mismatched, malformed or unverified cache data',async()=>{
    const bad=[{...coeFixture(),game:'poe1'},{...coeFixture(),patch:'4.0.0'},{...coeFixture(),files:{data:'https://example.invalid/data',lang:'wrong'}}];
    for(const b of bad){writeFileSync(fixture.bundlePath,JSON.stringify(b));const r=await odds();expect(r.isError).toBe(true);expect(json(r).combined_probability).toBeNull();}
    rmSync(fixture.bundlePath);expect(json(await odds()).combined_probability).toBeNull();
  });
  it('rejects conditional/stateful item effects and unknown weights instead of silently simplifying them',async()=>{
    const b=coeFixture();b.data.modgroups.entries.find(g=>g.id===48)!.gtags.push(123 as never);b.data.modgroups.entries.find(g=>g.id===48)!.gvals.push(50 as never);
    writeFileSync(fixture.bundlePath,JSON.stringify(b));expect(json(await odds()).coverage).toBe('gap');
    const invalid=coeFixture();invalid.data.classmods['58']['0']=-1;writeFileSync(fixture.bundlePath,JSON.stringify(invalid));expect(json(await odds()).combined_probability).toBeNull();
  });
});
