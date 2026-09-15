import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BuildService } from '../../src/services/buildService.js';
import { compareNativeTradeItems } from '../../src/services/nativeTradeComparison.js';
const game=process.env.POE_GAME;
beforeEach(()=>{process.env.POE_GAME='poe2';});afterEach(()=>{if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;});
const xml='<PathOfBuilding2><Build className="Witch" level="90"/><Items activeItemSet="1"><ItemSet id="1"><Slot name="Ring 1" itemId="0"/></ItemSet></Items><Skills activeSkillSet="1"><SkillSet id="1"/></Skills></PathOfBuilding2>';
function fixture(){
 const client:any={getBuildInfo:jest.fn<any>().mockResolvedValue({name:'Loaded',className:'Witch',level:90}),getStats:jest.fn<any>().mockResolvedValue({Life:500}),exportBuildXml:jest.fn<any>().mockResolvedValue(xml),evaluateItemReplacements:jest.fn<any>().mockImplementation(async(p:any)=>({snapshotId:p.snapshotId,baseline:{Life:500},preservation:{xmlUnchanged:true,statsUnchanged:true,selectionsUnchanged:true,undoUnchanged:true},conditions:{},comparisons:p.scenarios.map((s:any)=>({id:s.id,valid:true,inputs:s.replacements,output:{Life:580},warnings:[]}))}))};
 const item:any={id:'listing-a',item:{id:'item-a',identified:true,frameType:2,ilvl:80,name:'Real Rare',typeLine:'Gold Ring',baseType:'Gold Ring',properties:[{name:'Quality',values:[['0%',0]]}],requirements:[{name:'Level',values:[['60',0]]}],implicitMods:[],explicitMods:['+80 to maximum Life'],sockets:[]},listing:{indexed:'2026-09-15T00:00:00Z',price:{amount:1,currency:'divine'}}};
 return {client,item,context:{buildService:new BuildService('/unused'),getLuaClient:()=>client,ensureLuaClient:async()=>{}}};
}
describe('native trade comparison identity and preservation',()=>{
 it('binds actual converted listings and selected sets to the current native XML',async()=>{
  const {client,item,context}=fixture();const r:any=await compareNativeTradeItems(context,[item],'Ring 1');
  expect(r.status).toBe('calculated');expect(r.comparisons[0].output.Life).toBe(580);
  const p=client.evaluateItemReplacements.mock.calls[0][0];expect(p.expectedXml).toBe(xml);expect(p.itemSetId).toBe('1');expect(p.skillSetId).toBe('1');expect(p.scenarios[0].replacements[0].text).toContain('+80 to maximum Life');
 });
 it('keeps incomplete item evidence as an explicit failure instead of valuing a partial item',async()=>{
  const {client,item,context}=fixture();delete item.item.identified;
  const r=await compareNativeTradeItems(context,[item],'Ring 1');expect(r.status).toBe('unavailable');expect(client.evaluateItemReplacements).not.toHaveBeenCalled();
 });
 it('rejects mismatched returned candidate identity',async()=>{
  const {client,item,context}=fixture();client.evaluateItemReplacements.mockImplementation(async(p:any)=>({snapshotId:p.snapshotId,baseline:{Life:500},preservation:{xmlUnchanged:true,statsUnchanged:true,selectionsUnchanged:true,undoUnchanged:true},comparisons:[{id:p.scenarios[0].id,valid:true,inputs:[{...p.scenarios[0].replacements[0],candidateId:'wrong'}],output:{Life:580}}]}));
  await expect(compareNativeTradeItems(context,[item],'Ring 1')).rejects.toThrow(/does not match/);
 });
 it('requires actual booleans in the preservation proof',async()=>{
  const {client,item,context}=fixture();client.evaluateItemReplacements.mockImplementation(async(p:any)=>({snapshotId:p.snapshotId,baseline:{Life:500},preservation:{xmlUnchanged:'true',statsUnchanged:true,selectionsUnchanged:true,undoUnchanged:true},comparisons:[]}));
  await expect(compareNativeTradeItems(context,[item],'Ring 1')).rejects.toThrow(/preservation/);
 });
 it('rejects an unknown equipment slot before requesting native evidence',async()=>{
  const {client,item,context}=fixture();await expect(compareNativeTradeItems(context,[item],'')).rejects.toThrow(/slot/);expect(client.getBuildInfo).not.toHaveBeenCalled();
 });
});
