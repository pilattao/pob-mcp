/** Opt-in, read-only acceptance against the isolated PoB2 instance. Never loads a build. */
import {describe,it,expect} from '@jest/globals';
import {createHash} from 'crypto';
import {dirname,basename} from 'path';
import {PoBLuaTcpClient} from '../../src/pobLuaBridge.js';
import {BuildService} from '../../src/services/buildService.js';
import {handlePlanLeveling} from '../../src/handlers/levelingHandlers.js';
const live=process.env.POE2_LEVELING_LIVE_TEST === '1' ? describe : describe.skip;
const file=process.env.POE2_LEVELING_PRIVATE_XML ? describe : describe.skip;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
live('native PoE2 leveling read-only acceptance',()=>{
  it('plans the selected native character while preserving the XML and native outputs',async()=>{
    const client=new PoBLuaTcpClient({host:process.env.POE2_LEVELING_TEST_HOST ?? '127.0.0.1',port:Number(process.env.POE2_LEVELING_TEST_PORT ?? '55698'),timeoutMs:15000});
    await client.start();
    try{
      const before=hash(await client.exportBuildXml()),stats=await client.getStats();
      const info=await client.getBuildInfo();
      const result=await handlePlanLeveling({buildService:new BuildService('/tmp/unused-leveling-builds'),getLuaClient:()=>client,ensureLuaClient:async()=>{}},{});
      expect(result.structuredContent.character).toMatchObject({source:'live',className:info.className,level:info.level});
      expect(result.structuredContent.skills.length).toBeGreaterThan(0);
      expect(result.structuredContent.actions.length).toBeGreaterThan(0);
      expect(result.structuredContent.campaign).toHaveLength(8);
      expect(result.structuredContent.status).toBe('partial'); // Native XML has no earned-trial/quest progress.
      expect(result.structuredContent.character.attributes.Int).not.toBeNull();
      for(const skill of result.structuredContent.skills.filter(s=>s.id && s.firstRequirement).slice(0,3)){
        const local=skill.firstRequirement!;
        const detail=await client.getGemDetail({gemName:skill.id!,levels:[local.level]});
        expect(detail.perLevel[0]).toMatchObject({level:local.level,levelRequirement:local.levelRequirement,reqStr:local.reqStr,reqDex:local.reqDex,reqInt:local.reqInt});
      }
      expect(hash(await client.exportBuildXml())).toBe(before);
      expect(await client.getStats()).toEqual(stats);
      console.info('Read-only native leveling:',{skills:result.structuredContent.skills.length,actions:result.structuredContent.actions.length,status:result.structuredContent.status,gaps:result.structuredContent.gaps});
    }finally{await client.stop();}
  },60000);
});
file('private saved PoE2 leveling acceptance',()=>{
  it('reads the requested file through the build-evidence helper',async()=>{
    const path=process.env.POE2_LEVELING_PRIVATE_XML!;
    const result=await handlePlanLeveling({buildService:new BuildService(dirname(path)),getLuaClient:()=>null,ensureLuaClient:async()=>{}},{build_name:basename(path)});
    expect(result.structuredContent.character.source).toBe('file');
    expect(result.structuredContent.skills.length).toBeGreaterThan(0);
    expect(result.structuredContent.actions.length).toBeGreaterThan(0);
    expect(result.structuredContent.skills.some(s=>s.id && s.milestones.length)).toBe(true);
    console.info('Private saved leveling:',{skills:result.structuredContent.skills.length,actions:result.structuredContent.actions.length,status:result.structuredContent.status,gaps:result.structuredContent.gaps});
  });
});
