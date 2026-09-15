import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { AnyLuaClient } from '../pobLuaBridge.js';
import type { PoBBuild, PassiveTreeData, PassiveTreeNode } from '../types.js';
import type { OptimizationConstraints } from '../types/optimization.js';
import { BuildService } from './buildService.js';
import { TreeService } from './treeService.js';
import { costsPassivePoint, poe2PassiveBudget, validationStat } from './passiveBudget.js';
import { resolvePobDataLocation } from './pobDataPath.js';
import { nativeBuildMatches } from './nativeBuildIdentity.js';

export interface TreeReadContext {
  getLuaClient?: () => AnyLuaClient | null;
  ensureLuaClient?: () => Promise<void>;
  buildService?: BuildService;
  treeService?: TreeService;
}
export interface Poe2TreeOptions {
  allocation_mode?: 'shared' | 'weapon1' | 'weapon2';
  candidate_node_ids?: number[];
  remove_node_ids?: number[];
  attribute_choices?: Record<string, 'str' | 'dex' | 'int'>;
  points_available?: number;
  max_candidates?: number;
  max_distance?: number;
  preserve_keystones?: boolean;
}
interface SearchCutoff {
  iteration:number;
  evaluatedTrials:number;
  targetNode:number|null;
  unvisitedTargetIds:number[];
  untestedAttributeVariants:number;
  unvisitedRemovalVariants:number;
}
export const TREE_STAT_FIELDS = [
  'CombinedDPS','TotalDPS','FullDPS','MinionCombinedDPS','Life','EnergyShield','Mana','TotalEHP',
  'Str','Dex','Int','ReqStr','ReqDex','ReqInt','ExtraPoints','PassivePointsToWeaponSetPoints','MovementSpeedMod',
  ...['Fire','Cold','Lightning','Chaos'].flatMap(kind=>[kind+'Resist','Missing'+kind+'Resist']),
  ...['Physical','Fire','Cold','Lightning','Chaos'].map(kind=>kind+'MaximumHitTaken'),
];
export type MeasuredStats = Record<string, number | null>;
/** Native JSON serialization and baseline subtraction can differ in the last
 * digits. Preserve the scalar measurements while treating relative 1e-12 noise
 * as equality for deltas and comparisons; this is not a viability threshold. */
export function measuredDelta(before:number|null,after:number|null):number|null {
  if(before===null||after===null)return null;
  const delta=after-before;
  return Math.abs(delta)<=Math.max(1,Math.abs(before),Math.abs(after))*1e-12?0:delta;
}
export function measuredTreeStats(raw: any): MeasuredStats {
  const result = Object.fromEntries(TREE_STAT_FIELDS.map(key=>[key,validationStat(raw,key)]));
  for(const key of Object.keys(raw??{})) {
    const number=validationStat(raw,key);
    if(number!==null)result[key]=number;
  }
  result.MinionCombinedDPS = validationStat(raw,'MinionCombinedDPS') ?? validationStat(raw?.Minion,'CombinedDPS');
  const hits = ['Physical','Fire','Cold','Lightning','Chaos'].map(kind=>result[kind+'MaximumHitTaken']);
  result.MinimumMaximumHitTaken = hits.every(value=>value!==null) ? Math.min(...hits as number[]) : null;
  return result;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: any): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value) ?? 'undefined';
}
export interface TreeReadEvidence {
  client: AnyLuaClient;
  build: PoBBuild;
  xml: string;
  info: any;
  stats: Record<string, any>;
}

/** No file loading, native mutation, or rollback writes. A state mismatch fails
 * the result instead of silently replacing the user's unsaved state. */
export async function withPoe2TreeRead<T>(context: TreeReadContext, name: string | undefined,
  work: (evidence: TreeReadEvidence) => Promise<T>,extraFields:string[]=[]): Promise<T & { verification: { unchanged: true; xmlSha256: string; statsSha256: string } }> {
  if (name !== undefined && !context.buildService) throw new Error('Named tree reads require the configured BuildService for file identity');
  const service = context.buildService ?? new BuildService('/');
  await context.ensureLuaClient?.();
  const client = context.getLuaClient?.();
  if (!client) throw new Error('A current native PoB2 connection is required');
  const info = await client.getBuildInfo();
  if (name !== undefined && !nativeBuildMatches(name,info,service)) throw new Error('Requested build identity differs from the current native build; no build was loaded');
  const xml = await client.exportBuildXml();
  const build = service.parseBuildContent(xml);
  if (build.__xmlRoot!=='PathOfBuilding2' || info?.game==='poe1') throw new Error('Tree evaluation requires a native PathOfBuilding2 build');
  const fields=[...new Set([...TREE_STAT_FIELDS,...extraFields])];
  const stats = await client.getStats(fields);
  let result: T;
  try { result = await work({client,build,xml,info,stats}); }
  finally {
    const afterXml = await client.exportBuildXml();
    const afterStats = await client.getStats(fields);
    const afterInfo = await client.getBuildInfo();
    // Compare the complete native identity, including fileName/isSaved, even
    // when title, XML and calculated stats happen to match another saved file.
    if (xml!==afterXml || canonical(stats)!==canonical(afterStats) || canonical(info)!==canonical(afterInfo)) {
      throw new Error('Native build state changed during evaluation; preservation failed. No reload or rollback write was attempted.');
    }
  }
  return {...result!, verification:{unchanged:true,xmlSha256:hash(xml),statsSha256:hash(canonical(stats))}};
}

