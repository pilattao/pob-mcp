import type { TreeReadContext } from './poe2TreeOptimization.js';
import { measuredDelta, measuredTreeStats, withPoe2TreeRead } from './poe2TreeOptimization.js';
import { validationStat } from './passiveBudget.js';

const value = (number:number|null) => number===null?'unknown':String(number);
const limit = (number:unknown,name:string,max=100) => {
  if(typeof number!=='number'||!Number.isInteger(number)||number<0||number>max)throw new Error(`${name} must be an integer from 0 to ${max}`);
  return number;
};
const probes = [
  {mod:'+50 to maximum Life',per:50,unit:'1 Life'},
  {mod:'+50 to maximum Energy Shield',per:50,unit:'1 ES'},
  {mod:'+50 to maximum Mana',per:50,unit:'1 Mana'},
  {mod:'+20 to Strength',per:20,unit:'1 Strength'},
  {mod:'+20 to Dexterity',per:20,unit:'1 Dexterity'},
  {mod:'+20 to Intelligence',per:20,unit:'1 Intelligence'},
  {mod:'10% increased Attack Speed',per:10,unit:'1% increased Attack Speed'},
  {mod:'10% increased Cast Speed',per:10,unit:'1% increased Cast Speed'},
  {mod:'20% increased Spell Damage',per:20,unit:'1% increased Spell Damage'},
  {mod:'20% increased Critical Hit Chance',per:20,unit:'1% increased Critical Hit Chance'},
  {mod:'Minions deal 20% increased Damage',per:20,unit:'1% increased Minion Damage'},
  {mod:'+10% to all Elemental Resistances',per:10,unit:'1% all Elemental Resistances'},
];

export async function measurePoe2StatWeights(context:TreeReadContext,slot?:string,customMods?:string[]) {
  if(slot!==undefined&&(typeof slot!=='string'||!slot.trim()))throw new Error('slot must be a native equipped slot name');
  if(customMods!==undefined&&(!Array.isArray(customMods)||!customMods.length||customMods.length>40||customMods.some(mod=>typeof mod!=='string'||!mod.trim()||mod.length>=200||/[\r\n]/.test(mod))))throw new Error('Supply 1–40 single-line probe mods shorter than 200 characters');
  const requested=customMods?customMods.map(mod=>({mod,per:1,unit:'complete probe'})):probes;
  const data=await withPoe2TreeRead(context,undefined,async ({client,xml,info})=>{
    const request={slot,mods:requested.map(probe=>probe.mod),expectedBuildName:info.name,expectedXml:xml};
    const result=await client.probeStatWeights(request);
    const baseline=measuredTreeStats(result.base);
    const axes={CombinedDPS:'dpsDelta',FullDPS:'fullDpsDelta',MinionCombinedDPS:'minionDpsDelta',TotalEHP:'ehpDelta'};
    const returned=Array.isArray(result.results)?result.results:[];
    const rows=requested.map(probe=>{
      const matches=returned.filter(row=>row.mod===probe.mod);
      const row=matches.length===1?matches[0]:undefined;
      const status=row?.error?'error':row?.recognized===false?'unrecognized':row?.recognized===true?'measured':'unknown';
      const deltas=Object.fromEntries(Object.entries(axes).map(([key,field])=>[key,status==='measured'?validationStat(row,field):null]));
      const perUnit=Object.fromEntries(Object.entries(deltas).map(([key,delta])=>[key,delta===null?null:delta/probe.per]));
      const percentages=Object.fromEntries(Object.entries(deltas).map(([key,delta])=>[key,delta===null||baseline[key]===null||baseline[key]===0?null:100*delta/baseline[key]!]));
      return {...probe,status,error:row?.error??null,deltas,perUnit,percentages};
    });
    return {game:'poe2',baseline,rows,slot:result.slot,carrier:result.carrier,
      source:'Native probe_stat_weights; unchanged cloned carrier baseline and one additional mod per trial. Selected skill/configuration only.'};
  });
  const lines=['=== PoE2 measured stat sensitivities ===',data.source,`Carrier: ${data.slot} / ${data.carrier}`,
    `Baseline: ${['CombinedDPS','FullDPS','MinionCombinedDPS','TotalEHP'].map(key=>`${key} ${value(data.baseline[key])}`).join('; ')}`,
    'Finite differences for the stated probe size and carrier. Local modifiers can be slot-dependent. Results apply only to this snapshot and probe size; do not extrapolate linearly.',
    '| Probe | Status | CombinedDPS Δ | FullDPS Δ | Minion DPS Δ | Native EHP Δ | Δ/unit (DPS; EHP) | DPS % |',
    '|---|---|---|---|---|---|---|---|'];
  for(const row of data.rows)lines.push(`| ${row.mod.replace(/\|/g,'/')} | ${row.status} | ${value(row.deltas.CombinedDPS)} | ${value(row.deltas.FullDPS)} | ${value(row.deltas.MinionCombinedDPS)} | ${value(row.deltas.TotalEHP)} | ${value(row.perUnit.CombinedDPS)}; ${value(row.perUnit.TotalEHP)} per ${row.unit} | ${value(row.percentages.CombinedDPS)}${row.percentages.CombinedDPS===null?'':'%'} |`);
  for(const row of data.rows)if(row.error)lines.push(`${row.mod}: ${row.error}`);
  lines.push('A recognized zero is a measured zero for this scenario. Missing, rejected or unrecognized outputs remain unknown.',
    `Verified unchanged XML and native stats: ${data.verification.xmlSha256}`);
  return {content:[{type:'text' as const,text:lines.join('\n')}],structuredContent:data};
}

