import { describe, expect, it, jest } from '@jest/globals';
import { BuildService } from '../../src/services/buildService.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
import { PoBLuaApiClient } from '../../src/pobLuaBridge.js';
import { handleCompareGemSetups, handleFindOptimalLinks, handleSuggestSupportGems } from '../../src/handlers/skillGemHandlers.js';
const xml='<PathOfBuilding2><Build level="93" mainSocketGroup="1"/><Skills activeSkillSet="3"><SkillSet id="3"><Skill mainActiveSkill="1"><Gem gemId="active" nameSpec="Active" skillId="activePlayer" level="18" quality="10" count="2"><StatSetIndex grantedEffect="activePlayer" index="2"/></Gem><Gem gemId="support" nameSpec="Support" level="1" quality="0"/></Skill></SkillSet></Skills></PathOfBuilding2>';
const gems:any[]=[{gemId:'active',name:'Active',skillId:'activePlayer',naturalMaxLevel:20,maxLevel:40,support:false,tags:['spell']},
  {gemId:'support',name:'Support',naturalMaxLevel:1,maxLevel:1,support:true,tags:['support']},
  {gemId:'better',name:'Better',description:'Native support description',naturalMaxLevel:1,maxLevel:1,support:true,tags:['support']}];
const row={name:'Improved',gems:[{gemId:'active',name:'Active',support:false,level:18,quality:10,count:2},{gemId:'better',name:'Better',support:true,level:1,quality:0}],
  output:{CombinedDPS:150,ManaCost:20,TotalEHP:1000},deltas:{CombinedDPS:{absolute:50,percent:50},ManaCost:{absolute:10,percent:100},TotalEHP:{absolute:0,percent:0}},valid:true,supports:[{name:'Better',status:'applied',gemId:'better'}],warnings:[]};