type Node = PassiveTreeNode & Record<string, any>;
interface State {
  evidence: TreeReadEvidence; graph: Map<string, Node>; version: string; specIndex: number;
  allocated: Set<number>; modes: Record<string, number>; attributes: Record<string,'str'|'dex'|'int'>;
  roots: Set<number>; ascendancies: Set<string>; source: { path: string | null; sha256: string | null; treeVersion: string };
}
export interface TreeProposal {
  targetNode: number; name: string; addNodes: number[]; removeNodes: number[];
  weaponSets: Record<string, number>; attributeOverrides: Record<string,'str'|'dex'|'int'>;
  pointCost: number; refundedPoints: number; budget: ReturnType<typeof poe2PassiveBudget>;
  measurements: Record<string,{before:MeasuredStats;after:MeasuredStats;deltas:MeasuredStats}>;
  applied: false;
}
const ids = (value:unknown):number[] => typeof value==='string' && value.trim() ? value.split(',').map(Number) : [];
const isStart = (node: Node) => node.classesStart!=null || node.isAscendancyStart || ['ClassStart','AscendClassStart'].includes(node.type);
// Stock tree data contains decorative mastery images with graph connections.
// PassiveTree.lua gives these type OnlyImage; they cannot carry allocations.
const isOnlyImage = (node: Node) => node.isOnlyImage || node.type==='OnlyImage';
const nodeMode = (modes:Record<string,number>,id:number) => modes[String(id)] ?? 0;
const compatible = (requested:number,actual:number) => actual===0 || requested>0 && requested===actual;
const integer = (value:unknown,name:string,min:number,max:number) => {
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
};

async function readState(context:TreeReadContext,evidence:TreeReadEvidence):Promise<State> {
  const specs = evidence.build.Tree?.Spec;
  const list = Array.isArray(specs)?specs:specs?[specs]:[];
  const specIndex = Number(evidence.build.Tree?.activeSpec ?? (list.length===1?1:NaN))-1;
  const spec:any = list[specIndex];
  if(!spec)throw new Error('Selected passive spec is unknown; no other spec is substituted');
  const tree = await evidence.client.getTree();
  const version = spec.treeVersion;
  if(typeof version!=='string'||!version.startsWith('0_')||tree.treeVersion!==version)throw new Error('Native tree version and selected XML do not match');
  const service=context.treeService??new TreeService(context.buildService??new BuildService('/'));
  const graph=(await service.getTreeData(version)).nodes as Map<string,Node>;
  const allocated=new Set<number>((tree.nodes??[]).map((node:any)=>Number(node?.id??node)));
  if([...allocated].some(id=>!Number.isSafeInteger(id)||!graph.has(String(id))))throw new Error('Allocated native IDs are missing from the selected source graph; do not substitute another tree');
  if(canonical([...allocated].sort((a,b)=>a-b))!==canonical(ids(spec.nodes).sort((a,b)=>a-b)))throw new Error('Native allocation and selected XML differ');
  const modes:Record<string,number>={};
  for(const mode of [1,2])for(const id of ids(spec['WeaponSet'+mode]?.nodes)) {
    if(!allocated.has(id)||modes[id])throw new Error('Invalid or overlapping native weapon-set assignments');
    modes[id]=mode;
  }
  for(const [id,mode]of Object.entries(tree.weaponSets??{}))if(mode!==nodeMode(modes,Number(id)))throw new Error('Native weapon sets and selected XML differ');
  const attributes:State['attributes']={};
  const override=spec.Overrides?.AttributeOverride;
  for(const attr of ['str','dex','int'] as const)for(const id of ids(override?.[attr+'Nodes'])) {
    if(attributes[id])throw new Error('Overlapping selected attribute choices');
    attributes[id]=attr;
  }
  const roots=new Set<number>(),ascendancies=new Set<string>();
  for(const id of allocated) {
    const node=graph.get(String(id))!;
    if(node.isAscendancyStart||node.type==='AscendClassStart'){roots.add(id);if(node.ascendancyName)ascendancies.add(node.ascendancyName);}
    if(node.classesStart && Object.values(node.classesStart).includes(evidence.info.className??evidence.build.Build?.className))roots.add(id);
    if(node.isFreeAllocate!=null)roots.add(id);
  }
  if(!roots.size)throw new Error('No selected native class/ascendancy root is established');
  let path:string|null=null,sha256:string|null=null;
  try {path=join(dirname(resolvePobDataLocation().dataDir),'TreeData',version,'tree.lua');sha256=hash(readFileSync(path,'utf8'));}catch {path=null;}
  return {evidence,graph,version,specIndex,allocated,modes,attributes,roots,ascendancies,source:{path,sha256,treeVersion:version}};
}

