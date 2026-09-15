import {beforeEach,afterEach,describe,it,expect} from '@jest/globals';
import {StatMapper} from '../../src/services/statMapper.js';
let original:string|undefined;
beforeEach(()=>{original=process.env.POE_GAME;process.env.POE_GAME='poe2';});
afterEach(()=>{if(original===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=original;});
const data={result:[{label:'Pseudo',entries:[{id:'pseudo.pseudo_total_life',text:'+# total maximum Life'}]},{label:'Explicit',entries:[{id:'explicit.stat_3981240776',text:'# to Spirit'},{id:'explicit.stat_2891184298',text:'#% increased Cast Speed'}]},{label:'Desecrated',entries:[{id:'desecrated.test',text:'# special'}]}]};
describe('verified PoE2 stat identities',()=>{
 it('has no PoE1 static fallback before metadata is loaded',()=>{
  const m=new StatMapper();expect(m.getTradeId('Life')).toBeNull();expect(m.getAllMappings()).toEqual([]);
 });
 it('binds known aliases only to present, matching live definitions',async()=>{
  const m=new StatMapper();await m.loadFromTradeAPI(data);
  expect(m.getTradeId('Life')).toBe('pseudo.pseudo_total_life');expect(m.getTradeId('Spirit')).toBe('explicit.stat_3981240776');
  expect(m.getTradeId('CastSpeed')).toBe('explicit.stat_2891184298');expect(m.getTradeId('SpellSuppressionChance')).toBeNull();
  expect(m.getAllMappings()).toHaveLength(4);expect(m.getByCategory('desecrated')).toHaveLength(1);
 });
 it('does not silently drop unsupported requested stats',async()=>{
  const m=new StatMapper();await m.loadFromTradeAPI(data);
  expect(()=>m.pobStatsToTradeFilters([{name:'Life',min:30},{name:'SpellSuppressionChance',min:10}])).toThrow(/unmapped|unsupported/i);
 });
 it('does not give a changed ID the old semantic alias',async()=>{
  const m=new StatMapper();await m.loadFromTradeAPI({result:[{label:'Pseudo',entries:[{id:'pseudo.pseudo_total_life',text:'# unrelated mechanic'}]}]});
  expect(m.getTradeId('Life')).toBeNull();
 });
});
