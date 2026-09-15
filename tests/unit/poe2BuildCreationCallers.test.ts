import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {PoBLuaTcpClient} from '../../src/pobLuaBridge.js';
import {handleLuaLoadBuild} from '../../src/handlers/luaHandlers.js';
import {handleImportCharacter} from '../../src/handlers/importHandlers.js';
import {getLuaToolSchemas} from '../../src/server/toolSchemas.js';

const XML='<PathOfBuilding2><Build targetVersion="0_1"/><Items activeItemSet="2"/><Skills activeSkillSet="3"/><Tree/><Config/><Unknown keep="yes"/></PathOfBuilding2>';
const originalGame=process.env.POE_GAME;
beforeEach(()=>{process.env.POE_GAME='poe2';jest.useFakeTimers();});
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();if(originalGame===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=originalGame;});

function clientFor(statuses:any[]=[]){
 const client=new PoBLuaTcpClient({timeoutMs:450});
 const requests:any[]=[];
 const send=jest.spyOn(client as any,'send').mockImplementation(async(request:any)=>{
   requests.push(request);
   if(request.action==='version')return{ok:true,version:{game:'poe2',features:{queuedBuildOpen:true}}};
   if(request.action==='open_build_xml')return{ok:true,ready:false,requestId:'operation-1'};
   if(request.action==='get_build_open_status')return statuses.shift()??{ok:true,ready:false,requestId:'operation-1'};
   if(request.action==='get_build_info')return{ok:true,info:{name:'Previous',className:'Warrior'}};
   throw new Error('Unexpected request '+request.action);
 });
 return{client,requests,send};
}

async function finish<T>(promise:Promise<T>):Promise<T>{
 // Attach rejection handling before advancing timers.
 const settled=promise.then(value=>({value}),error=>({error}));
 await jest.runAllTimersAsync();
 const result=await settled;
 if('error' in result)throw result.error;
 return result.value;
}

describe('PoE2 native build creation callers',()=>{
 it('forwards requested class and waits for the same open token to finish',async()=>{
   const {client,requests}=clientFor([{ok:true,ready:false,requestId:'operation-1'},
    {ok:true,ready:true,requestId:'operation-1',info:{name:'New Build',className:'Witch',ascendClassName:'Blood Mage'}}]);
   const result:any=await finish(client.newBuild({className:'Witch',ascendancy:'Blood Mage'}));
   expect(requests.find(r=>r.action==='open_build_xml').params).toMatchObject({className:'Witch',ascendancy:'Blood Mage'});
   expect(requests.filter(r=>r.action==='get_build_open_status')).toHaveLength(2);
   expect(result.info.className).toBe('Witch');
   expect(requests.some(r=>r.action==='get_build_info')).toBe(false);
 });
 it('fails closed before opening against an old API without queued-open support',async()=>{
   const {client,requests,send}=clientFor();
   send.mockImplementation(async(request:any)=>{requests.push(request);return{ok:true,version:{apiVersion:'1.1.0'}};});
   await expect(finish(client.newBuild({className:'Witch'}))).rejects.toThrow(/queued|API/i);
   expect(requests.some(r=>r.action==='open_build_xml')).toBe(false);
 });
 it('does not report success when the new build never initializes',async()=>{
   const {client}=clientFor();
   await expect(finish(client.newBuild({className:'Witch'}))).rejects.toThrow(/timed out|timeout/i);
 });
 it('reports a native open failure instead of the previous build',async()=>{
   const {client}=clientFor([{ok:false,error:'build open failed: native conversion'}]);
   await expect(finish(client.newBuild({className:'Witch'}))).rejects.toThrow('native conversion');
 });
 it('rejects a response for a different operation',async()=>{
   const {client}=clientFor([{ok:true,ready:true,requestId:'other',info:{}}]);
   await expect(finish(client.newBuild({className:'Witch'}))).rejects.toThrow(/request|operation/i);
 });
 it('loads the complete unchanged XML and waits for native readiness',async()=>{
   const {client,requests}=clientFor([{ok:true,ready:true,requestId:'operation-1',info:{name:'Loaded'}}]);
   await finish(client.loadBuildXml(XML,'Loaded','/private/Loaded.xml'));
   expect(requests.find(r=>r.action==='open_build_xml').params).toEqual({xml:XML,name:'Loaded',path:'/private/Loaded.xml'});
   expect(requests.some(r=>r.action==='set_tree')).toBe(false);
 });
 it.each(['','<PathOfBuilding/>','{"pob_xml":"not xml"}'])('rejects invalid PoE2 XML before transport: %s',async xml=>{
   const {client,requests}=clientFor();
   await expect(finish(client.loadBuildXml(xml))).rejects.toThrow(/XML|pob_xml/i);
   expect(requests).toEqual([]);
 });
 it('exposes full XML loading and installed-class validation in schemas',()=>{
   const tools=getLuaToolSchemas();
   const load=tools.find(t=>t.name==='lua_load_build').inputSchema;
   expect(load.properties.build_xml.type).toBe('string');
   expect(load.required??[]).not.toContain('build_name');
   const create=tools.find(t=>t.name==='lua_new_build');
   expect(create.description).toContain('installed');
   expect(create.description).not.toMatch(/Scion|Juggernaut|Occultist/);
 });
 it('does not select the file silently when both XML and filename are supplied',async()=>{
   const context:any={ensureLuaClient:async()=>{},getLuaClient:()=>({}),pobDirectory:'/no-builds'};
   await expect(handleLuaLoadBuild(context,'file.xml',XML)).rejects.toThrow(/exactly one|both/i);
 });
});

describe('PoE2 public character snapshot import',()=>{
 it('uses pob_xml as the complete build without fetching PoE1 endpoints',async()=>{
   const fetchSpy=jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No HTTP expected'));
   const load=jest.fn<(...args:any[])=>Promise<any>>().mockResolvedValue({ok:true,ready:true,info:{name:'Snapshot'}});
   const context:any={ensureLuaClient:async()=>{},getLuaClient:()=>({loadBuildXml:load})};
   const result=await handleImportCharacter(context,undefined,'Snapshot',undefined,{pobXml:XML} as any);
   expect(load).toHaveBeenCalledWith(XML,'Snapshot');
   expect(fetchSpy).not.toHaveBeenCalled();
   expect(result.content[0].text).not.toMatch(/Pantheon|bandit|24 pts|Unknown/);
 });
 it('gives the actual public-export workflow when only account/name are supplied',async()=>{
   const fetchSpy=jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No HTTP expected'));
   const context:any={ensureLuaClient:async()=>{},getLuaClient:()=>({})};
   await expect(handleImportCharacter(context,'Account','Character')).rejects.toThrow(/get_character_pob.*pob_xml/);
   expect(fetchSpy).not.toHaveBeenCalled();
 });
 it('does not pretend selective import options apply to a complete XML snapshot',async()=>{
   const context:any={ensureLuaClient:async()=>{},getLuaClient:()=>({})};
   await expect(handleImportCharacter(context,undefined,'Snapshot',undefined,{pobXml:XML,clearSkills:false} as any)).rejects.toThrow(/whole|complete|selective/i);
 });
});