function groupCompatible(a:Node,b:Node):boolean {return (a.ascendancyName??'')===(b.ascendancyName??'');}
function unlocked(node:Node,allocated:Set<number>):boolean {
  if(!node.unlockConstraint)return true;
  const required=node.unlockConstraint.nodes;
  if(!required)return false;
  return Object.values(required).every(id=>allocated.has(Number(id)));
}
function walkReachable(state:State,allocated:Set<number>,modes:Record<string,number>,mode:number):Set<number> {
  const seen=new Set([...state.roots].filter(id=>allocated.has(id)&&compatible(mode,nodeMode(modes,id))));
  const queue=[...seen];
  for(let pos=0;pos<queue.length;pos++) {
    const node=state.graph.get(String(queue[pos]))!;
    if(node.isMastery||node.type==='Mastery')continue;
    for(const key of node.out??[]) {
      const id=Number(key),other=state.graph.get(String(id));
      if(!other||seen.has(id)||!allocated.has(id)||!compatible(mode,nodeMode(modes,id))||!groupCompatible(node,other)||!unlocked(other,allocated))continue;
      seen.add(id);queue.push(id);
    }
  }
  return seen;
}
function connectivity(state:State,allocated:Set<number>,modes:Record<string,number>):string|undefined {
  for(const mode of [0,1,2]) {
    const reachable=walkReachable(state,allocated,modes,mode);
    for(const id of allocated)if(nodeMode(modes,id)===mode&&!reachable.has(id))return `Node ${id} is disconnected in allocation mode ${mode}`;
  }
}
function pathTo(state:State,allocated:Set<number>,modes:Record<string,number>,target:number,mode:number,maxDistance:number):number[]|undefined {
  const wanted=state.graph.get(String(target));
  if(!wanted||allocated.has(target)||isStart(wanted)||isOnlyImage(wanted)||wanted.isMastery||wanted.isFreeAllocate!=null||wanted.isMultipleChoiceOption)return;
  if(wanted.ascendancyName&&!state.ascendancies.has(wanted.ascendancyName))return;
  if(wanted.ascendancyName&&mode!==0)return;
  const queue=[...allocated].filter(id=>compatible(mode,nodeMode(modes,id))&&groupCompatible(state.graph.get(String(id))!,wanted)).map(id=>({id,path:[] as number[]}));
  const seen=new Set(queue.map(row=>row.id));
  for(let pos=0;pos<queue.length;pos++) {
    const row=queue[pos],node=state.graph.get(String(row.id))!;
    if(row.path.length>=maxDistance||node.isMastery||node.type==='Mastery')continue;
    for(const key of node.out??[]) {
      const id=Number(key),other=state.graph.get(String(id));
      if(!other||seen.has(id)||allocated.has(id)||isStart(other)||isOnlyImage(other)||other.isMastery||other.isMultipleChoiceOption||!groupCompatible(node,other))continue;
      if(!unlocked(other,new Set([...allocated,...row.path])))continue;
      const path=[...row.path,id];
      if(id===target)return path;
      seen.add(id);queue.push({id,path});
    }
  }
}
function budgetFor(state:State,allocated:Set<number>,modes:Record<string,number>,stats:any) {
  const build=structuredClone(state.evidence.build);
  const specs=Array.isArray(build.Tree!.Spec)?build.Tree!.Spec:[build.Tree!.Spec!];
  const spec=specs[state.specIndex] as any;
  spec.nodes=[...allocated].join(',');
  for(const mode of [1,2])spec['WeaponSet'+mode]={nodes:[...allocated].filter(id=>nodeMode(modes,id)===mode).join(',')};
  return poe2PassiveBudget(build,[...allocated].map(id=>state.graph.get(String(id))!),stats);
}
function budgetFailure(budget:ReturnType<typeof poe2PassiveBudget>):string|undefined {
  if(budget.availablePoints===null||budget.weaponSetLimit===null)return 'Point budget is unknown for this source/level';
  if(budget.warnings.length)return budget.warnings.join(' ');
}

