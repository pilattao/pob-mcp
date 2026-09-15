import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {TradeApiClient} from '../../src/services/tradeClient.js';
import {TradeQueryBuilder} from '../../src/services/tradeQueryBuilder.js';
const groups={result:[{id:'status_filters',filters:[{id:'status',option:{options:[{id:'online'},{id:'any'},{id:'available'}]}}]},{id:'type_filters',filters:[{id:'category',option:{options:[{id:'weapon.crossbow'},{id:'armour.focus'}]}},{id:'ilvl'}]},{id:'equipment_filters',filters:[{id:'es'},{id:'dps'},{id:'rune_sockets'},{id:'spirit'},{id:'ward'}]},{id:'trade_filters',filters:[{id:'price',option:{options:[{id:'divine'},{id:'exalted'},{id:'chaos'}]}}]}]};
const response=(data:any,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{status,headers});
let game:string|undefined,secret:string|undefined;
beforeEach(()=>{game=process.env.POE_GAME;secret=process.env.POE_SESSION_ID;process.env.POE_GAME='poe2';process.env.POE_SESSION_ID='synthetic-do-not-forward';});
afterEach(()=>{jest.restoreAllMocks();if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;if(secret===undefined)delete process.env.POE_SESSION_ID;else process.env.POE_SESSION_ID=secret;});
function network(){return jest.spyOn(globalThis,'fetch').mockImplementation(async(url:any)=>{
 const s=String(url);if(s.endsWith('/data/leagues'))return response({result:[{id:'Test League',realm:'poe2'}]});
 if(s.endsWith('/data/filters'))return response(groups);
 if(s.endsWith('/data/stats'))return response({result:[{label:'Explicit',entries:[{id:'explicit.test',text:'# test'}]}]});
 if(s.includes('/fetch/'))return response({result:[{id:'a',item:{id:'a',league:'Test League'},listing:{}}]});
 return response({id:'query-a',result:['a'],total:1});
});}
describe('PoE2 trade requests',()=>{
 it('uses trade2 realm, honors currency/zero values, and never forwards legacy cookies',async()=>{
  const fetch=network();const c=new TradeApiClient({requestsPerSecond:10000});
  const q=new TradeQueryBuilder().withType('crossbow').withPriceRange(0,2,'divine').applyOptions({league:'Test League',onlineOnly:false}).build();
  await c.searchItems('Test League',q);
  const req=fetch.mock.calls.find(([url])=>String(url).includes('/search/'))!;
  expect(req[0]).toBe('https://www.pathofexile.com/api/trade2/search/poe2/Test%20League');
  expect(JSON.parse(req[1]!.body as string).query).toMatchObject({status:{option:'any'},filters:{trade_filters:{filters:{price:{option:'divine',min:0,max:2}}},type_filters:{filters:{category:{option:'weapon.crossbow'}}}}});
  expect((req[1]!.headers as any).Cookie).toBeUndefined();expect(req[1]!.redirect).toBe('error');
 });
 it('rejects PoE1 link/color constraints before posting',async()=>{
  const fetch=network();expect(()=>new TradeQueryBuilder().withLinks(6)).toThrow(/PoE2/);
  expect(()=>new TradeQueryBuilder().withSockets(1,2,3)).toThrow(/PoE2/);
  expect(fetch).not.toHaveBeenCalled();
 });
 it('maps native equipment filters and validates unknown stats before POST',async()=>{
  const fetch=network();const c=new TradeApiClient({requestsPerSecond:10000});
  const q=new TradeQueryBuilder().withDefenses(undefined,undefined,{min:100}).withStats([{id:'explicit.invalid',min:2}]).build();
  expect(q.query.filters).toMatchObject({equipment_filters:{filters:{es:{min:100}}}});
  await expect(c.searchItems('Test League',q)).rejects.toThrow(/stat/i);
  expect(fetch.mock.calls.some(([url])=>String(url).includes('/search/'))).toBe(false);
 });
 it('uses displayed equipment ES without adding an unrelated flat ES modifier requirement',()=>{
  const q=TradeQueryBuilder.fromItemRequirements({slot:'Body Armour',minES:400,minSpirit:40,minWard:500,minRuneSockets:0}).build();
  expect(q.query.filters?.equipment_filters?.filters).toMatchObject({es:{min:400},spirit:{min:40},ward:{min:500},rune_sockets:{min:0}});
  expect(q.query.stats?.flatMap(g=>g.filters).some(s=>s.id==='pseudo.pseudo_total_energy_shield')).toBe(false);
 });
 it('keeps fetch cache separate by query identity and includes PoE2 realm',async()=>{
  const fetch=network();const c=new TradeApiClient({requestsPerSecond:10000});
  await c.fetchItems(['a'],'first');await c.fetchItems(['a'],'second');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[0][0])).toContain('realm=poe2');
 });
 it('does not retry a rejected request and parses the actual limit/period tuple',async()=>{
  const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(response({error:{message:'limit'}},429,{'Retry-After':'2','X-Rate-Limit-Rules':'Ip','X-Rate-Limit-Ip':'10:5:20','X-Rate-Limit-Ip-State':'10:5:0'}));
  const c=new TradeApiClient({requestsPerSecond:10000});await expect(c.getLeagues()).rejects.toThrow(/Rate limit/i);
  expect(c.getRateLimitInfo()).toMatchObject({limit:10,remaining:0,retryAfter:2000});
  await expect(c.getLeagues()).rejects.toThrow(/Rate limit/i);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('never caches an HTML/error body as empty market data',async()=>{
  const fetch=network();fetch.mockImplementation(async()=>response({error:{message:'bad shape'}}));
  const c=new TradeApiClient({requestsPerSecond:10000});await expect(c.getLeagues()).rejects.toThrow(/schema|response/i);
 });
 it('preserves the source rejection reason without retrying or returning an HTML error page',async()=>{
  const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(response({error:{code:2,message:'Query is too complex. Logging in will increase this limit.'}},400));
  const c=new TradeApiClient({requestsPerSecond:10000});
  await expect(c.getLeagues()).rejects.toThrow(/Query is too complex/);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(new Response('<html>private server page</html>',{status:502}));
  await expect(c.getLeagues()).rejects.toThrow(/502/);
 });
});
