import {describe,it,expect,afterEach} from '@jest/globals';
import {createPoe2LevelingPlan, type LevelingEvidence} from '../../src/services/poe2LevelingService.js';
import {loadPoe2LevelingDefinitions} from '../../src/services/poe2LevelingData.js';

const build=(className='Sorceress', skill='Spark', gemLevel=1, level=1): LevelingEvidence => ({
  source:'file',note:'saved test evidence',stats:{Str:7,Dex:7,Int:15},
  build:{__xmlRoot:'PathOfBuilding2',Build:{className,level:String(level)},
    Tree:{activeSpec:'1',Spec:{treeVersion:'0_5',nodes:''}},
    Skills:{activeSkillSet:'1',SkillSet:{id:'1',Skill:{enabled:'true',Gem:{nameSpec:skill,level:String(gemLevel)}}}}},
} as any);
describe('PoE2 leveling native definitions and constraints', () => {
  const install=process.env.POB_INSTALL_DIR;
  afterEach(() => {if(install===undefined)delete process.env.POB_INSTALL_DIR;else process.env.POB_INSTALL_DIR=install;});
  it('reads the latest native tree version independently of liveTargetVersion', () => {
    const d=loadPoe2LevelingDefinitions('0_5');
    expect(d.version).toBe('0_5');
    expect(Object.values(d.tree.classes).map((c:any)=>c.name).sort()).toEqual(['Druid','Huntress','Mercenary','Monk','Ranger','Sorceress','Warrior','Witch']);
    expect(d.quests.reduce((n,q)=>n+q.passivePoints,0)).toBe(24);
  });
  it('native requirement evaluation preserves Lua truthiness for zero', () => {
    const spark=loadPoe2LevelingDefinitions('0_5').gems.find(g=>g.name==='Spark')!;
    expect(spark.levels[0]).toMatchObject({level:1,levelRequirement:0,reqInt:0,reqStr:0,reqDex:0});
    expect(spark.levels.find(r=>r.level===5)).toMatchObject({levelRequirement:14,reqInt:28});
  });
  it.each(['Druid','Huntress','Mercenary','Monk','Ranger','Sorceress','Warrior','Witch'])('accepts native class %s without assigning a starter build',className=>{
    const p=createPoe2LevelingPlan(build(className),{});
    expect(p.character.className).toBe(className);
    expect(p.skills.map(s=>s.name)).toEqual(['Spark']);
    expect(p.passives.recommendedOrder).toBeNull();
  });
  it('uses exact native class-ascendancy pairs including native additions',()=>{
    const d=loadPoe2LevelingDefinitions();
    for(const cls of Object.values(d.tree.classes) as any[])for(const asc of Object.values(cls.ascendancies) as any[]){
      expect(createPoe2LevelingPlan(build(cls.name),{ascendancy:asc.name}).character.targetAscendancy).toBe(asc.name);
    }
  });
  it('rejects PoE1 classes, wrong-class ascendancies and ambiguous target names',()=>{
    expect(()=>createPoe2LevelingPlan(build('Templar'),{})).toThrow(/class/);
    expect(()=>createPoe2LevelingPlan(build('Warrior'),{ascendancy:'Blood Mage'})).toThrow(/Ascendancy/);
    expect(()=>createPoe2LevelingPlan(build(),{main_skill:'Onslaught'})).toThrow(/main_skill/);
  });
  it('support tier does not become a character-level or equipment-link schedule',()=>{
    const p=createPoe2LevelingPlan(build('Sorceress','Rapid Casting II',1),{});
    expect(p.skills[0]).toMatchObject({support:true,engravingTier:4,status:'conditional',milestones:[]});
    expect(p.skills[0].conditions.join(' ')).toMatch(/tier 4/);
    expect(p.skills[0].firstRequirement).toBeUndefined();
  });
  it('distinguishes Spirit gems and lineage supports from ordinary skill engraving',()=>{
    const buff=createPoe2LevelingPlan(build('Sorceress','Herald of Thunder',6,18),{});
    expect(buff.skills[0].conditions.join(' ')).toContain('Uncut Spirit Gem');
    const lineage=createPoe2LevelingPlan(build('Sorceress',"Khatal's Rejuvenation",1),{});
    expect(lineage.skills[0].conditions.join(' ')).toContain('Lineage');
    expect(lineage.skills[0].milestones).toEqual([]);
  });
  it('shows a native ascendancy skill grant as a dependency rather than a gem unlock level',()=>{
    const p=createPoe2LevelingPlan(build('Witch','Life Remnants',1),{});
    expect(p.skills[0].conditions.join(' ')).toContain('Sanguimancy');
    expect(p.skills[0].conditions.join(' ')).toContain('Blood Mage');
    expect(p.skills[0].milestones).toEqual([]);
  });
  it('never treats a calculation level of 40 as an obtainable gem upgrade',()=>{
    const p=createPoe2LevelingPlan(build('Sorceress','Spark',40,100),{});
    expect(p.status).toBe('partial');
    expect(p.skills[0].nextRequirement).toBeUndefined();
    expect(p.skills[0].milestones.every(r=>r.level<=20)).toBe(true);
  });
  it('does not turn missing attributes, configured rewards or target-build stats into measured progress',()=>{
    const e=build('Sorceress','Arc',5,90);e.stats={};
    const p=createPoe2LevelingPlan(e,{current_level:14});
    expect(p.skills[0].status).toBe('conditional');
    expect(p.passives.confirmedQuestRewardPoints).toBe(0);
    expect(p.gaps.join(' ')).toMatch(/current Int is unknown/);
  });
  it('plans an intermediate gem for a low-level character using an endgame target build',()=>{
    const p=createPoe2LevelingPlan(build('Sorceress','Spark',20,90),{current_level:14});
    expect(p.skills[0].levelEligibleRequirement).toMatchObject({level:5,levelRequirement:14,reqInt:28});
    expect(p.actions.join(' ')).toMatch(/intermediate Spark gem level 5/);
    expect(p.actions.join(' ')).toMatch(/28 Int/);
  });
  it('rejects malformed progress and foreign quest IDs',()=>{
    for(const args of [{current_level:0},{current_level:101},{current_level:1.5},{target_level:0},{ascendancy_points:3},{completed_quests:['kill-kitava']}]){
      expect(()=>createPoe2LevelingPlan(build(),args)).toThrow();
    }
  });
  it('keeps ascendancy entry area levels separate from character requirements and earned points',()=>{
    const p=createPoe2LevelingPlan(build(),{ascendancy_points:4});
    expect(p.ascendancy.nextTotalPoints).toBe(6);
    expect(p.ascendancy.routes.find(r=>'chambers'in r&&r.chambers===10)).toMatchObject({entryAreaLevel:65,characterLevelRequirement:null,upToPoints:6});
    expect(p.ascendancy.routes.some(r=>r.upToPoints===4)).toBe(false);
  });
  it('does not schedule another primary trial after all eight earned points',()=>{
    const p=createPoe2LevelingPlan(build(),{ascendancy_points:8});
    expect(p.ascendancy.nextTotalPoints).toBeNull();
    expect(p.ascendancy.routes).toEqual([]);
  });
  it('fails closed on missing native data and mismatched tree versions',()=>{
    expect(()=>loadPoe2LevelingDefinitions('0_4')).toThrow(/differs/);
    process.env.POB_INSTALL_DIR='/does-not-exist/poe2-leveling';
    expect(()=>loadPoe2LevelingDefinitions()).toThrow(/directory/);
  });
  it('cites native file fingerprints and checked official progression sources',()=>{
    const p=createPoe2LevelingPlan(build(),{});
    expect(p.sources.some(s=>'sha256'in s && s.kind==='native-quests' && /^[a-f0-9]{64}$/.test(s.sha256))).toBe(true);
    expect(p.sources.some(s=>'url'in s && s.url.includes('4000864') && s.checkedAt==='2026-09-15')).toBe(true);
  });
});
