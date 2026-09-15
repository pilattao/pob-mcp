/** Native caller contracts only: fixture values are not character calculations. */
import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {handleGetConfig,handleSetConfig,handleSetEnemyStats,handleSaveConfigPreset,handleLoadConfigPreset,handleListConfigPresets} from '../../src/handlers/configHandlers.js';

const originalGame=process.env.POE_GAME;
let directory:string;
beforeEach(async()=>{process.env.POE_GAME='poe2';directory=await fs.mkdtemp(path.join(os.tmpdir(),'poe2-config-contract-'));});
afterEach(async()=>{jest.restoreAllMocks();await fs.rm(directory,{recursive:true,force:true});if(originalGame===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=originalGame;});

function context(initial:Record<string,unknown>={}){
 const state:Record<string,unknown>={activeConfigSetId:3,effectiveEnemyLevel:82,enemyIsBoss:'Pinnacle',conditionChampionIntimidate:true,usePowerCharges:false,...initial};
 const client={
  getConfig:jest.fn<()=>Promise<any>>().mockImplementation(async()=>({...state})),
  setConfig:jest.fn<(patch:Record<string,unknown>)=>Promise<any>>().mockImplementation(async patch=>{
   // The boundary fixture models the native whole-batch rejection contract.
   if('unknownOption' in patch)throw new Error('unknown config option "unknownOption"');
   for(const [key,value] of Object.entries(patch))state[key]=value==='false'?false:value;
   return {...state};
  }),
  getStats:jest.fn<()=>Promise<any>>().mockResolvedValue({}),
  exportBuildXml:jest.fn<()=>Promise<string>>().mockResolvedValue('<PathOfBuilding2><Config activeConfigSet="3"><ConfigSet id="1"><Input name="enemyLevel" number="84"/></ConfigSet><ConfigSet id="3"><Input name="usePowerCharges" boolean="false"/><Placeholder name="enemyLevel" number="82"/></ConfigSet></Config></PathOfBuilding2>'),
 };
 return {state,client,getLuaClient:()=>client as any,ensureLuaClient:async()=>{},pobDirectory:directory};
}
function output(result:any){return result.content.map((c:any)=>c.text).join('\n');}

it('shows the actual native set, raw inputs and effective enemy level without invented defaults',async()=>{
 const ctx=context({enemyEvasion:0});const text=output(await handleGetConfig(ctx));
 expect(text).toContain('native');expect(text).toContain('82');expect(text).toContain('3');
 expect(text).not.toMatch(/Bandit:|Pantheon|Enemy Level: 84|=== Active Conditions ===/);
 expect(text).toContain('conditionChampionIntimidate');expect(text).toContain('false');expect(text).toContain('enemyEvasion');
 expect(text).toMatch(/raw|initialized|applicab/i);
});
it('reports unavailable effective level without replacing it with 84 or zero',async()=>{
 const ctx=context();delete ctx.state.effectiveEnemyLevel;
 expect(output(await handleGetConfig(ctx))).toMatch(/unavailable|not available/i);
});
it('never serves the prior read as cached config after a native error',async()=>{
 const ctx=context();await handleGetConfig(ctx);
 ctx.client.getConfig.mockRejectedValueOnce(new Error('native disconnected'));
 await expect(handleGetConfig(ctx)).rejects.toThrow('native disconnected');
});
it.each([null,{}, {enemyLevel:84}, {activeConfigSetId:NaN}, {activeConfigSetId:3,enemyLevel:null}])('rejects malformed/unproven native config %j',async payload=>{
 const ctx=context();ctx.client.getConfig.mockResolvedValue(payload);
 await expect(handleGetConfig(ctx)).rejects.toThrow(/native|config/i);
});
it('sends only the explicit single key and preserves unrelated native defaults',async()=>{
 const ctx=context();await handleSetConfig(ctx,{config_name:'usePowerCharges',value:true});
 expect(ctx.client.setConfig).toHaveBeenCalledWith({usePowerCharges:true});
 expect(ctx.state.enemyIsBoss).toBe('Pinnacle');
});
it('sends a flat batch once, and propagates atomic native validation failure',async()=>{
 const ctx=context();await expect(handleSetConfig(ctx,{config:{enemyLevel:83,unknownOption:true}} as any)).rejects.toThrow('unknown config option');
 expect(ctx.client.setConfig).toHaveBeenCalledTimes(1);
 expect(ctx.client.setConfig).toHaveBeenCalledWith({enemyLevel:83,unknownOption:true});
 expect(ctx.state.enemyLevel).toBeUndefined();
});
it.each([
 {config:{}},{config:{enemyLevel:NaN}},{config:{enemyLevel:{value:83}}},
 {config:{activeConfigSetId:4}},{config:{effectiveEnemyLevel:84}},{config:{bandit:'None'}},
 {config:{enemyLevel:83},config_name:'enemyLevel',value:84},
])('rejects malformed or metadata writes before transport: %j',async args=>{
 const ctx=context();await expect(handleSetConfig(ctx,args as any)).rejects.toThrow();
 expect(ctx.client.setConfig).not.toHaveBeenCalled();
});
it('does not mistake an arbitrary string for a stored false boolean',async()=>{
 const ctx=context();ctx.client.setConfig.mockResolvedValue({...ctx.state});
 await expect(handleSetConfig(ctx,{config_name:'usePowerCharges',value:'garbage'})).rejects.toThrow(/verif|stored|appl/i);
});
it('accepts native boolean normalization while verifying readback',async()=>{
 const ctx=context({usePowerCharges:true});
 const text=output(await handleSetConfig(ctx,{config_name:'usePowerCharges',value:'false'}));
 expect(ctx.state.usePowerCharges).toBe(false);expect(text).toMatch(/verif/i);
});
it('reports an unconfirmed write if native readback fails',async()=>{
 const ctx=context();ctx.client.getConfig.mockResolvedValueOnce({...ctx.state}).mockRejectedValueOnce(new Error('readback offline'));
 await expect(handleSetConfig(ctx,{config_name:'enemyLevel',value:83})).rejects.toThrow(/write.*readback|readback.*write|unconfirmed/i);
 expect(ctx.state.enemyLevel).toBe(83);
});
it('rejects a config-set switch during mutation verification',async()=>{
 const ctx=context();ctx.client.setConfig.mockImplementation(async patch=>{Object.assign(ctx.state,patch,{activeConfigSetId:4});return {...ctx.state};});
 await expect(handleSetConfig(ctx,{config_name:'enemyLevel',value:83})).rejects.toThrow(/set.*changed|different.*set/i);
});
it('keeps verified config status if optional stats fail, without inventing zero DPS',async()=>{
 const ctx=context();ctx.client.getStats.mockRejectedValue(new Error('calcs offline'));
 const text=output(await handleSetConfig(ctx,{config_name:'enemyLevel',value:83}));
 expect(text).toMatch(/verif/i);expect(text).toContain('calcs offline');expect(text).not.toMatch(/DPS: 0/);
});
it('maps only requested enemy fields and reads old values from native input',async()=>{
 const ctx=context({enemyLevel:82,enemyFireResist:7});
 const text=output(await handleSetEnemyStats(ctx,{level:83,fire_resist:0}));
 expect(ctx.client.setConfig).toHaveBeenCalledWith({enemyLevel:83,enemyFireResist:0});
 expect(text).toContain('82');expect(text).toContain('7');expect(text).not.toMatch(/84.*83|40%.*0%|Previous DPS: 0/);
});
it.each([{}, {level:NaN}, {armor:1.5}, {evasion:null}, {unsupported:10}])('validates the complete enemy patch before writes: %j',async args=>{
 const ctx=context();await expect(handleSetEnemyStats(ctx,args as any)).rejects.toThrow();
 expect(ctx.client.setConfig).not.toHaveBeenCalled();
});

describe('game-specific config presets',()=>{
 it('saves selected-set explicit XML input overrides with game/source provenance, excluding defaults and metadata',async()=>{
  const ctx=context();await handleSaveConfigPreset(ctx,'bossing');
  const saved=JSON.parse(await fs.readFile(path.join(directory,'.pob-mcp-presets/poe2/bossing.json'),'utf8'));
  expect(saved.game).toBe('poe2');expect(saved.source.activeConfigSetId).toBe(3);
  expect(saved.input).toEqual({usePowerCharges:false});
 });
 it('loads only the saved input patch into the current set',async()=>{
  const ctx=context();await handleSaveConfigPreset(ctx,'bossing');
  ctx.state.usePowerCharges=true;ctx.state.enemyLevel=81;
  const text=output(await handleLoadConfigPreset(ctx,'bossing'));
  expect(ctx.client.setConfig).toHaveBeenCalledWith({usePowerCharges:false});
  expect(ctx.state.enemyLevel).toBe(81);expect(text).toMatch(/patch|overrides/i);
 });
 it('never imports an unversioned PoE1 preset in PoE2 mode',async()=>{
  const dir=path.join(directory,'.pob-mcp-presets');await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'legacy.json'),JSON.stringify({bandit:'Alira',enemyLevel:84}));
  const ctx=context();await expect(handleLoadConfigPreset(ctx,'legacy')).rejects.toThrow(/PoE2|poe2|legacy|not found/i);
  expect(ctx.client.setConfig).not.toHaveBeenCalled();
  expect(output(await handleListConfigPresets(ctx))).not.toContain('1. legacy');
 });
 it('rejects mismatched preset provenance before a native write',async()=>{
  const ctx=context();await handleSaveConfigPreset(ctx,'bad');
  const file=path.join(directory,'.pob-mcp-presets/poe2/bad.json');
  const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.game='poe1';await fs.writeFile(file,JSON.stringify(saved));
  await expect(handleLoadConfigPreset(ctx,'bad')).rejects.toThrow(/game|PoE1|poe1/i);
  expect(ctx.client.setConfig).not.toHaveBeenCalled();
 });
 it('does not save stale or mismatched selected-set XML',async()=>{
  const ctx=context();ctx.client.exportBuildXml.mockResolvedValue('<PathOfBuilding2><Config activeConfigSet="1"><ConfigSet id="1"/></Config></PathOfBuilding2>');
  await expect(handleSaveConfigPreset(ctx,'bad')).rejects.toThrow(/set|changed/i);
  await expect(fs.access(path.join(directory,'.pob-mcp-presets/poe2/bad.json'))).rejects.toThrow();
 });
 it('surfaces corrupt preset data instead of calling it missing or loading defaults',async()=>{
  const ctx=context();await handleSaveConfigPreset(ctx,'broken');
  await fs.writeFile(path.join(directory,'.pob-mcp-presets/poe2/broken.json'),'{bad');
  await expect(handleLoadConfigPreset(ctx,'broken')).rejects.toThrow(/invalid|parse|JSON/i);
  expect(ctx.client.setConfig).not.toHaveBeenCalled();
 });
 it('preserves legacy PoE1 preset compatibility separately',async()=>{
  process.env.POE_GAME='poe1';const ctx=context();const dir=path.join(directory,'.pob-mcp-presets');await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'legacy.json'),JSON.stringify({bandit:'Alira'}));
  await handleLoadConfigPreset(ctx,'legacy');expect(ctx.client.setConfig).toHaveBeenCalledWith({bandit:'Alira'});
  expect(await fs.readFile(path.join(dir,'legacy.json'),'utf8')).toBe('{"bandit":"Alira"}');
 });
 it('does not hide directory read failures as an empty preset list',async()=>{
  await fs.writeFile(path.join(directory,'.pob-mcp-presets'),'not a directory');
  await expect(handleListConfigPresets(context())).rejects.toThrow();
 });
});

