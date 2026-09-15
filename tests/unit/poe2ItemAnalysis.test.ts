import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { BuildService } from '../../src/services/buildService.js';
import { handleAnalyzeItems } from '../../src/handlers/advancedOptimizationHandlers.js';
const xml='<PathOfBuilding2><Build className="Witch" ascendClassName="Blood Mage" level="93"><PlayerStat stat="Life" value="2502"/><PlayerStat stat="FireResist" value="75"/></Build><Items activeItemSet="2"><Item id="1">Rarity: RARE\nCorrect Ring\nRuby Ring\nImplicits: 1\n+30% to Fire Resistance\n+100 to maximum Life</Item><Item id="2">Rarity: RARE\nInactive Ring\nIron Ring\nImplicits: 0</Item><ItemSet id="2"><Slot name="Ring 1" itemId="1"/><Slot name="Flask 2" itemId="0"/></ItemSet><ItemSet id="1"><Slot name="Ring 1" itemId="2"/></ItemSet></Items></PathOfBuilding2>';
let game:string|undefined;
beforeEach(()=>{game=process.env.POE_GAME;process.env.POE_GAME='poe2';});
afterEach(()=>{if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;});
describe('PoE2 item analysis',()=>{
 it('joins item IDs from the selected set and never treats absent stats as zero',async()=>{
  const builds=new BuildService('/unused');jest.spyOn(builds,'readBuild').mockResolvedValue(builds.parseBuildContent(xml));
  const result=await handleAnalyzeItems({buildService:builds,pobDirectory:'/unused',ensureLuaClient:async()=>{},getLuaClient:()=>null},'Input.xml');
  const text=result.content[0].text;
  expect(text).toContain('Correct Ring');expect(text).not.toContain('Inactive Ring');
  expect(text).toContain('Fire resistance: 75%');expect(text).toContain('Cold resistance: unknown');
  expect(text).toContain('+100 to maximum Life');
  expect(text).not.toMatch(/Slot is empty|5500|Stygian|suppression|Pantheon/);
 });
});
