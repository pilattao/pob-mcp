import Bottleneck from 'bottleneck';
import type {TradeQuery,SearchResult,StatData,LeagueData,RateLimitInfo,CacheEntry,ItemListing} from '../types/tradeTypes.js';

export type TradeGame='poe1'|'poe2';
export function tradeGame(): TradeGame {
  const value=process.env.POE_GAME??'poe2';
  if(value!=='poe1'&&value!=='poe2')throw new Error('POE_GAME must be poe1 or poe2');
  return value;
}
export function tradeSearchUrl(league:string,id:string,game:TradeGame=tradeGame()):string {
  return `https://www.pathofexile.com/${game==='poe2'?'trade2/search/poe2':'trade/search'}/${encodeURIComponent(league)}/${encodeURIComponent(id)}`;
}
const object=(x:any):x is Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function shape(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(`Invalid trade API response schema: ${message}`);}
function range(value:any,label:string) {
  if(!object(value))throw new Error(`${label} must be an object`);
  for(const key of ['min','max','weight'])if(value[key]!==undefined&&
    (typeof value[key]!=='number'||!Number.isFinite(value[key])))throw new Error(`${label}.${key} must be finite`);
  if(value.min!==undefined&&value.max!==undefined&&value.min>value.max)throw new Error(`${label}: min exceeds max`);
}

