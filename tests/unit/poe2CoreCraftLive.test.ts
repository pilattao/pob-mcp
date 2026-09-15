import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { handleAnalyzeItemMods } from '../../src/handlers/analyzeItemModsHandler';
import { handleListCraftableModsForBase } from '../../src/handlers/listCraftableModsHandler';
import { handleCalculateModOdds } from '../../src/handlers/calculateModOddsHandler';

// Opt-in read-only verification. Configure POB_NATIVE_TEST_DIR and
// POE2_COE_BUNDLE_PATH for the native install and Python-port cache snapshot.
const live=process.env.POE2_CORE_CRAFT_LIVE==='1'?describe:describe.skip;
const oldGame=process.env.POE_GAME, oldInstall=process.env.POB_INSTALL_DIR;
const json=(r:{content:Array<{text:string}>;isError?:boolean})=>{ const body=r.content.map(c=>c.text).join('\n'); if(r.isError)throw new Error(body); return JSON.parse(body); };
live('native PoB2 and verified CoE snapshot, read only',()=>{
  beforeAll(()=>{
    if(!process.env.POB_NATIVE_TEST_DIR||!process.env.POE2_COE_BUNDLE_PATH)throw new Error('Live check requires POB_NATIVE_TEST_DIR and POE2_COE_BUNDLE_PATH.');
    process.env.POE_GAME='poe2';process.env.POB_INSTALL_DIR=process.env.POB_NATIVE_TEST_DIR;
  });
  afterAll(()=>{
    if(oldGame===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=oldGame;
    if(oldInstall===undefined)delete process.env.POB_INSTALL_DIR;else process.env.POB_INSTALL_DIR=oldInstall;
  });
  it('identifies native Strength and complete hybrid text with base-specific source tiers',async()=>{
    const r=json(await handleAnalyzeItemMods({base_name:'Makeshift Crossbow',ilvl:20,raw_json:true,
      mod_lines:['+10 to Strength','17% increased Physical Damage','+18 to Accuracy Rating']}));
    expect(r.lines[0].match).toMatchObject({best:{id:'Strength2'},tier:7,tier_max:8,next_tier:{id:'Strength3'}});
    expect(r.lines[2].is_hybrid_continuation).toBe(true);
    expect(r.lines[2].match.best.id).toBe('LocalIncreasedPhysicalDamagePercentAndAccuracyRating1');
  });
  it('lists native tier 7 at low ilvl and never labels its 1 flag as spawn weight',async()=>{
    const r=json(await handleListCraftableModsForBase({base_name:'Makeshift Crossbow',ilvl:20,stat_contains:'to Strength',raw_json:true}));
    const strength=r.groups.find((g:{group:string})=>g.group==='Strength');
    expect(strength.entries[0]).toMatchObject({id:'Strength2',tier:7,weight:1,spawn_weight:null});
  });
  it('computes a real one-step CoE-weighted exalt and reports source identity',async()=>{
    const r=json(await handleCalculateModOdds({base_name:'Makeshift Crossbow',ilvl:86,method:'exalt',item_rarity:'rare',
      existing_mod_ids:['LocalIncreasedPhysicalDamagePercent1','LocalAddedFireDamageTwoHand1','LocalAddedColdDamageTwoHand1'],
      targets:[{group:'Strength',min_tier:1}],raw_json:true}));
    // Independently summed from the verified 4.5.5.1.5 snapshot: 75 ordinary
    // suffix records at ilvl 86, total 53625; Strength8 has source weight 500.
    expect(r.pool).toMatchObject({eligible_modifiers:75,total_weight:53625,qualifying_weight:500});
    expect(r.combined_probability).toBeCloseTo(500/53625,12);
    expect(r.source).toMatchObject({patch:'4.5.5.1.5',weight_kind:'estimated'});
    console.info('Native core craft evidence:',JSON.stringify({source:r.source,pool:r.pool,
      targets:r.targets,combined_probability:r.combined_probability,estimated_attempts:r.estimated_attempts}));
  });
  it('checks augmentation and regal using the same verified source with different rarity caps',async()=>{
    const input={base_name:'Makeshift Crossbow',ilvl:86,item_rarity:'magic' as const,
      existing_mod_ids:['LocalIncreasedPhysicalDamagePercent1'],targets:[{group:'Strength',min_tier:1}],raw_json:true};
    const augment=json(await handleCalculateModOdds({...input,method:'augment'}));
    const regal=json(await handleCalculateModOdds({...input,method:'regal'}));
    expect(augment.pool.total_weight).toBe(53625);
    expect(regal.pool.total_weight).toBeGreaterThan(augment.pool.total_weight);
    expect(regal.combined_probability).toBeLessThan(augment.combined_probability);
    expect(regal.operation.rarity_after).toBe('rare');
  });
});
