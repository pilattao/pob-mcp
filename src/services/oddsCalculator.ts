/**
 * Crafting roll-odds calculator.
 *
 * The legacy PoE1 model computes target probabilities when rolling an item,
 * using the real spawn weights from PoB's ModItem.lua (which originate from
 * the game's data bundles). The model is exact for the cases it covers:
 *
 *   - Mods are drawn from the prefix/suffix pool weighted by spawn weight.
 *   - Drawing a mod removes its entire mod-GROUP from the pool (only one mod
 *     per group can roll), i.e. sampling without replacement at group level.
 *   - Prefixes and suffixes are independent given a fixed affix count per
 *     side (the caller supplies prefix_count / suffix_count rather than us
 *     guessing PoE's per-orb affix-count distribution).
 *
 * What it does NOT model (out of scope — see calculate_mod_odds docs):
 *   fossil weight biasing, harvest reforge, meta-craft sequences, exact
 *   per-orb affix-count variance, and currency-cost EV.
 *
 * PoE2 uses a separate conditional one-step CoE model below. The legacy pool
 * builder rejects native PoB2 eligibility flags as probability inputs.
 */

import { searchMods, resolveWeightForTags, type PobMod } from "./pobModDataLoader.js";
import { getBase, type PobBase } from "./pobBaseDataLoader.js";
import { resolvePobDataLocation } from "./pobDataPath.js";
import { readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

export interface GroupInfo {
  group: string;
  /** Total spawn weight of the group on the base (sum over its mods). */
  totalWeight: number;
  /** The group's mods (on this base, eligible at ilvl), sorted top tier first. */
  mods: PobMod[];
}

export interface EligiblePool {
  prefixes: GroupInfo[];
  suffixes: GroupInfo[];
  prefixWeight: number;
  suffixWeight: number;
}

/**
 * Build the eligible natural-roll pool for a base at a given ilvl. A mod is
 * eligible iff: affixed (has a real prefix/suffix name — excludes Hellscape/
 * synthesis/implicit entries), spawn weight > 0 on the base's tag chain, and
 * mod level <= ilvl. Grouped by mod-group with summed weights.
 */
export function buildEligiblePool(base: PobBase, ilvl: number): EligiblePool {
  if (resolvePobDataLocation().game === "poe2") {
    throw new Error("PoE2 PoB eligibility flags cannot be used as probability weights. Use the validated CoE one-step model.");
  }
  const all = searchMods({ itemTags: base.tags, limit: 0 });
  const prefixMap = new Map<string, GroupInfo>();
  const suffixMap = new Map<string, GroupInfo>();

  for (const mod of all) {
    if (!mod.affix || mod.affix.length === 0) continue;
    if (!mod.group) continue;
    if (mod.level > ilvl) continue;
    const w = resolveWeightForTags(mod, base.tags);
    if (w <= 0) continue;
    const type = mod.type.toLowerCase();
    const target = type === "prefix" ? prefixMap : type === "suffix" ? suffixMap : null;
    if (!target) continue;
    const gi = target.get(mod.group) ?? { group: mod.group, totalWeight: 0, mods: [] };
    gi.totalWeight += w;
    gi.mods.push(mod);
    target.set(mod.group, gi);
  }

  const finalize = (m: Map<string, GroupInfo>): GroupInfo[] => {
    const arr = Array.from(m.values());
    for (const gi of arr) gi.mods.sort((a, b) => b.level - a.level);
    return arr;
  };

  const prefixes = finalize(prefixMap);
  const suffixes = finalize(suffixMap);
  return {
    prefixes,
    suffixes,
    prefixWeight: prefixes.reduce((s, g) => s + g.totalWeight, 0),
    suffixWeight: suffixes.reduce((s, g) => s + g.totalWeight, 0),
  };
}

/**
 * Exact probability that ALL target group ids appear within K weighted draws
 * without replacement from `groups`. At each draw, the chance of selecting a
 * remaining group is its weight / total remaining weight; the selected group
 * leaves the pool.
 *
 * Pure function (no PoB data) — unit-tested against hand-computable cases.
 * For equal weights it reduces to the hypergeometric result P = K/n for a
 * single target.
 */
export function probAllTargetsDrawn(
  groups: Array<{ id: string; weight: number }>,
  targetIds: string[],
  K: number
): number {
  const needed = new Set(targetIds);
  // Targets not present in the pool can never be drawn.
  for (const t of needed) {
    if (!groups.some((g) => g.id === t)) return 0;
  }

  function recurse(remaining: Array<{ id: string; weight: number }>, drawsLeft: number, need: Set<string>): number {
    if (need.size === 0) return 1;
    if (drawsLeft === 0) return 0;
    if (need.size > drawsLeft) return 0;
    let total = 0;
    for (const g of remaining) total += g.weight;
    if (total <= 0) return 0;
    let p = 0;
    for (let i = 0; i < remaining.length; i++) {
      const g = remaining[i];
      if (g.weight <= 0) continue;
      const pPick = g.weight / total;
      const newRemaining = remaining.slice(0, i).concat(remaining.slice(i + 1));
      let newNeed = need;
      if (need.has(g.id)) {
        newNeed = new Set(need);
        newNeed.delete(g.id);
      }
      p += pPick * recurse(newRemaining, drawsLeft - 1, newNeed);
    }
    return p;
  }

  return recurse(groups, K, needed);
}

// ---------------------------------------------------------------------------
// PoE2: conditional one-operation model using the shared, read-only CoE cache.
// Verified 2026-09-15 against ModsManager.getFilteredModPool and
// EmulatorManager.rollAffix/augment/regal/exalt in the primary site worker:
// https://beta.craftofexile.com/packages/files/package_worker_simulator_processor_poe2.js?v=1789404199
// Plain operations draw ONE mod across the remaining weighted pool. Exclusion
// uses shared families, level bands and rarity-specific side caps. PoB's 1/0
// eligibility flags never enter this computation. No cache/network/app writes.
// ---------------------------------------------------------------------------
const COE_SITE = 'https://beta.craftofexile.com/';
const COE_PATCH = '4.5.5.1.5';
const COE_MODEL_SOURCE = COE_SITE + 'packages/files/package_worker_simulator_processor_poe2.js?v=1789404199';

type CoeObject = Record<string, unknown>;
interface CoeStat { index: number | null; label: number; range: number[] | false; values: boolean }
interface CoeMod { id: number; key: string; group: number; minlvl: number; maxlvl: number; power: number; label: number | null; stats: CoeStat[] }
interface CoeGroup { id: number; type: number; domain: number; influence: number; families: number[]; adds: number[]; gtags: number[]; gvals: number[] }
interface CoeSnapshot {
  path: string; signature: string; sha256: string; patch: string; fetchedAt: number;
  files: CoeObject; lang: string[]; data: CoeObject;
  mods: Map<number, CoeMod>; groups: Map<number, CoeGroup>; families: Map<number, string>;
  items: CoeObject[]; classes: Map<number, CoeObject>; classmods: CoeObject; stateEffects: CoeObject;
}
export class Poe2OddsCoverageError extends Error {
  readonly code = 'POE2_ODDS_COVERAGE_GAP';
}
function gap(reason: string): never { throw new Poe2OddsCoverageError(reason); }
function coeObject(value: unknown, label: string): CoeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) gap(`Invalid CoE ${label}.`);
  return value as CoeObject;
}
function coeArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) gap(`Invalid CoE ${label}.`);
  return value;
}
function coeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) gap(`Invalid CoE ${label}.`);
  return value;
}
function coeId(value: unknown, label: string): number {
  const n = coeNumber(value, label);
  if (!Number.isSafeInteger(n) || n < 0) gap(`Invalid CoE ${label}.`);
  return n;
}
function coeIds(value: unknown, label: string): number[] { return coeArray(value,label).map(v=>coeId(v,label)); }
function coeEntries(data: CoeObject, key: string): CoeObject[] {
  const result = coeArray(coeObject(data[key],key).entries,`${key}.entries`).map(v=>coeObject(v,key));
  if (!result.length) gap(`Empty CoE ${key}.entries.`);
  const ids = result.map(v=>coeId(v.id,`${key} ID`));
  if (new Set(ids).size !== ids.length) gap(`Duplicate CoE ${key} IDs.`);
  return result;
}
function coeText(text: string): string {
  return text.replace(/\[([^\]|]+)\|([^\]]+)\]/g,'$2').replace(/\[([^\]]+)\]/g,'$1')
    .replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"');
}
let coeCached: CoeSnapshot | undefined;
function loadCoeSnapshot(): CoeSnapshot {
  // Same root convention as the Python port. An explicit file is useful for
  // review/snapshot verification; no hardcoded personal cache path is used.
  const defaultRoot = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'poe-data-mcp','Cache','craftofexile')
    : join(process.env.XDG_CACHE_HOME || join(homedir(),'.cache'),'poe-data-mcp','craftofexile');
  const path = resolve(process.env.POE2_COE_BUNDLE_PATH || join(process.env.POE_DATA_MCP_CACHE_DIR || defaultRoot,'poe2','bundle.json'));
  let stat;
  try { stat=statSync(path); } catch { gap(`Validated CoE PoE2 cache missing at ${path}. Refresh it with poe-data-mcp or set POE_DATA_MCP_CACHE_DIR / POE2_COE_BUNDLE_PATH. Native PoB eligibility is not a probability fallback.`); }
  const signature=JSON.stringify([path,stat.mtimeMs,stat.ctimeMs,stat.size]);
  if (coeCached?.signature===signature) return coeCached;
  const raw=readFileSync(path,'utf8');
  const bundle=coeObject(JSON.parse(raw),'bundle');
  if (bundle.game!=='poe2'||bundle.source!==COE_SITE+'?game=poe2') gap('Cache does not identify the verified Craft of Exile PoE2 source.');
  if (bundle.patch!==COE_PATCH) gap(`CoE operation model verified for ${COE_PATCH}; snapshot ${String(bundle.patch)} requires re-verification.`);
  const files=coeObject(bundle.files,'files');
  for(const [key,suffix] of [['data','data.json'],['lang','localization/english.json']]) {
    const value=files[key];
    const prefix=COE_SITE+`json/poe2/${COE_PATCH}/${suffix}`;
    if(typeof value!=='string'||!(value===prefix||value.startsWith(prefix+'?v=')&&/^\d+$/.test(value.slice(prefix.length+3)))) gap('CoE data/localization provenance does not belong to the same verified patch.');
  }
  const fetchedAt=coeNumber(bundle.fetched_at,'fetched_at');
  if(fetchedAt<=0) gap('Missing CoE snapshot timestamp.');
  const lang=coeArray(bundle.lang,'localization').map(v=>typeof v==='string'?v:gap('Invalid CoE localization text.'));
  function labelIndex(value: unknown): number { const i=coeId(value,'localization index');if(i>=lang.length)gap('CoE localization index out of range.');return i; }
  const data=coeObject(bundle.data,'data');
  const types=coeObject(coeObject(data.enums,'enums').types,'types');
  if(types['1']!=='PREFIX'||types['2']!=='SUFFIX') gap('CoE affix type enum changed.');
  const families=new Map(coeEntries(data,'families').map(e=>[Number(e.id),typeof e.key==='string'?e.key:gap('Invalid CoE family key.')]));
  const groups=new Map<number,CoeGroup>();
  for(const e of coeEntries(data,'modgroups')) {
    const g:CoeGroup={id:Number(e.id),type:coeId(e.type,'group type'),domain:coeId(e.domain,'group domain'),influence:coeId(e.influence,'influence'),
      families:coeIds(e.families,'families'),adds:coeIds(e.adds,'adds'),gtags:coeIds(e.gtags,'generation tags'),gvals:coeArray(e.gvals,'generation values').map(v=>coeNumber(v,'generation value'))};
    if(g.families.some(id=>!families.has(id))||g.gtags.length!==g.gvals.length)gap('Invalid CoE group relationships.');
    groups.set(g.id,g);
  }
  const mods=new Map<number,CoeMod>();
  const modKeys=new Set<string>();
  for(const e of coeEntries(data,'mods')) {
    if(typeof e.key!=='string'||modKeys.has(e.key))gap('Invalid/duplicate CoE modifier key.');
    modKeys.add(e.key);
    const m:CoeMod={id:Number(e.id),key:e.key,group:coeId(e.group,'mod group'),minlvl:coeId(e.minlvl,'minimum level'),maxlvl:coeId(e.maxlvl,'maximum level'),
      power:e.power==null?0:coeNumber(e.power,'mod power'),label:e.label==null?null:labelIndex(e.label),stats:coeArray(e.stats,'mod stats').map(v=>{
        const s=coeObject(v,'mod stat');const range=s.range===false?false:coeArray(s.range,'stat range').map(v=>coeNumber(v,'stat bound'));
        if(range!==false&&range.length!==2)gap('Invalid CoE stat range.');
        if(typeof s.values!=='boolean')gap('Invalid CoE stat values flag.');
        // The source uses null for unresolved special stats (for example
        // EssenceGrantedPassive). Preserve it; do not invent a stat identity.
        return {index:s.index===null?null:coeId(s.index,'stat index'),label:labelIndex(s.label),range,values:s.values};
      })};
    if(!groups.has(m.group)||m.minlvl>m.maxlvl)gap(`Invalid CoE modifier ${m.key}.`);
    mods.set(m.id,m);
  }
  const classes=new Map(coeEntries(data,'classes').map(e=>{labelIndex(e.label);return [Number(e.id),e] as const;}));
  const items=coeEntries(data,'items');
  for(const item of items){labelIndex(item.label);if(item.class!=null&&!classes.has(Number(item.class)))gap('Unknown CoE item class.');}
  const classmods=coeObject(data.classmods,'classmods');
  for(const [classId,entries]of Object.entries(classmods)) {
    if(!classes.has(Number(classId)))gap('Unknown CoE class pool.');
    for(const [id,value]of Object.entries(coeObject(entries,'class weights'))) {
      if(!mods.has(Number(id))||coeNumber(value,'weight')<0)gap('Invalid or missing CoE weight/modifier relationship.');
    }
  }
  const stateEffects=coeObject(coeObject(data.mods,'mods').stateffects,'modifier state effects');
  coeCached={path,signature,sha256:createHash('sha256').update(raw).digest('hex'),patch:COE_PATCH,fetchedAt,files,lang,data,mods,groups,families,items,classes,classmods,stateEffects};
  return coeCached;
}
function coeModText(s: CoeSnapshot,m: CoeMod): string {
  let text=[...new Set(m.stats.map(stat=>stat.label))].map(i=>coeText(s.lang[i])).join('; ');
  let last:string|undefined;
  for(const stat of m.stats) if(stat.range!==false&&stat.values) {
    const [lo,hi]=stat.range;last=lo===hi?String(lo):`(${lo}-${hi})`;text=text.replace('#',last);
  }
  return last===undefined?text:text.replace(/#/g,last);
}
export interface Poe2OneStepArgs {
  method?: string; item_rarity?: string; existing_mod_ids?: string[];
  targets: Array<{stat?:string;group?:string;min_tier?:number}>;
  prefix_count?: number; suffix_count?: number; essence_name?: string;
}
export function calculatePoe2OneStepOdds(base: PobBase,ilvl: number,args: Poe2OneStepArgs) {
  if(resolvePobDataLocation().game!=='poe2')gap('The CoE PoE2 model requires PoE2 data selection.');
  const method=args.method;
  if(!method||!['exalt','augment','regal'].includes(method))gap(`PoE2 method '${method??'unspecified'}' is not modeled. Choose plain exalt, augment or regal; PoE1 alteration/chaos/essence full-reroll semantics do not apply.`);
  const requiredRarity=method==='exalt'?'rare':'magic';
  if(args.item_rarity!==requiredRarity)gap(`${method} requires item_rarity='${requiredRarity}'.`);
  if(!Array.isArray(args.existing_mod_ids)||args.existing_mod_ids.some(id=>typeof id!=='string'||!id))gap('Supply the complete existing_mod_ids list of CoE modifier keys, even if empty. Counts alone cannot establish family blocking.');
  if(args.prefix_count!==undefined||args.suffix_count!==undefined||args.essence_name!==undefined)gap('PoE2 one-step odds use complete existing_mod_ids, not PoE1 reroll counts or essence guarantees.');
  if(!Number.isSafeInteger(ilvl)||ilvl<1||ilvl>100)gap('PoE2 item level must be an integer from 1 to 100.');
  const s=loadCoeSnapshot();
  const candidates=s.items.filter(item=>coeText(s.lang[Number(item.label)]).trim().toLowerCase()===base.name.trim().toLowerCase());
  if(candidates.length!==1)gap(`No unambiguous exact CoE item mapping for '${base.name}'; no class/name approximation is used.`);
  const item=candidates[0];const cls=s.classes.get(Number(item.class));
  if(!cls||cls.legacy!==false||cls.unmodifiable||cls.rarity!=null||cls.affixes!=null||item.domain!==1||item.unmodifiable||item.corrupt)gap('Only ordinary modifiable equipment with standard rarity limits is covered.');
  const weights=coeObject(s.classmods[String(cls.id)],'selected class pool');
  const ordinary=Object.entries(weights).filter(([id,w])=>{
    const g=s.groups.get(s.mods.get(Number(id))!.group)!;return Number(w)>0&&g.domain===1&&g.influence===6&&(g.type===1||g.type===2);
  }).map(([id,w])=>({mod:s.mods.get(Number(id))!,weight:Number(w)}));
  if(!ordinary.length)gap('No validated ordinary CoE modifier pool for this class.');
  if(ordinary.some(({mod})=>mod.stats.some(stat=>stat.index===null)))gap('An ordinary CoE modifier has an unresolved stat identity; odds withheld.');
  if(ordinary.some(({mod})=>{const g=s.groups.get(mod.group)!;return g.gtags.length>0||g.adds.length>0;}))gap('Conditional generation/additional-tag modifiers require an expanded model; odds withheld.');
  const existing=args.existing_mod_ids.map(key=>ordinary.find(row=>row.mod.key===key)?.mod??gap(`Existing modifier '${key}' is unknown, special-pool, or ineligible for this CoE class.`));
  const counts={prefix:0,suffix:0};const occupiedFamilies=new Set<number>();const occupiedGroups=new Set<number>();
  for(const mod of existing){
    const group=s.groups.get(mod.group)!;
    if(occupiedGroups.has(group.id)||group.families.some(id=>occupiedFamilies.has(id)))gap('Existing affixes contain duplicate/conflicting CoE families.');
    if(mod.minlvl>ilvl)gap(`Existing ${mod.key} exceeds the supplied item level.`);
    occupiedGroups.add(group.id);group.families.forEach(id=>occupiedFamilies.add(id));
    counts[group.type===1?'prefix':'suffix']++;
  }
  const beforeCap=requiredRarity==='magic'?1:3;
  if(counts.prefix>beforeCap||counts.suffix>beforeCap)gap('Existing modifier counts exceed the supplied rarity limits.');
  const intrinsic=coeIds(item.implicits,'item implicits').concat(coeIds(item.enchants,'item enchants'))
    .map(id=>s.mods.get(id)??gap(`Missing intrinsic CoE modifier ${id}.`));
  if([...existing,...intrinsic].some(m=>m.stats.some(stat=>stat.index===null||Object.hasOwn(s.stateEffects,String(stat.index)))))gap('Existing/intrinsic modifier state effects are not modeled; odds withheld.');
  const cap=method==='augment'?1:3;
  const pool=ordinary.filter(({mod})=>{
    const g=s.groups.get(mod.group)!;
    return mod.minlvl<=ilvl&&mod.maxlvl>=ilvl&&!occupiedGroups.has(g.id)&&!g.families.some(id=>occupiedFamilies.has(id))&&counts[g.type===1?'prefix':'suffix']<cap;
  });
  const totalWeight=pool.reduce((sum,row)=>sum+row.weight,0);
  if(totalWeight<=0||!Number.isFinite(totalWeight))gap('No eligible open-affix outcome for this operation.');
  const targetGroups=new Map<number,CoeMod[]>();
  for(const {mod}of ordinary){const list=targetGroups.get(mod.group)??[];list.push(mod);targetGroups.set(mod.group,list);}
  for(const list of targetGroups.values())list.sort((a,b)=>b.minlvl-a.minlvl||b.power-a.power);
  const targets=args.targets.map(t=>{
    if(t.min_tier!==undefined&&(!Number.isSafeInteger(t.min_tier)||t.min_tier<1))gap('min_tier must be a positive integer.');
    const matches=[...targetGroups].filter(([id,mods])=>{
      if(t.group){const g=s.groups.get(id)!;return t.group===`coe:${id}`||g.families.some(fid=>s.families.get(fid)===t.group);}
      return !!t.stat?.trim()&&mods.some(m=>coeModText(s,m).toLowerCase().includes(t.stat!.trim().toLowerCase()));
    });
    if(matches.length!==1)gap(`Target '${t.group??t.stat??''}' needs one exact CoE group; matches: ${matches.map(([id,ms])=>`coe:${id} (${coeModText(s,ms[0])})`).join(', ')||'none'}.`);
    const [id,mods]=matches[0];const qualifying=t.min_tier===undefined?mods:mods.slice(0,t.min_tier);
    return {group:`coe:${id}`,label:t.group??t.stat!,qualifying_mod_ids:qualifying.map(m=>m.key),
      already_satisfied:existing.some(m=>qualifying.some(q=>q.id===m.id))};
  });
  const successful=pool.filter(({mod})=>targets.every(t=>t.already_satisfied||t.qualifying_mod_ids.includes(mod.key)));
  const qualifyingWeight=successful.reduce((sum,row)=>sum+row.weight,0);
  return {
    game:'poe2',coverage:'conditional-estimate',base:base.name,ilvl,method,
    source:{game:'poe2',provider:'Craft of Exile',url:COE_SITE+'?game=poe2',patch:s.patch,files:s.files,
      cache_path:s.path,fetched_at:new Date(s.fetchedAt*1000).toISOString(),age_seconds:Math.max(0,Math.floor(Date.now()/1000-s.fetchedAt)),
      sha256:s.sha256,weight_kind:'estimated',model_source:COE_MODEL_SOURCE},
    operation:{rarity_before:requiredRarity,rarity_after:method==='augment'?'magic':'rare',added_modifiers:1,
      retained_mod_ids:args.existing_mod_ids,prefixes_before:counts.prefix,suffixes_before:counts.suffix},
    pool:{class_id:cls.id,class_name:coeText(s.lang[Number(cls.label)]),eligible_modifiers:pool.length,total_weight:totalWeight,qualifying_weight:qualifyingWeight},
    targets,combined_probability:qualifyingWeight/totalWeight,estimated_attempts:null,
    assumptions:['Complete existing ordinary explicit modifiers were supplied.','Plain uncorrupted, unmirrored item; no omens, catalysts, sanctification, special affix limits or extra crafting effects.',
      'CoE weights are estimates, not measured in-game probabilities.','Tiers use the full CoE class/group ordering by minimum level and power before item-level filtering.',
      'One operation changes the item. Repeated attempts, item preparation and currency costs are not modeled.'],
  };
}