function axesFor(goal:string,base:MeasuredStats):string[] {
  const damage=base.FullDPS!==null&&base.FullDPS>0?'FullDPS':'CombinedDPS';
  const aliases:Record<string,string[]>={damage:[damage],dps:[damage],maximize_dps:[damage],life:['Life'],maximize_life:['Life'],
    es:['EnergyShield'],maximize_es:['EnergyShield'],mana:['Mana'],defense:['MinimumMaximumHitTaken'],defence:['MinimumMaximumHitTaken'],
    balanced:[damage,'MinimumMaximumHitTaken'],both:[damage,'MinimumMaximumHitTaken'],resist:['FireResist','ColdResist','LightningResist','ChaosResist'],
    speed:['MovementSpeedMod'],maximize_ehp:['TotalEHP']};
  const selected=aliases[goal.toLowerCase()];
  if(selected)return selected;
  if(Object.hasOwn(base,goal))return [goal];
  throw new Error(`Unknown objective '${goal}'; use damage, defense, life, es, mana, balanced, or an exact native stat key`);
}
function checkStats(stats:MeasuredStats,constraints:OptimizationConstraints):string|undefined {
  const keys:Record<string,string>={minLife:'Life',minES:'EnergyShield',minEHP:'TotalEHP',minFireResist:'FireResist',minColdResist:'ColdResist',minLightningResist:'LightningResist',minChaosResist:'ChaosResist'};
  for(const [constraint,key]of Object.entries(keys)) {
    const minimum=(constraints as any)[constraint];
    if(minimum!==undefined&&(stats[key]===null||stats[key]<minimum))return `${constraint} not met: ${stats[key]??'unknown'} < ${minimum}`;
  }
  for(const attr of ['Str','Dex','Int']) {
    const have=stats[attr],required=stats['Req'+attr];
    if(have===null||required===null)return `${attr} requirement verification is unknown`;
    if(have<required)return `${attr} requirement not met: ${have} < ${required}`;
  }
}
function trialAttributes(state:State,adds:number[],choices:Poe2TreeOptions['attribute_choices']):Array<Record<string,'str'|'dex'|'int'>> {
  const specified:Record<string,'str'|'dex'|'int'>={};
  const missing:number[]=[];
  for(const id of adds)if(state.graph.get(String(id))!.isAttribute) {
    const value=choices?.[id]??state.attributes[id];
    if(value)specified[id]=value;else missing.push(id);
  }
  // Three uniform choices keep trials bounded. Explicit per-node choices allow
  // mixed paths; this does not claim an exhaustive search of 3^N assignments.
  return missing.length?(['str','dex','int'] as const).map(attr=>({...specified,...Object.fromEntries(missing.map(id=>[id,attr]))})): [specified];
}
async function calculate(state:State,proposal:Pick<TreeProposal,'addNodes'|'removeNodes'|'weaponSets'|'attributeOverrides'>,weaponSet:1|2):Promise<MeasuredStats> {
  const request={addNodes:proposal.addNodes,removeNodes:proposal.removeNodes,weaponSets:proposal.weaponSets,
    attributeOverrides:proposal.attributeOverrides,weaponSet,useFullDPS:true,
    expectedBuildName:state.evidence.info.name,expectedXml:state.evidence.xml};
  const output=await state.evidence.client.calcWith(request);
  // Old APIs silently ignore unknown request keys. Do not claim both weapon sets
  // or attribute trials were measured without a native scenario acknowledgement.
  if(output?.calculationContext?.weaponSet!==weaponSet)throw new Error('Native calc_with did not confirm the requested weapon set; extended tree calculation support is required');
  if(output.calculationContext.treeVersion!==state.version)throw new Error('Native trial tree version differs from the source graph');
  return measuredTreeStats(output);
}
function dominates(a:TreeProposal,b:TreeProposal,axes:string[]):boolean {
  let better=false;
  for(const set of ['1','2'])for(const axis of axes) {
    const x=a.measurements[set].after[axis],y=b.measurements[set].after[axis];
    const delta=measuredDelta(y,x);
    if(delta===null||delta<0)return false;
    if(delta>0)better=true;
  }
  return better;
}