/** Read-only search/metadata/listing client. Failure never becomes an empty cached result. */
export class TradeApiClient {
  readonly game:TradeGame;
  private readonly baseUrl:string;
  private readonly limiter:Bottleneck;
  private readonly cache=new Map<string,CacheEntry<any>>();
  private readonly defaultCacheTTL:number;
  private rateLimitInfo:RateLimitInfo|null=null;
  private retryAt=0;
  constructor(options?:{requestsPerSecond?:number;cacheTTL?:number;game?:TradeGame}) {
    this.game=options?.game??tradeGame();
    this.baseUrl=`https://www.pathofexile.com/api/${this.game==='poe2'?'trade2':'trade'}`;
    const rps=options?.requestsPerSecond??(this.game==='poe2'?1:4);
    if(!Number.isFinite(rps)||rps<=0)throw new Error('requestsPerSecond must be positive');
    const ttl=options?.cacheTTL??300;
    if(!Number.isFinite(ttl)||ttl<0)throw new Error('cacheTTL must be finite and nonnegative');
    this.defaultCacheTTL=ttl*1000;
    this.limiter=new Bottleneck({maxConcurrent:1,minTime:Math.floor(1000/rps)});
  }
  async searchItems(league:string,query:TradeQuery):Promise<SearchResult> {
    if(typeof league!=='string'||!league.trim())throw new Error('An explicit league is required');
    if(!object(query)||!object(query.query))throw new Error('A trade query object is required');
    const copy=JSON.parse(JSON.stringify(query)) as TradeQuery;
    // Validate numbers before JSON serialization can turn NaN into null.
    for(const [group,value] of Object.entries(query.query.filters??{})) {
      for(const [key,filter] of Object.entries((value as any)?.filters??{}))range(filter,`${group}.${key}`);
    }
    for(const group of query.query.stats??[]) {
      if(group.value)range(group.value,'stat group');
      for(const stat of group.filters??[])if(stat.value)range(stat.value,stat.id);
    }
    if(this.game==='poe2')await this.validatePoe2(league,copy);
    const key=`search:${league}:${JSON.stringify(copy)}`;
    const cached=this.getFromCache<SearchResult>(key);if(cached)return cached;
    const url=`${this.baseUrl}/search/${this.game==='poe2'?'poe2/':''}${encodeURIComponent(league)}`;
    const data=await this.request<any>('POST',url,copy);
    shape(object(data)&&typeof data.id==='string'&&Array.isArray(data.result)&&data.result.every((id:any)=>typeof id==='string')&&Number.isFinite(data.total)&&data.total>=0,'search result');
    this.putInCache(key,data,this.defaultCacheTTL);return data as unknown as SearchResult;
  }
  async fetchItems(ids:string[],queryId?:string):Promise<ItemListing[]> {
    if(!ids.length)return [];
    if(ids.length>10)throw new Error('Cannot fetch more than 10 items at once');
    if(ids.some(id=>typeof id!=='string'||!id||id.length>512))throw new Error('Invalid listing IDs');
    if(this.game==='poe2'&&(!queryId||typeof queryId!=='string'))throw new Error('PoE2 listing fetch requires its query ID');
    const key=`fetch:${queryId??''}:${ids.join(',')}`;const cached=this.getFromCache<ItemListing[]>(key);if(cached)return cached;
    const params=new URLSearchParams();if(queryId)params.set('query',queryId);if(this.game==='poe2')params.set('realm','poe2');
    const url=`${this.baseUrl}/fetch/${ids.map(encodeURIComponent).join(',')}${params.size?'?'+params:''}`;
    const data=await this.request<any>('GET',url);shape(object(data)&&Array.isArray(data.result),'listing result');
    const items:ItemListing[]=[];
    for(const item of data.result) {
      if(item===null)continue; // Removed/unavailable listing, not a fabricated item.
      shape(object(item)&&typeof item.id==='string'&&object(item.item)&&object(item.listing),'listing entry');
      shape(ids.includes(item.id),'listing ID mismatch');items.push(item as ItemListing);
    }
    this.putInCache(key,items,this.defaultCacheTTL);return items;
  }
  private async metadata(kind:string):Promise<any> {
    const cached=this.getFromCache<any>(`metadata:${kind}`);if(cached)return cached;
    const data=await this.request<any>('GET',`${this.baseUrl}/data/${kind}`);
    shape(object(data)&&Array.isArray(data.result)&&data.result.length>0,`${kind} metadata`);
    if(kind==='leagues') {
      shape(data.result.every((r:any)=>object(r)&&typeof r.id==='string'), 'league entries');
      if(this.game==='poe2')data.result=data.result.filter((r:any)=>r.realm==='poe2');
      shape(data.result.length>0,'no leagues for the selected game');
    } else {
      const field=kind==='stats'?'entries':'filters';
      shape(data.result.every((r:any)=>object(r)&&Array.isArray(r[field])&& (kind==='stats'?typeof r.label==='string':typeof r.id==='string') && r[field].every((entry:any)=>object(entry)&&typeof entry.id==='string'&&(kind!=='stats'||typeof entry.text==='string'))),`${kind} groups`);
    }
    this.putInCache(`metadata:${kind}`,data,3600000);return data;
  }
  getStats():Promise<StatData>{return this.metadata('stats');}
  getStatData():Promise<StatData>{return this.getStats();}
  getLeagues():Promise<LeagueData>{return this.metadata('leagues');}
  getFilters():Promise<any>{return this.metadata('filters');}
  private async validatePoe2(league:string,query:TradeQuery):Promise<void> {
    if(!(await this.getLeagues()).result.some(row=>row.id===league))throw new Error(`Unknown PoE2 trade league: ${league}`);
    const groups=(await this.getFilters()).result;
    const options=(g:string,k:string)=>groups.find((x:any)=>x.id===g)?.filters.find((x:any)=>x.id===k)?.option?.options;
    const statuses=options('status_filters','status');
    if(!Array.isArray(statuses)||!statuses.some((x:any)=>x.id===query.query.status?.option))throw new Error('Unknown PoE2 online status');
    for(const [name,group] of Object.entries(query.query.filters??{})) {
      const native=groups.find((g:any)=>g.id===name);
      if(!native)throw new Error(`Filter group ${name} is not supported by the PoE2 trade metadata`);
      for(const [field,value] of Object.entries((group as any)?.filters??{})) {
        const found=native.filters.find((f:any)=>f.id===field);
        if(!found)throw new Error(`Unknown PoE2 filter ${name}.${field}`);
        if(object(value)&&value.option!==undefined) {
          if(name==='trade_filters'&&field==='sale_type'&&value.option===null)throw new Error('Omit default PoE2 sale_type rather than passing null');
          if(!found.option?.options?.some((o:any)=>o.id===value.option))throw new Error(`Unknown PoE2 option ${name}.${field}: ${String(value.option)}`);
        }
      }
    }
    if((query.query.stats??[]).some(g=>g.filters?.length)) {
      const known=new Set((await this.getStats()).result.flatMap(g=>g.entries.map(e=>e.id)));
      for(const g of query.query.stats??[]) {
        if(!['and','or','not','count','if','weight'].includes(g.type))throw new Error('Unknown stat group type');
        for(const f of g.filters)if(!known.has(f.id))throw new Error(`Unknown PoE2 trade stat ID: ${f.id}`);
      }
    }
  }
  getRateLimitInfo():RateLimitInfo|null{return this.rateLimitInfo;}
  clearCache():void{this.cache.clear();}
  clearCachePattern(pattern:string):void{for(const key of this.cache.keys())if(key.includes(pattern))this.cache.delete(key);}
  private async request<T>(method:'GET'|'POST',url:string,body?:unknown):Promise<T> {
    return this.limiter.schedule(async()=>{
      if(Date.now()<this.retryAt)throw new Error(`Rate limit cooldown; retry after ${Math.ceil((this.retryAt-Date.now())/1000)} seconds`);
      const headers:Record<string,string>={'Content-Type':'application/json','User-Agent':'poe2-mcp-suite/0.1 (+https://github.com/pilattao/poe_mcp_suite)'};
      if(this.game==='poe1') {const id=process.env.POE_SESSION_ID;if(id)headers.Cookie=`POESESSID=${id}`;}
      const response=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
      this.updateRateLimitInfo(response);
      if(response.status===429) {
        const delay=this.rateLimitInfo?.retryAfter??60000;this.retryAt=Math.max(this.retryAt,Date.now()+delay);
        throw new Error(`Rate limited. Retry after ${delay}ms`);
      }
      const declared=Number(response.headers.get('content-length'));
      if(declared>16*1024*1024)throw new Error('Trade API response exceeds size limit');
      const reader=response.body?.getReader();
      if(!reader)throw new Error('Trade API returned no response body');
      const chunks:Uint8Array[]=[];let bytes=0;
      for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>16*1024*1024){await reader.cancel();throw new Error('Trade API response exceeds size limit');}chunks.push(part.value);}
      let data:any;
      try {data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
      catch {
        if (!response.ok) throw new Error(`Trade API request failed (${response.status}); query was not retried`);
        throw new Error('Trade API returned invalid JSON response');
      }
      if (!response.ok) {
        const message = typeof data?.error?.message === 'string'
          ? data.error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : '';
        throw new Error(`Trade API request failed (${response.status})${message ? ': ' + message : ''}; query was not retried`);
      }
      shape(object(data)&&!data.error,'error or non-object body');return data as T;
    });
  }
  private updateRateLimitInfo(response:Response):void {
    const buckets:Array<{limit:number;remaining:number;period:number;restricted:number}>=[];
    const rules=(response.headers.get('X-Rate-Limit-Rules')??'Ip').split(',').map(s=>s.trim());
    for(const rule of rules) {
      const limits=response.headers.get(`X-Rate-Limit-${rule}`)?.split(',')??[];
      const states=response.headers.get(`X-Rate-Limit-${rule}-State`)?.split(',')??[];
      limits.forEach((text,i)=>{const [limit,period]=text.split(':').map(Number);const [used,statePeriod,restricted]=String(states[i]??'').split(':').map(Number);
        if(limit>0&&period>0&&Number.isFinite(used)&&statePeriod===period)buckets.push({limit,period,remaining:Math.max(0,limit-used),restricted:restricted||0});});
    }
    const retry=response.headers.get('Retry-After');let retryAfter:number|undefined;
    if(retry) {const seconds=Number(retry);retryAfter=Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(retry)-Date.now());if(!Number.isFinite(retryAfter))retryAfter=60000;}
    const restrictive=buckets.sort((a,b)=>a.remaining-b.remaining)[0];
    if(restrictive||retryAfter!==undefined)this.rateLimitInfo={limit:restrictive?.limit??0,remaining:restrictive?.remaining??0,retryAfter};
    let delay=retryAfter??0;
    for(const b of buckets)delay=Math.max(delay,b.restricted*1000,retryAfter===undefined&&b.remaining===0?b.period*1000:0);
    if(delay>0)this.retryAt=Math.max(this.retryAt,Date.now()+delay);
  }
  private getFromCache<T>(key:string):T|null {const row=this.cache.get(key);if(!row)return null;if(Date.now()>=row.expiresAt){this.cache.delete(key);return null;}return row.data as T;}
  private putInCache<T>(key:string,data:T,ttl:number):void {this.cache.set(key,{data,timestamp:Date.now(),expiresAt:Date.now()+ttl});}
}