it('shows the native effective level change when the old override was unset',async()=>{
 const ctx=context();ctx.client.setConfig.mockImplementation(async patch=>{Object.assign(ctx.state,patch,{effectiveEnemyLevel:83});return {...ctx.state};});
 const text=output(await handleSetEnemyStats(ctx,{level:83}));
 expect(text).toContain('Effective enemy level: 82 → 83');
 expect(text).toContain('Old Value: not set');
});
it('preserves zero DPS as an observed value without substituting a different metric',async()=>{
 const ctx=context();ctx.client.getStats.mockResolvedValueOnce({CombinedDPS:0,TotalDPS:15}).mockResolvedValueOnce({CombinedDPS:0,TotalDPS:20});
 const text=output(await handleSetEnemyStats(ctx,{level:83}));
 expect(text).toContain('CombinedDPS: 0 → 0');expect(text).not.toContain('15 → 20');
});
it('saves live multiline input exactly instead of the XML-normalized string',async()=>{
 const value='One\n\tTwo';const ctx=context({customMods:value});
 ctx.client.exportBuildXml.mockResolvedValue('<PathOfBuilding2><Config activeConfigSet="3"><ConfigSet id="3"><Input name="customMods" string="One  Two"/></ConfigSet></Config></PathOfBuilding2>');
 await handleSaveConfigPreset(ctx,'text');
 const saved=JSON.parse(await fs.readFile(path.join(directory,'.pob-mcp-presets/poe2/text.json'),'utf8'));
 expect(saved.input).toEqual({customMods:value});
});
it('does not save config that changes while the native XML is exported',async()=>{
 const ctx=context();ctx.client.getConfig.mockResolvedValueOnce({...ctx.state}).mockResolvedValueOnce({...ctx.state,usePowerCharges:true});
 await expect(handleSaveConfigPreset(ctx,'racing')).rejects.toThrow(/changed/i);
 await expect(fs.access(path.join(directory,'.pob-mcp-presets/poe2/racing.json'))).rejects.toThrow();
});
it('does not turn empty explicit presets into broad default writes',async()=>{
 const ctx=context();ctx.client.exportBuildXml.mockResolvedValue('<PathOfBuilding2><Config activeConfigSet="3"><ConfigSet id="3"/></Config></PathOfBuilding2>');
 await handleSaveConfigPreset(ctx,'empty');const text=output(await handleLoadConfigPreset(ctx,'empty'));
 expect(ctx.client.setConfig).not.toHaveBeenCalled();expect(text).toContain('0 input overrides');
});
it('rejects writable metadata smuggled into a tagged preset',async()=>{
 const ctx=context();await handleSaveConfigPreset(ctx,'meta');const file=path.join(directory,'.pob-mcp-presets/poe2/meta.json');
 const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.input.activeConfigSetId=4;await fs.writeFile(file,JSON.stringify(saved));
 await expect(handleLoadConfigPreset(ctx,'meta')).rejects.toThrow(/metadata/i);expect(ctx.client.setConfig).not.toHaveBeenCalled();
});
it('preserves an existing preset if a subsequent native read fails',async()=>{
 const ctx=context();await handleSaveConfigPreset(ctx,'keep');const file=path.join(directory,'.pob-mcp-presets/poe2/keep.json');
 const original=await fs.readFile(file,'utf8');ctx.client.getConfig.mockRejectedValue(new Error('native offline'));
 await expect(handleSaveConfigPreset(ctx,'keep')).rejects.toThrow('native offline');expect(await fs.readFile(file,'utf8')).toBe(original);
});
