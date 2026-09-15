import { describe, it, expect, jest } from '@jest/globals';
import { readPoe2BuildEvidence } from '../../src/services/poe2BuildEvidence.js';
import { BuildService } from '../../src/services/buildService.js';
const xml='<PathOfBuilding2><Build className="Witch" ascendClassName="Blood Mage" level="93"><PlayerStat stat="Life" value="2502"/><PlayerStat stat="FireResist" value="75"/></Build><Items activeItemSet="1"><Item id="1">Rarity: RARE\nActual Ring\nRuby Ring\nImplicits: 1\n+30% to Fire Resistance\n+100 Life</Item><ItemSet id="1"><Slot name="Ring 1" itemId="1"/></ItemSet></Items></PathOfBuilding2>';
function fixture(){
 const service=new BuildService('/unused');
 jest.spyOn(service,'readBuild').mockResolvedValue(service.parseBuildContent(xml));
 const client={getBuildInfo:jest.fn<any>().mockResolvedValue({name:'Loaded',game:'poe2'}),exportBuildXml:jest.fn<any>().mockResolvedValue(xml),getStats:jest.fn<any>().mockResolvedValue({Life:2600,FireResist:75}),loadBuildXml:jest.fn()};
 return {service,client};
}
describe('PoE2 evidence source selection',()=>{
 it('requests derived native caps instead of relying on the default output subset',async()=>{
  const {service,client}=fixture();
  client.getStats.mockImplementation(async (fields?:string[])=>fields?{MissingChaosResist:36}:{Life:2502,ChaosResist:39});
  const result=await readPoe2BuildEvidence({buildService:service,getLuaClient:()=>client as any});
  expect(result.stats.ChaosResist).toBe(39);expect(result.stats.MissingChaosResist).toBe(36);
 });

 it('initializes and reads the live XML without saving or loading a build',async()=>{
  const {service,client}=fixture();let connected=false;
  const result=await readPoe2BuildEvidence({buildService:service,ensureLuaClient:async()=>{connected=true;},getLuaClient:()=>connected?client as any:null});
  expect(result.source).toBe('live');expect(result.stats.Life).toBe(2600);expect(client.loadBuildXml).not.toHaveBeenCalled();
 });
 it('uses only the requested file when another build is open',async()=>{
  const {service,client}=fixture();
  const result=await readPoe2BuildEvidence({buildService:service,ensureLuaClient:async()=>{},getLuaClient:()=>client as any},'Requested.xml');
  expect(result.source).toBe('file');expect(result.stats.FireResist).toBe(75);expect(result.stats.Unknown).toBeUndefined();
  expect(client.getStats).not.toHaveBeenCalled();expect(client.loadBuildXml).not.toHaveBeenCalled();
 });
 it('uses unsaved live XML for the same file identity',async()=>{
  const {service,client}=fixture();client.getBuildInfo.mockResolvedValue({name:'Requested',game:'poe2'});
  client.exportBuildXml.mockResolvedValue(xml.replace('Actual Ring','Unsaved Ring'));
  const result=await readPoe2BuildEvidence({buildService:service,ensureLuaClient:async()=>{},getLuaClient:()=>client as any},'Requested.xml');
  const rawItems = result.build.Items?.Item;
  expect((Array.isArray(rawItems) ? rawItems[0] : rawItems)?.['#text']).toContain('Unsaved Ring');
 });
 it('does not replace a missing requested file with unrelated live data',async()=>{
  const {service,client}=fixture();jest.spyOn(service,'readBuild').mockRejectedValue(new Error('missing'));
  await expect(readPoe2BuildEvidence({buildService:service,getLuaClient:()=>client as any},'Absent.xml')).rejects.toThrow('missing');
 });
 it('fails clearly when no file or live source exists',async()=>{
  const {service}=fixture();await expect(readPoe2BuildEvidence({buildService:service,getLuaClient:()=>null})).rejects.toThrow(/live/i);
 });
});