function context(liveName='Fixture') {
  const parser=new BuildService('/tmp/unused-gem-numeric');const build=parser.parseBuildContent(xml);
  const requests:any[]=[];
  const client:any={getBuildInfo:async()=>({name:liveName,level:93}),exportBuildXml:async()=>xml,getStats:async()=>({}),
    getSkills:async()=>({activeSkillSetId:3,mainSocketGroup:1,groups:[{index:1,enabled:true,mainActiveSkill:1,gems:[
      {index:1,name:'Active',gemId:'active',skillId:'activePlayer',level:18,quality:10,is_support:false,enabled:true},
      {index:2,name:'Support',gemId:'support',level:1,quality:0,is_support:true,enabled:true}]}]}),
    getGemDetail:async({gemName}:any)=>gems.find(g=>g.gemId===gemName),
    evaluateGemSetups:async(p:any)=>{requests.push(p);return{baseline:{CombinedDPS:100,ManaCost:10,TotalEHP:1000},metric:p.metric??'CombinedDPS',
      setups:p.setups ? p.setups.map((s:any)=>({...row,name:s.name})) : [row],ranking:[row],conditions:{skillSetId:3,evaluationGroupIndex:1,useSecondWeaponSet:true,configInput:{enemyLevel:83}},
      search:{evaluations:1,eligibleCandidates:3,budget:48,truncated:false,algorithm:'fixture'},rollback:{xmlUnchanged:true,statsUnchanged:true,selectionsUnchanged:true,undoUnchanged:true}}},
    loadBuildXml:async()=>{throw new Error('Must not replace user build')},addGem:async()=>{throw new Error('Must not commit a gem edit')}};
  return{buildService:{parseBuildContent:parser.parseBuildContent.bind(parser),readBuild:async()=>build} as any,
    skillGemService:new SkillGemService({catalog:async()=>gems,compatibility:async()=>[]}),getLuaClient:()=>client,ensureLuaClient:async()=>{},requests,client};
}
const output=(r:any)=>r.content[0].text;
describe('native numeric gem caller contracts',()=>{
  it('compares through the native evaluator with exact snapshot and retained gem references',async()=>{
    const ctx=context();const text=output(await handleCompareGemSetups(ctx,{build_name:'Fixture',setups:[
      {name:'A',gems:['Active','Support']},{name:'B',gems:['Active','Better']}]}));
    expect(ctx.requests).toHaveLength(1);
    expect(ctx.requests[0]).toMatchObject({expectedBuildName:'Fixture',expectedXml:xml,skillSetId:'3',groupIndex:1});
    expect(ctx.requests[0].setups[1].gems[0]).toMatchObject({refIndex:1});
    expect(text).toMatch(/150/);expect(text).toMatch(/\+50/);expect(text).toContain('ManaCost');
    expect(text).not.toMatch(/Numerical comparison requires|no DPS ranking/);
  });
  it('ranks suggestions and complete requested setups with native search',async()=>{
    const ctx=context();const suggestions=output(await handleSuggestSupportGems(ctx,{build_name:'Fixture',count:3}));
    expect(ctx.requests[0].search).toMatchObject({mode:'suggest',limit:3});
    expect(suggestions).toContain('Better');expect(suggestions).toContain('50');
    const result=output(await handleFindOptimalLinks(ctx,{build_name:'Fixture',link_count:2,optimize_for:'defense'}));
    expect(ctx.requests[1]).toMatchObject({metric:'TotalEHP',search:{mode:'optimize',targetGemCount:2}});
    expect(result).toContain('TotalEHP');
  });
  it('rejects a file when a different build is loaded instead of replacing or ranking it',async()=>{
    const ctx=context('Other');
    await expect(handleCompareGemSetups(ctx,{build_name:'Fixture',setups:[{name:'A',gems:['Active']},{name:'B',gems:['Active','Better']}]})).rejects.toThrow(/current|matching|loaded/i);
    expect(ctx.requests).toHaveLength(0);
  });
  it('does not silently fall back to metadata when native evaluation fails',async()=>{
    const ctx=context();ctx.client.evaluateGemSetups=async()=>{throw new Error('rollback failed')};
    await expect(handleSuggestSupportGems(ctx,{build_name:'Fixture'})).rejects.toThrow(/rollback failed/);
  });
  it('rejects an evaluator response without a successful rollback proof',async()=>{
    const ctx=context();const original=ctx.client.evaluateGemSetups;
    ctx.client.evaluateGemSetups=async(p:any)=>({...await original(p),rollback:{xmlUnchanged:false}});
    await expect(handleFindOptimalLinks(ctx,{build_name:'Fixture',link_count:2})).rejects.toThrow(/rollback/i);
  });
  it('sends the new bridge action and forwards native errors',async()=>{
    const bridge:any=new PoBLuaApiClient();const send=jest.spyOn(bridge,'send').mockResolvedValue({ok:true,result:{metric:'CombinedDPS'}});
    const request={expectedBuildName:'Fixture',expectedXml:xml,skillSetId:3,groupIndex:1,setups:[]};
    expect(await bridge.evaluateGemSetups(request)).toEqual({metric:'CombinedDPS'});
    expect(send).toHaveBeenCalledWith({action:'evaluate_gem_setups',params:request},60000);
    send.mockResolvedValue({ok:false,error:'native evaluator rejected stale state'});
    await expect(bridge.evaluateGemSetups(request)).rejects.toThrow(/stale state/);
  });
});

describe('complete numeric comparison and explicit output selection',()=>{
  it('finishes every requested setup across bounded native batches',async()=>{
    const ctx=context();const original=ctx.client.evaluateGemSetups;
    ctx.client.evaluateGemSetups=async(p:any)=>{
      const base=await original(p);const evaluated={...row,name:p.setups[0].name};
      return {...base,setups:[evaluated],ranking:[evaluated],search:{...base.search,truncated:p.setups.length>1}};
    };
    const result=output(await handleCompareGemSetups(ctx,{build_name:'Fixture',setups:[{name:'A',gems:['Active','Support']},{name:'B',gems:['Active','Better']}]}));
    expect(ctx.requests).toHaveLength(2);expect(ctx.requests[1].setups).toHaveLength(1);
    expect(result).toContain('1. A');expect(result).toContain('2. B');
  });
  it('forwards a level change and separate Spark/Bolt output group without changing weapon configuration',async()=>{
    const ctx=context();await handleCompareGemSetups(ctx,{build_name:'Fixture',evaluation_skill_index:2,metric:'CombinedDPS',setups:[
      {name:'18',gems:[{refIndex:1},{refIndex:2}]},{name:'19',gems:[{refIndex:1,level:19},{refIndex:2}]}]});
    expect(ctx.requests[0]).toMatchObject({evaluationGroupIndex:3,metric:'CombinedDPS'});
    expect(ctx.requests[0].setups[1].gems[0]).toMatchObject({refIndex:1,level:19});
    expect(ctx.requests[0]).not.toHaveProperty('useSecondWeaponSet');
  });
});