export async function measurePoe2Anoints(context:TreeReadContext,args:{slot:string;focus?:'dps'|'defence'|'both';max_results?:number}) {
  if(!args||typeof args.slot!=='string'||!args.slot.trim())throw new Error('A native equipped slot is required');
  const focus=args.focus??'both';
  if(!['dps','defence','both'].includes(focus))throw new Error('Invalid anoint focus');
  const count=limit(args.max_results??10,'max_results',50);
  const data=await withPoe2TreeRead(context,undefined,async ({client,xml,info})=>{
    const guard={expectedBuildName:info.name,expectedXml:xml};
    const baselineRequest={useFullDPS:true,...guard};
    const current=measuredTreeStats(await client.calcWith(baselineRequest));
    const request={slot:args.slot,focus,limit:10000,...guard};
    const result=count?await client.evaluateAnointCandidates(request):null;
    const uninstilled=measuredTreeStats(result?.base);
    const candidates=(result?.candidates??[]).map(candidate=>{
      const dps=validationStat(candidate,'dpsDelta'),ehp=validationStat(candidate,'ehpDelta');
      const after={CombinedDPS:uninstilled.CombinedDPS===null||dps===null?null:uninstilled.CombinedDPS+dps,
        TotalEHP:uninstilled.TotalEHP===null||ehp===null?null:uninstilled.TotalEHP+ehp};
      return {nodeId:candidate.nodeId,name:candidate.name,recipe:candidate.recipe??[],after,
        currentDeltas:{CombinedDPS:measuredDelta(current.CombinedDPS,after.CombinedDPS),
          TotalEHP:measuredDelta(current.TotalEHP,after.TotalEHP)},
        uninstilledDeltas:{CombinedDPS:dps,TotalEHP:ehp}};
    });
    const axes: Array<'CombinedDPS'|'TotalEHP'>=focus==='dps'?['CombinedDPS']:focus==='defence'?['TotalEHP']:['CombinedDPS','TotalEHP'];
    const measured=candidates.filter(candidate=>axes.every(key=>candidate.after[key]!==null));
    const eligible=focus==='both'?measured.filter(candidate=>!measured.some(other=>other!==candidate&&axes.every(key=>measuredDelta(candidate.after[key],other.after[key])!>=0)&&axes.some(key=>measuredDelta(candidate.after[key],other.after[key])!>0))):measured;
    eligible.sort((a,b)=>b.after[axes[0]]!-a.after[axes[0]]!||a.nodeId-b.nodeId);
    // Sample the entire frontier so a short "both" result retains both extremes.
    const selected=focus==='both'&&count>1&&eligible.length>count
      ? Array.from({length:count},(_,index)=>eligible[Math.round(index*(eligible.length-1)/(count-1))]) : eligible.slice(0,count);
    return {game:'poe2',focus,slot:args.slot,current,uninstilled,candidates:selected,evaluated:result?.evaluated??0,
      skipped:result?.skipped??0,unknownMeasurements:candidates.length-measured.length,
      source:'Native evaluate_anoint_candidates compares against an uninstilled clone. Current deltas also compare with calc_with baseline; no item is changed.',
      ranking:focus==='both'?'Pareto alternatives across DPS and native TotalEHP; both extremes retained when showing at least two. No fixed combined weights.':'Native '+axes[0]};
  });
  const lines=['=== PoE2 native instilling comparisons ===',data.source,data.ranking,
    `Current: CombinedDPS ${value(data.current.CombinedDPS)}; TotalEHP ${value(data.current.TotalEHP)}`,
    `Uninstilled baseline: CombinedDPS ${value(data.uninstilled.CombinedDPS)}; TotalEHP ${value(data.uninstilled.TotalEHP)}`,
    `Evaluated: ${data.evaluated}; skipped: ${data.skipped}; missing measurements: ${data.unknownMeasurements}`];
  for(const candidate of data.candidates)lines.push(`${candidate.name} [${candidate.nodeId}]: current DPS Δ ${value(candidate.currentDeltas.CombinedDPS)}; current native EHP Δ ${value(candidate.currentDeltas.TotalEHP)}`,
    `Native instilling recipe: ${candidate.recipe.join(' + ')||'unknown'}`);
  lines.push('Item eligibility and recipes come from the native calculator. Recipe prices and encounter viability are unknown. Relative 1e-12 numerical noise is treated as zero.',
    `Verified unchanged XML and native stats: ${data.verification.xmlSha256}`);
  return {content:[{type:'text' as const,text:lines.join('\n')}],structuredContent:data};
}