export async function planPoe2Tree(context:TreeReadContext,name:string|undefined,goal:string,points:number|undefined,
  optimize=false,iterations=1,constraints:OptimizationConstraints={},options:Poe2TreeOptions={}) {
  if(typeof goal!=='string'||!goal.trim())throw new Error('A nonempty objective is required');
  if(points!==undefined)integer(points,'point limit',0,30);
  integer(iterations,'max_iterations',1,5);
  const maxCandidates=integer(options.max_candidates??12,'max_candidates',1,40);
  const maxDistance=integer(options.max_distance??3,'max_distance',1,10);
  const search={maxCandidatesPerIteration:maxCandidates,maxIterations:optimize?iterations:1,maxDistance,
    automaticRefundLeafLimit:optimize&&options.remove_node_ids===undefined?4:0,
    retainedRefundAlternatives:optimize&&options.remove_node_ids===undefined?2:0,
    candidateLimitReached:false,iterationLimitReached:false,truncated:false,cutoffs:[] as SearchCutoff[]};
  if(options.allocation_mode!==undefined&&!['shared','weapon1','weapon2'].includes(options.allocation_mode))throw new Error('Invalid allocation_mode');
  const mode=options.allocation_mode==='weapon1'?1:options.allocation_mode==='weapon2'?2:0;
  for(const key of ['candidate_node_ids','remove_node_ids'] as const)if(options[key]!==undefined) {
    if(!Array.isArray(options[key]))throw new Error(`${key} must be an array`);
    options[key]!.forEach(id=>integer(id,key,1,Number.MAX_SAFE_INTEGER));
    if(new Set(options[key]).size!==options[key]!.length)throw new Error(`Duplicate ${key}`);
  }
  const constraintKeys=['minLife','minES','minEHP','minFireResist','minColdResist','minLightningResist','minChaosResist','protectedNodes'];
  for(const [key,value]of Object.entries(constraints)) {
    if(!constraintKeys.includes(key))throw new Error(`Unknown constraint ${key}`);
    if(key!=='protectedNodes'&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error(`Invalid numeric constraint ${key}`);
  }
  if(constraints.protectedNodes!==undefined&&(!Array.isArray(constraints.protectedNodes)||constraints.protectedNodes.some(id=>!/^\d+$/.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<1)))throw new Error('protectedNodes must contain node IDs');
  constraints={...constraints,protectedNodes:constraints.protectedNodes?.map(String)};
  for(const [key,value]of Object.entries(options.attribute_choices??{}))if(!/^\d+$/.test(key)||!['str','dex','int'].includes(value))throw new Error('Invalid attribute_choices');
  return withPoe2TreeRead(context,name,async evidence=>{
    const state=await readState(context,evidence);
    for(const id of Object.keys(options.attribute_choices??{}))if(!state.graph.get(id)?.isAttribute)throw new Error(`Attribute choice ${id} is not an attribute node in the current source tree`);
    const initialBudget=budgetFor(state,state.allocated,state.modes,evidence.stats);
    const baseline:Record<string,MeasuredStats>={};
    const rejected:Array<{nodeId?:number;reason:string}>=[];
    const candidates:TreeProposal[]=[];
    const budgetLimit=points??Math.max(0,(initialBudget.availablePoints??0)-Math.max(...initialBudget.perWeaponPoints));
    const initialProblem=connectivity(state,state.allocated,state.modes);
    if(initialProblem)throw new Error('Current allocation/source graph mismatch: '+initialProblem);
    const requestedRemovals=options.remove_node_ids??[];
    const removable=(id:number,allocated:Set<number>)=> {
      const node=state.graph.get(String(id));
      return !!node&&allocated.has(id)&&!isStart(node)&&node.isFreeAllocate==null&&!constraints.protectedNodes?.includes(String(id))&&!options.attribute_choices?.[id]&&
        !(options.preserve_keystones!==false&&node.isKeystone);
    };
    for(const id of requestedRemovals)if(!removable(id,state.allocated))rejected.push({nodeId:id,reason:'Invalid or protected removal'});
    const initialRemaining=new Set([...state.allocated].filter(id=>!requestedRemovals.includes(id)));
    const removalIssue=connectivity(state,initialRemaining,state.modes);
    if(removalIssue)rejected.push({reason:removalIssue});
    const allocatedChoices=Object.fromEntries(Object.entries(options.attribute_choices??{}).filter(([id])=>state.allocated.has(Number(id))));
    const hasAttributeTrial=Object.entries(allocatedChoices).some(([id,choice])=>state.attributes[id]!==choice);
    if(rejected.length||(!optimize&&budgetLimit===0&&!hasAttributeTrial))return {game:'poe2',goal,axes:[],baseline,budget:initialBudget,candidates,rejected,proposal:null,iterations:0,source:state.source,search};
    for(const set of [1,2] as const)baseline[set]=await calculate(state,{addNodes:[],removeNodes:[],weaponSets:{},attributeOverrides:{}},set);
    const baselineKeys=[...new Set([...Object.keys(baseline['1']),...Object.keys(baseline['2'])])];
    for(const stats of Object.values(baseline))for(const key of baselineKeys)if(!Object.hasOwn(stats,key))stats[key]=null;
    const axes=axesFor(goal,baseline['1']);
    const objectiveSets=mode?[String(mode)]:['1','2'];
    const rawTargets=options.candidate_node_ids??[...state.graph.values()].filter(node=>(!state.allocated.has(node.skill)||allocatedChoices[node.skill])&&!isStart(node)&&!isOnlyImage(node))
      .sort((a,b)=>Number(!!b.isNotable)-Number(!!a.isNotable)||a.skill-b.skill).map(node=>node.skill);
    const rank=(proposals:TreeProposal[])=> {
      const frontier=axes.length>1?proposals.filter(candidate=>!proposals.some(other=>other!==candidate&&dominates(other,candidate,axes))):proposals;
      return frontier.sort((a,b)=> {
        const gain=(proposal:TreeProposal)=>Math.min(...objectiveSets.map(set=>proposal.measurements[set].deltas[axes[0]]!));
        return gain(b)-gain(a)||a.pointCost-b.pointCost||a.targetNode-b.targetNode;
      });
    };
    let evaluated=0,refundTrials=0,completedIterations=0;
    let best:TreeProposal|null=null;
    let sorted:TreeProposal[]=[];
    for(let iteration=0;iteration<(optimize?iterations:1);iteration++) {
      const workingAdds=best?.addNodes??[],workingRemoves=best?.removeNodes??requestedRemovals;
      const workingModes={...state.modes,...(best?.weaponSets??{})};
      const working=new Set([...state.allocated,...workingAdds].filter(id=>!workingRemoves.includes(id)));
      const removalVariants=[workingRemoves];
      // Search legal leaf refunds, then keep two measured low-loss alternatives.
      // Ascendancy and ordinary points are never exchanged by this refund search.
      if(optimize&&options.remove_node_ids===undefined) {
        const refunds:Array<{ids:number[];value:number}>=[];
        const leaves=[...working].filter(id=>state.allocated.has(id)&&removable(id,working)&&
          !state.graph.get(String(id))!.ascendancyName&&nodeMode(workingModes,id)===mode&&
          !connectivity(state,new Set([...working].filter(nodeId=>nodeId!==id)),workingModes)).sort((a,b)=>a-b).slice(0,4);
        for(const id of leaves) {
          const removals=[...workingRemoves,id];
          try {
            const values:number[]=[];
            for(const set of [1,2] as const) {
              const after=await calculate(state,{addNodes:workingAdds,removeNodes:removals,weaponSets:best?.weaponSets??{},attributeOverrides:best?.attributeOverrides??{}},set);
              if(objectiveSets.includes(String(set))) {
                if(after[axes[0]]===null)throw new Error('Refund objective measurement unavailable');
                values.push(after[axes[0]]!);
              }
            }
            refundTrials++;refunds.push({ids:removals,value:Math.min(...values)});
          }catch(error){rejected.push({nodeId:id,reason:'Refund trial: '+(error instanceof Error?error.message:String(error))});}
        }
        refunds.sort((a,b)=>b.value-a.value);
        removalVariants.push(...refunds.slice(0,2).map(refund=>refund.ids));
      }
      const round:TreeProposal[]=[];
      let roundEvaluated=0;
      let cutoffRecorded=false;
      const recordCutoff=(targetIndex:number,untestedAttributeVariants:number,targetNode:number|null,removalIndex:number)=>{
        search.candidateLimitReached=true;
        const unvisitedTargetIds=rawTargets.slice(targetIndex).filter(id=>!workingAdds.includes(id));
        const unvisitedRemovalVariants=removalVariants.length-removalIndex-1;
        if(!cutoffRecorded&&(unvisitedTargetIds.length||untestedAttributeVariants||unvisitedRemovalVariants)) {
          search.cutoffs.push({iteration:iteration+1,evaluatedTrials:roundEvaluated,targetNode,
            unvisitedTargetIds,untestedAttributeVariants,unvisitedRemovalVariants});
          search.truncated=true;cutoffRecorded=true;
        }
      };
      for(let removalIndex=0;removalIndex<removalVariants.length;removalIndex++) {
        const removals=removalVariants[removalIndex];
        const remaining=new Set([...state.allocated,...workingAdds].filter(id=>!removals.includes(id)));
        for(let targetIndex=0;targetIndex<rawTargets.length;targetIndex++) {
          const target=rawTargets[targetIndex];
          if(roundEvaluated>=maxCandidates){recordCutoff(targetIndex,0,null,removalIndex);break;}
          if(workingAdds.includes(target))continue;
          const node=state.graph.get(String(target));
          const attributeOnly=remaining.has(target)&&node?.isAttribute&&allocatedChoices[target]&&allocatedChoices[target]!==state.attributes[target];
          const path=attributeOnly?[]:pathTo(state,remaining,workingModes,target,mode,maxDistance);
          if(!path){if(options.candidate_node_ids)rejected.push({nodeId:target,reason:'Invalid, disconnected, already allocated or unselected ascendancy target'});continue;}
          // Do not spend simulations on refunding and immediately re-adding the same node.
          if(path.some(id=>removals.includes(id)))continue;
          const adds=[...workingAdds,...path];
          const pointCost=adds.filter(id=>costsPassivePoint(state.graph.get(String(id))!)).length;
          const refundedPoints=removals.filter(id=>costsPassivePoint(state.graph.get(String(id))!)).length;
          if(pointCost>(optimize?budgetLimit+refundedPoints:budgetLimit)){if(options.candidate_node_ids)rejected.push({nodeId:target,reason:`Path costs ${pointCost} points, beyond the limit`});continue;}
          const modes={...workingModes,...Object.fromEntries(path.map(id=>[id,node!.ascendancyName?0:mode]))};
          const allocated=new Set([...remaining,...path]);
          const budget=budgetFor(state,allocated,modes,evidence.stats);
          const invalid=connectivity(state,allocated,modes)??budgetFailure(budget);
          if(invalid){rejected.push({nodeId:target,reason:invalid});continue;}
          const attributeVariants=trialAttributes(state,path,options.attribute_choices);
          for(let attributeIndex=0;attributeIndex<attributeVariants.length;attributeIndex++) {
            if(roundEvaluated>=maxCandidates){recordCutoff(targetIndex+1,attributeVariants.length-attributeIndex,target,removalIndex);break;}
            const choices=attributeVariants[attributeIndex];
            roundEvaluated++;evaluated++;
            const attributeOverrides={...allocatedChoices,...(best?.attributeOverrides??{}),...choices};
            const proposal:TreeProposal={targetNode:target,name:node!.name??String(target),addNodes:adds,removeNodes:removals,
              weaponSets:Object.fromEntries(adds.map(id=>[id,modes[id]])),attributeOverrides,pointCost,refundedPoints,budget,measurements:{},applied:false};
            let reason:string|undefined;
            try {
              for(const set of [1,2] as const) {
                const after=await calculate(state,proposal,set);
                for(const key of baselineKeys)if(!Object.hasOwn(after,key))after[key]=null;
                reason=checkStats(after,constraints)??budgetFailure(budgetFor(state,allocated,modes,{...evidence.stats,...after}));
                if(reason)break;
                const before=baseline[set];
                proposal.measurements[set]={before,after,deltas:Object.fromEntries(Object.keys(before).map(key=>[key,measuredDelta(before[key],after[key])]))};
                if(objectiveSets.includes(String(set))&&axes.some(axis=>before[axis]===null||after[axis]===null)){reason='Objective measurement unavailable; no substitute stat used';break;}
              }
            }catch(error){reason=error instanceof Error?error.message:String(error);}
            if(reason){rejected.push({nodeId:target,reason});continue;}
            round.push(proposal);
          }
        }
        if(roundEvaluated>=maxCandidates){recordCutoff(rawTargets.length,0,null,removalIndex);break;}
      }
      if(!optimize){sorted=rank(round);completedIterations=1;break;}
      const previous:TreeProposal['measurements']|undefined=best?.measurements;
      const gain=(candidate:TreeProposal,set:string,axis:string)=>measuredDelta(previous?.[set].after[axis]??baseline[set][axis],candidate.measurements[set].after[axis]);
      const improves=(candidate:TreeProposal):boolean=>objectiveSets.every(set=>axes.every(axis=>gain(candidate,set,axis)!>=0))&&
        objectiveSets.some(set=>axes.some(axis=>gain(candidate,set,axis)!>0));
      const ranked=rank(round);
      const improvement:TreeProposal|undefined=ranked.find(improves);
      if(!improvement){if(!best)sorted=ranked;break;}
      best=improvement;sorted=ranked;completedIterations++;
    }
    search.iterationLimitReached=optimize&&completedIterations===iterations;
    return {game:'poe2',goal,axes,baseline,budget:initialBudget,candidates:sorted,rejected,proposal:optimize?best:null,
      iterations:completedIterations,evaluated,refundTrials,source:state.source,search,
      coverage:'Bounded alternatives, not a global optimum. Both weapon sets must meet explicit constraints and native attribute requirements.',
      notes:[...initialBudget.notes,'Results are alternatives, not a list to allocate together. Attribute search uses three uniform choices or explicit per-node choices.',
        'Choices for unallocated attributes are used only when the node enters a proposal. All applied choices are listed in attributeOverrides.',
        mode?'The requested weapon set determines objective ordering; both sets must satisfy constraints.':'Shared proposals are ordered by their worst per-weapon objective delta; no viability threshold is inferred.']};
  },[goal]);
}

export function formatPoe2TreePlan(result:Awaited<ReturnType<typeof planPoe2Tree>>,limit=10):string {
  const axes:string[]=result.axes;
  const lines=['=== PoE2 measured tree proposals ===',`Goal: ${result.goal}; axes: ${result.axes.join(', ')||'unknown'}`,
    result.axes.length>1?'Pareto alternatives across separate objectives; no fixed DPS/defense weights.':'Ranking uses the measured objective; no viability score.',
    `Current points per weapon: ${result.budget.perWeaponPoints.join(' / ')}; budget: ${result.budget.availablePoints??'unknown'}; weapon-specific limit: ${result.budget.weaponSetLimit??'unknown'}`,
    `Ascendancy points (separate pool): ${result.budget.ascendancyPoints}`,`Source tree: ${result.source.treeVersion}; ${result.source.path??'source path unavailable'}; sha256=${result.source.sha256??'unknown'}`,
    `Showing ${Math.min(limit,result.candidates.length)} of ${result.candidates.length} alternatives; completed iterations: ${result.iterations}.`,
    `Search scope: up to ${result.search.maxCandidatesPerIteration} candidate/attribute scenarios per iteration, ${result.search.maxIterations} iteration(s), ${result.search.maxDistance} graph hops. Automatic refund search examines up to ${result.search.automaticRefundLeafLimit} leaves and retains ${result.search.retainedRefundAlternatives} alternatives per iteration.`,
    'Timing reference: parent-reported 24 native calls in 33.6s (median 1.36s; peak 659 MiB). Allow 120s overall MCP timeout for defaults; consider 900s for 40 candidates × 5 iterations. Build-dependent extrapolation; no wall-clock cutoff is applied.',
    ...(result.notes??[]),''];
  if(result.search.truncated)lines.push('Partial search: max_candidates stopped evaluation. Unassessed alternatives are not rejected or assigned zero value.');
  for(const cutoff of result.search.cutoffs) {
    lines.push(`Iteration ${cutoff.iteration}: ${cutoff.unvisitedTargetIds.length} target(s) not visited in the current branch; ${cutoff.untestedAttributeVariants} attribute variant(s) untested${cutoff.targetNode===null?'':` for target ${cutoff.targetNode}`}; ${cutoff.unvisitedRemovalVariants} removal alternative(s) not explored.`);
    if(cutoff.unvisitedTargetIds.length)lines.push(`Unvisited target IDs: ${cutoff.unvisitedTargetIds.slice(0,12).join(', ')}${cutoff.unvisitedTargetIds.length>12?' … (complete list in structured search.cutoffs)':''}`);
  }
  if(result.search.iterationLimitReached)lines.push('Configured iteration limit reached; no further iteration was attempted.');
  for(const proposal of result.candidates.slice(0,limit)) {
    lines.push(`${proposal.name} [${proposal.targetNode}]: add ${proposal.addNodes.join(', ')}; refund ${proposal.removeNodes.join(', ')||'none'}; paid path cost ${proposal.pointCost}; refunded ${proposal.refundedPoints}`,
      `Allocation modes: ${JSON.stringify(proposal.weaponSets)}; attribute choices: ${JSON.stringify(proposal.attributeOverrides)}`);
    for(const set of ['1','2']) {
      lines.push(`Weapon set ${set}: ${result.axes.map(axis=>`${axis} ${proposal.measurements[set].before[axis]??'unknown'} → ${proposal.measurements[set].after[axis]??'unknown'} (Δ ${proposal.measurements[set].deltas[axis]??'unknown'})`).join('; ')}`);
      const changed=['Life','EnergyShield','Mana','Str','Dex','Int','FireResist','ColdResist','LightningResist','ChaosResist','MinimumMaximumHitTaken']
        .filter(key=>!axes.includes(key)&&proposal.measurements[set].deltas[key]!==null&&proposal.measurements[set].deltas[key]!==0);
      if(changed.length)lines.push(`  Other measured changes: ${changed.map(key=>`${key} Δ ${proposal.measurements[set].deltas[key]}`).join('; ')}`);
    }
  }
  if(!result.candidates.length)lines.push('No valid measured proposal within this search and point budget.');
  if(result.rejected.length>12)lines.push(`Showing 12 of ${result.rejected.length} rejections; complete reasons remain in structured rejected data.`);
  for(const rejected of result.rejected.slice(0,12))lines.push(`Rejected ${rejected.nodeId??'proposal'}: ${rejected.reason}`);
  lines.push('No allocations were applied.',`Verified unchanged XML and native stats: ${result.verification.xmlSha256}`);
  return lines.join('\n');
}
