import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { handleGetTreeNodeWithTimelessJewels } from '../../src/handlers/transformedNodeHandler.js';
let game:string|undefined;
beforeEach(()=>{game=process.env.POE_GAME;process.env.POE_GAME='poe2';});
afterEach(()=>{if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;});
function context(node:any){return{ensureLuaClient:async()=>{},getLuaClient:()=>({getNodeState:async()=>node}) as any};}
describe('PoE2 native node evidence',()=>{
 it('does not infer base stats from missing conquest metadata',async()=>{
  const result=await handleGetTreeNodeWithTimelessJewels(context({id:1,dn:'Node',sd:['Current native stat']}),'1');
  expect(result.content[0].text).toContain('Current native stat');
  expect(result.content[0].text).toContain('status is unknown');
  expect(result.content[0].text).not.toMatch(/NOT being transformed|match the base data/);
 });
 it('does not map PoE2 conquest names to PoE1 uniques',async()=>{
  const result=await handleGetTreeNodeWithTimelessJewels(context({id:1,sd:['Current'],conqueredBy:{conqueror_type:'karui',seed:9}}),'1');
  expect(result.content[0].text).toContain('karui');expect(result.content[0].text).not.toContain('Lethal Pride');
 });
 it('fails explicitly when native state is unavailable instead of guessing a latest static tree',async()=>{
  const result=await handleGetTreeNodeWithTimelessJewels({getLuaClient:()=>null,ensureLuaClient:async()=>{throw new Error('ECONNREFUSED');}},'1');
  expect(result.isError).toBe(true);
 });
});