export async function readPoe2NodePower(context:TreeReadContext,mode='combined',filter='unallocated',maxDepth?:number,count=20,recalculate=false) {
  if(!['combined','offence','defence'].includes(mode)||!['unallocated','allocated','all'].includes(filter))throw new Error('Invalid node-power mode/filter');
  limit(count,'limit',100);if(maxDepth!==undefined)limit(maxDepth,'max_depth',100);
  const data=await withPoe2TreeRead(context,undefined,async ({client})=>({
    game:'poe2',native:await client.getNodePower({mode:mode as any,filter:filter as any,max_depth:maxDepth,limit:count,recalculate}),
    source:'Native node-power heat-map cache. Its heuristic scores are not measured DPS/EHP deltas or a validated allocation plan.',
    freshness:'Unknown unless the native cache confirms completion for the current state; recalc_pending means partial results.',
  }));
  const lines=['=== PoE2 native node-power cache ===',data.source,data.freshness,
    `Data: ${data.native?.has_data===true?'available':'unavailable'}; calculation pending: ${data.native?.recalc_pending===true}`];
  for(const node of data.native?.nodes??[])lines.push(`${node.name??'unnamed'} [${node.id}]: offence ${value(validationStat(node,'offence'))}; defence ${value(validationStat(node,'defence'))}; native combined ${value(validationStat(node,'combined'))}; graph hops ${value(validationStat(node,'depth'))}`);
  lines.push('Use measured tree proposals to check connector cost, both weapon sets, ascendancy pools and constraints.',`Verified unchanged XML and native stats: ${data.verification.xmlSha256}`);
  return {content:[{type:'text' as const,text:lines.join('\n')}],structuredContent:data};
}
