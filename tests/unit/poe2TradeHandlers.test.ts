import {beforeEach,afterEach,describe,it,expect,jest} from '@jest/globals';
import {handleSearchTradeItems,handleGetItemPrice,handleCompareTradeItems,handleSearchStats} from '../../src/handlers/tradeHandlers.js';
import {StatMapper} from '../../src/services/statMapper.js';
let game:string|undefined;
beforeEach(()=>{game=process.env.POE_GAME;process.env.POE_GAME='poe2';});
afterEach(()=>{if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;});
const listing=(id:string,amount:number,currency:string)=>({id,item:{id,league:'Test',name:'Test item',typeLine:'Ring',ilvl:80,explicitMods:['+80 to maximum Life'],properties:[]},listing:{price:{amount,currency},account:{name:'synthetic'}}});
function context():any {
  return {tradeClient:{
    game:'poe2',
    searchItems:jest.fn<any>().mockResolvedValue({id:'q',result:['one'],total:1}),
    fetchItems:jest.fn<any>().mockResolvedValue([listing('one',1,'divine')]),
    getStats:jest.fn<any>().mockResolvedValue({result:[{label:'Explicit',entries:[{id:'explicit.stat_3981240776',text:'# to Spirit'}]}]}),
  }};
}
describe('PoE2 trade handler fidelity',()=>{
 it('forwards state and native equipment constraints and returns actual listings',async()=>{
  const ctx=context();const result=await handleSearchTradeItems(ctx,{league:'Test',item_type:'focus',corrupted:false,identified:true,min_spirit:50,min_ward:20,min_rune_sockets:2});
  expect(ctx.tradeClient.searchItems.mock.calls[0][1].query.filters).toMatchObject({misc_filters:{filters:{corrupted:{option:'false'},identified:{option:'true'}}},equipment_filters:{filters:{spirit:{min:50},ward:{min:20},rune_sockets:{min:2}}}});
  expect(result.content[0].text).toContain('1 divine');expect(result.content[0].text).toContain('/trade2/search/poe2/Test/q');
 });
 it('uses named-item economy estimates with variants instead of searching currency only',async()=>{
  const ctx=context();ctx.ninjaClient={getItemPrice:jest.fn<any>().mockResolvedValue({status:'ambiguous',matches:[{variant:'A'},{variant:'B'}]})};
  const result=await handleGetItemPrice(ctx,{item_name:'A unique',league:'Test',variant:'A'});
  expect(ctx.ninjaClient.getItemPrice).toHaveBeenCalledWith('Test','A unique',{variant:'A',corrupted:undefined});
  expect(result.content[0].text).toContain('ambiguous');expect(ctx.tradeClient.searchItems).not.toHaveBeenCalled();
 });
 it('preserves query identity and never compares bare currency amounts',async()=>{
  const ctx=context();ctx.tradeClient.fetchItems.mockResolvedValue([listing('one',1,'divine'),listing('two',10,'exalted')]);
  ctx.ninjaClient={getCurrencyExchangeMap:async()=>new Map([['Chaos Orb',1],['Divine Orb',10],['Exalted Orb',.025]])};
  const result=await handleCompareTradeItems(ctx,{item_ids:['one','two'],query_id:'q',league:'Test'});
  expect(ctx.tradeClient.fetchItems).toHaveBeenCalledWith(['one','two'],'q');
  const data=JSON.parse(result.content[0].text);expect(data.items[0].price.priceInChaos).toBe(10);expect(data.items[1].price.priceInChaos).toBe(.25);
  expect(result.content[0].text).not.toContain('Best Value');
 });
 it('loads current stat metadata before searching',async()=>{
  const ctx=context();ctx.statMapper=new StatMapper();const result=await handleSearchStats(ctx,{query:'Spirit'});
  expect(result.content[0].text).toContain('explicit.stat_3981240776');expect(ctx.tradeClient.getStats).toHaveBeenCalledTimes(1);
 });
 it('requires a base for rare comparable searches instead of using random rare names',async()=>{
  const ctx=context();await expect(handleGetItemPrice(ctx,{item_name:'Rare random name',league:'Test',rarity:'rare'})).rejects.toThrow(/item_type/);
 });
});
