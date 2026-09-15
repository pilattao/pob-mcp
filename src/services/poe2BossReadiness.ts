import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import luaparse from 'luaparse';
import { resolvePobDataLocation } from './pobDataPath.js';
import { validationStat } from './passiveBudget.js';

export interface BossArea { id: string; name: string; baseAreaLevel?: number }
export interface Poe2Boss { name: string; areas: BossArea[] }
export interface BossCatalog { source: {path: string; sha256: string}; bosses: Poe2Boss[] }
export interface BossBenchmark { stat: string; min?: number; max?: number }
export interface BossReadinessOptions { build_name?: string; requirements?: BossBenchmark[] }
const normalize=(s: string)=>s.trim().toLowerCase().replace(/[^a-z0-9]+/g,' ');
const aliases: Record<string,string>={arbiter:'The Arbiter of Ash',olroth:'Olroth, Origin of the Fall',zarokh:'Zarokh, the Temporal',xesht:'Xesht, We That Are One',trialmaster:'The Trialmaster'};
let cache: {signature: string; value: BossCatalog}|undefined;
function literal(node: any): any {
  if (!node) return undefined;
  if (node.type==='StringLiteral') return Buffer.from(node.value,'latin1').toString('utf8');
  if (node.type==='NumericLiteral' || node.type==='BooleanLiteral') return node.value;
  if (node.type!=='TableConstructorExpression') return undefined;
  const result: Record<string,any>={};let index=0;
  for (const field of node.fields) {
    const key=field.type==='TableValue'?++index:field.type==='TableKeyString'?field.key.name:literal(field.key);
    if (key!==undefined) result[key]=literal(field.value);
  }
  return result;
}
/** Reads identities and base area records only; world-area tags are not boss damage types. */
export function loadPoe2BossCatalog(): BossCatalog {
  const location=resolvePobDataLocation();
  if (location.game!=='poe2') throw new Error('PoE2 boss identities require PoB2 data');
  const path=join(location.dataDir,'WorldAreas.lua'),stat=statSync(path),signature=`${path}:${stat.size}:${stat.mtimeMs}`;
  if (cache?.signature===signature) return cache.value;
  const content=readFileSync(path),ast=luaparse.parse(content.toString('latin1'),{comments:false,encodingMode:'pseudo-latin1'});
  const bosses=new Map<string,Poe2Boss>();
  const walk=(node: any): void=>{
    if (!node || typeof node!=='object') return;
    if (Array.isArray(node)) {node.forEach(walk);return;}
    if (node.type==='AssignmentStatement') node.variables.forEach((variable:any,index:number)=>{
      if (variable.type!=='IndexExpression' || variable.base?.name!=='worldAreas') return;
      const id=literal(variable.index),area=literal(node.init[index]);
      if (typeof id!=='string' || !area || typeof area.name!=='string') return;
      for (const name of Object.values(area.bossVarieties ?? {})) {
        if (typeof name!=='string' || !name.trim()) continue;
        const entry=bosses.get(name) ?? {name,areas:[]};
        entry.areas.push({id,name:area.baseName ?? area.name,...(Number.isFinite(area.level)?{baseAreaLevel:area.level}:{})});bosses.set(name,entry);
      }
    });
    for (const value of Object.values(node)) if (value && typeof value==='object') walk(value);
  };
  walk(ast);
  if (!bosses.size) throw new Error('No PoE2 boss identities in WorldAreas.lua');
  const value={source:{path,sha256:createHash('sha256').update(content).digest('hex')},bosses:[...bosses.values()].sort((a,b)=>a.name.localeCompare(b.name))};
  cache={signature,value};return value;
}
export function resolvePoe2Boss(requested: string,catalog=loadPoe2BossCatalog()): Poe2Boss {
  if (typeof requested!=='string' || !requested.trim()) throw new Error('A PoE2 boss name is required');
  const key=normalize(aliases[normalize(requested)] ?? requested);
  const exact=catalog.bosses.find(b=>normalize(b.name)===key);
  if (exact) return exact;
  const matches=catalog.bosses.filter(b=>normalize(b.name).startsWith(key+' '));
  if (matches.length===1) return matches[0];
  if (matches.length>1) throw new Error(`Ambiguous PoE2 boss: ${matches.map(b=>b.name).join(', ')}`);
  throw new Error(`PoE2 boss not found: ${requested}. Use an exact native name, such as The Arbiter of Ash or Olroth, Origin of the Fall.`);
}
export function assessBossBenchmarks(stats: Record<string,unknown>,requirements: BossBenchmark[]) {
  if (!Array.isArray(requirements) || requirements.length>50) throw new Error('requirements must contain at most 50 benchmarks');
  const checks=requirements.map(requirement=>{
    if (!requirement || typeof requirement.stat!=='string' || !/^[A-Za-z][\w:]*$/.test(requirement.stat)) throw new Error('Each benchmark requires an exact native stat name');
    if (requirement.min===undefined && requirement.max===undefined) throw new Error('Each benchmark requires min or max');
    for (const value of [requirement.min,requirement.max]) if (value!==undefined && (typeof value!=='number' || !Number.isFinite(value))) throw new Error('Benchmark bounds must be finite');
    if (requirement.min!==undefined && requirement.max!==undefined && requirement.min>requirement.max) throw new Error('Benchmark minimum exceeds maximum');
    const value=validationStat(stats,requirement.stat);
    const shortfall=value!==null && requirement.min!==undefined ? Math.max(0,requirement.min-value):undefined;
    const excess=value!==null && requirement.max!==undefined ? Math.max(0,value-requirement.max):undefined;
    const status=value===null?'unknown':(shortfall??0)>0 || (excess??0)>0?'not_met':'met';
    return {...requirement,value,status,shortfall,excess};
  });
  const status=!checks.length?'not_assessed':checks.some(c=>c.status==='not_met')?'not_met':checks.some(c=>c.status==='unknown')?'unknown':'met';
  return {status,source:'caller-defined benchmarks',checks,scope:'These checks do not establish successful completion of a boss encounter.'};
}
