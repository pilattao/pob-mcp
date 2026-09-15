import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BuildService } from '../../src/services/buildService.js';
import { assessBossBenchmarks, loadPoe2BossCatalog, resolvePoe2Boss } from '../../src/services/poe2BossReadiness.js';
import { handleCheckBossReadiness } from '../../src/handlers/bossReadinessHandlers.js';
const originalGame=process.env.POE_GAME;
beforeEach(()=>{process.env.POE_GAME='poe2';});
afterEach(()=>{if(originalGame===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=originalGame;});
const catalog={source:{path:'/fixture/WorldAreas.lua',sha256:'fixture'},bosses:[
 {name:'The Arbiter of Ash',areas:[{id:'monolith',name:'The Burning Monolith',baseAreaLevel:74}]},
 {name:'Olroth, Origin of the Fall',areas:[{id:'olroth',name:'Logbook',baseAreaLevel:80}]},
]};
describe('PoE2 boss benchmarks',()=>{
 it('resolves native boss identity without substituting a generic PoE1 boss',()=>{
  expect(resolvePoe2Boss('arbiter',catalog).name).toBe('The Arbiter of Ash');
  expect(()=>resolvePoe2Boss('Maven',catalog)).toThrow(/not found|PoE2/i);
 });
 it('accepts CI and hybrid defenses without arbitrary life/DPS thresholds',()=>{
  const result=assessBossBenchmarks({Life:1,EnergyShield:12000,Mana:2000,MissingFireResist:0},[]);
  expect(result.status).toBe('not_assessed');expect(result.checks).toEqual([]);
 });
 it('preserves missing evidence and explicit zero thresholds',()=>{
  const result=assessBossBenchmarks({ChaosResist:0},[{stat:'ChaosResist',min:0},{stat:'TotalDPS',min:1}]);
  expect(result.checks.map(c=>c.status)).toEqual(['met','unknown']);expect(result.status).toBe('unknown');
 });
 it('compares caller supplied benchmarks and rejects invalid requirements',()=>{
  const result=assessBossBenchmarks({PhysicalMaximumHitTaken:15000},[{stat:'PhysicalMaximumHitTaken',min:20000}]);
  expect(result.status).toBe('not_met');expect(result.checks[0].shortfall).toBe(5000);
  expect(()=>assessBossBenchmarks({},[{stat:'Life',min:NaN}])).toThrow(/finite/);
 });
 it('reads PoE2 world areas instead of the legacy Bosses.lua table',()=>{
  const result=loadPoe2BossCatalog();expect(resolvePoe2Boss('arbiter',result).name).toBe('The Arbiter of Ash');
  expect(result.source.path).toMatch(/WorldAreas\.lua$/);expect(()=>resolvePoe2Boss('Sirus',result)).toThrow(/not found|PoE2/i);
 });
 it('reads unsaved live evidence without loading or changing a build',async()=>{
  const xml='<PathOfBuilding2><Build className="Witch" ascendClassName="Blood Mage" level="93"/><Config activeConfigSet="1"><ConfigSet id="1"><Input name="enemyLevel" number="82"/></ConfigSet></Config></PathOfBuilding2>';
  const client:any={getBuildInfo:jest.fn<any>().mockResolvedValue({name:'Unsaved',className:'Witch',level:93}),getStats:jest.fn<any>().mockResolvedValue({Life:1,EnergyShield:10000,Mana:1000,PhysicalMaximumHitTaken:15000,MissingFireResist:0}),exportBuildXml:jest.fn<any>().mockResolvedValue(xml),loadBuildXml:jest.fn()};
  const result=await handleCheckBossReadiness({buildService:new BuildService('/unused'),getLuaClient:()=>client,ensureLuaClient:async()=>{}},'arbiter',{requirements:[{stat:'PhysicalMaximumHitTaken',min:12000}]});
  const text=result.content[0].text;expect(text).toContain('The Arbiter of Ash');expect(text).toContain('Current PoB2');
  expect(text).not.toMatch(/6000|6,000|Maven|spell suppression required|READY/);expect(client.loadBuildXml).not.toHaveBeenCalled();
 });
});
