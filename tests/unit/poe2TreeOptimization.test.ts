import { handleSuggestOptimalNodes, handleOptimizeTree } from '../../src/handlers/optimizationHandlers.js';
import { handleGetPassiveUpgrades } from '../../src/handlers/treeHandlers.js';
import { handleComputeStatWeights } from '../../src/handlers/statWeightsHandler.js';
import { handleFindBestAnointment } from '../../src/handlers/anointHandlers.js';
import { BuildService } from '../../src/services/buildService.js';
import { withPoe2TreeRead } from '../../src/services/poe2TreeOptimization.js';

const xml = `<PathOfBuilding2><Build level="10" className="Witch" ascendClassName="Blood Mage"/>
  <Tree activeSpec="1"><Spec treeVersion="0_5" classId="1" ascendClassId="2" nodes="100,101,102,110,120,900,901">
  <WeaponSet1 nodes="110"/><WeaponSet2 nodes="120"/><Overrides><AttributeOverride strNodes="101" dexNodes="" intNodes=""/></Overrides>
  </Spec></Tree><Items activeItemSet="1"><ItemSet id="1" useSecondWeaponSet="false"/></Items></PathOfBuilding2>`;
const base = { CombinedDPS: 1000, FullDPS: 1100, TotalEHP: 5000, Life: 1000, EnergyShield: 200, Mana: 300,
  Str: 20, Dex: 20, Int: 20, ReqStr: 10, ReqDex: 10, ReqInt: 10, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 20,
  MissingFireResist: 0, MissingColdResist: 0, MissingLightningResist: 0, MissingChaosResist: 55,
  PhysicalMaximumHitTaken: 2000, FireMaximumHitTaken: 3000, ColdMaximumHitTaken: 3000, LightningMaximumHitTaken: 3000, ChaosMaximumHitTaken: 1800,
  ExtraPoints: 0, PassivePointsToWeaponSetPoints: 0 };
const node = (id: number, out: number[], extra: Record<string, any> = {}) => ({ skill: id, name: 'Node ' + id,
  stats: [], out: out.map(String), in: [], ...extra });

function fixture() {
  const nodes = [
    node(100, [101,110,120,200,300], { classesStart: { 1: 'Witch' } }),
    node(101, [100,102], { isAttribute: true, options: { 1: { name: 'Strength', stats: {1:'+5 to Strength'} }, 2: {name:'Dexterity',stats:{1:'+5 to Dexterity'}}, 3:{name:'Intelligence',stats:{1:'+5 to Intelligence'}} } }),
    node(102, [101], { name: 'Current leaf' }), node(110, [100,210]), node(120, [100,220]),
    node(200, [100,201]), node(201, [200], { name: 'Measured notable', isNotable: true, stats: ['20% increased Spell Damage'] }),
    node(210, [110], { isNotable: true }), node(220, [120], { isNotable: true }),
    node(300, [100], { isAttribute: true, options: {1:{name:'Strength',stats:{1:'+5 to Strength'}},2:{name:'Dexterity',stats:{1:'+5 to Dexterity'}},3:{name:'Intelligence',stats:{1:'+5 to Intelligence'}}} }),
    node(400, [401], { isNotable: true }), node(401, [400]),
    node(900, [901], { ascendancyName: 'Blood Mage', isAscendancyStart: true }),
    node(901, [900,902], { ascendancyName: 'Blood Mage' }), node(902, [901], { ascendancyName: 'Blood Mage', isNotable: true }),
    node(950, [951], { ascendancyName: 'Lich', isAscendancyStart: true }), node(951, [950], { ascendancyName: 'Lich', isNotable: true }),
  ];
  const client = {
    getBuildInfo: jest.fn(async () => ({ name: 'Unsaved', game: 'poe2', treeVersion:'0_5', className:'Witch', ascendClassName:'Blood Mage', level:10 })),
    exportBuildXml: jest.fn(async () => xml),
    getStats: jest.fn(async () => ({ ...base })),
    getTree: jest.fn(async () => ({ treeVersion:'0_5', classId:1, ascendClassId:2, nodes:[100,101,102,110,120,900,901], weaponSets:{110:1,120:2} })),
    getNodeState: jest.fn(async ({node_id}:any) => ({id:Number(node_id),sd:['+5 to Strength'],type:'Normal'})),
    calcWith: jest.fn(async (params:any) => {
      const adds = params.addNodes ?? [], removes = params.removeNodes ?? [];
      return { ...base, CombinedDPS:1000 + (adds.includes(201)?100:0) + (adds.includes(200)?10:0) - (removes.includes(102)?5:0),
        FullDPS:1100 + (adds.includes(201)?110:0) + (adds.includes(200)?11:0) - (removes.includes(102)?5:0),
        Life:1000+(adds.includes(201)?20:0),
        calculationContext: { weaponSet: params.weaponSet ?? 1, treeVersion:'0_5' } };
    }),
    searchNodes: jest.fn(async () => ({ nodes: [{id:201,name:'Measured notable',stats:['20% increased Spell Damage']},{id:400,name:'Disconnected'}] })),
    loadBuildXml: jest.fn(async () => { throw new Error('Loading is forbidden'); }),
    updateTreeDelta: jest.fn(async () => { throw new Error('Persisting is forbidden'); }),
    getNodePower: jest.fn(async () => ({has_data:true,recalc_pending:false,nodes:[],power_max:{offence:0,defence:0}})),
    probeStatWeights: jest.fn(async ({mods}:any) => ({base:{CombinedDPS:0,TotalEHP:5000,FullDPS:0},slot:'Ring 1',carrier:'Current ring',
      results:mods.map((mod:string)=>({mod,recognized:true,dpsDelta:0,ehpDelta:0,fullDpsDelta:0})),evaluated:mods.length,failed:0})),
    evaluateAnointCandidates: jest.fn(async () => ({base:{CombinedDPS:900,TotalEHP:4500},slot:'Amulet',baseType:'Amber Amulet',focus:'both',evaluated:2,skipped:0,
      candidates:[{nodeId:201,name:'DPS option',dpsDelta:150,ehpDelta:100,score:0.99,recipe:['Greed','Paranoia','Isolation']},
        {nodeId:210,name:'Defense option',dpsDelta:50,ehpDelta:1000,score:0.01,recipe:['Fear','Greed','Disgust']}]})),
  };
  const context:any = { buildService:new BuildService('/unused'), treeService:{getTreeData:jest.fn(async()=>({version:'0_5',nodes:new Map(nodes.map(n=>[String(n.skill),n])),classes:[]}))},
    ensureLuaClient:jest.fn(async()=>{}),getLuaClient:()=>client,pobDirectory:'/unused',luaEnabled:true,stopLuaClient:async()=>{} };
  jest.spyOn(context.buildService,'readBuild').mockRejectedValue(Object.assign(new Error('No file'),{code:'ENOENT'}));
  return {context,client,nodes};
}
const body = (result:any) => result.content.map((part:any)=>part.text).join('\n');
const details = (result:any) => result.structuredContent;
const suggest = (ctx:any, options:any={}, points=3) => (handleSuggestOptimalNodes as any)(ctx,'Unsaved','damage',points,{max_candidates:5,...options});

describe('PoE2 measured tree workflows',()=>{
  const game=process.env.POE_GAME;
  beforeEach(()=>{process.env.POE_GAME='poe2';});
  afterEach(()=>{jest.restoreAllMocks();if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;});

  it('compares complete connector paths and retains unsaved state',async()=>{
    const {context,client}=fixture();
    const result=await suggest(context,{candidate_node_ids:[201]});
    const data=details(result);
    expect(data.candidates[0].addNodes).toEqual([200,201]);
    expect(data.candidates[0].pointCost).toBe(2);
    expect(data.candidates[0].measurements['1'].after.FullDPS).toBe(1221);
    expect(data.candidates[0].measurements['2'].after.FullDPS).toBe(1221);
    expect(data.verification.unchanged).toBe(true);
    expect(client.loadBuildXml).not.toHaveBeenCalled();
    expect(client.updateTreeDelta).not.toHaveBeenCalled();
    expect(context.buildService.readBuild).not.toHaveBeenCalled();
  });

  it('excludes disconnected nodes, foreign ascendancies and invalid IDs before simulation',async()=>{
    const {context,client}=fixture();
    const result=await suggest(context,{candidate_node_ids:[400,951,9999]});
    expect(details(result).candidates).toEqual([]);
    expect(details(result).rejected).toHaveLength(3);
    expect(client.calcWith.mock.calls.every(([p])=>!(p.addNodes?.length))).toBe(true);
  });

  it.each([{isOnlyImage:true},{type:'OnlyImage'}])('excludes decorative image targets and paths through them (%j)',async imageFlags=>{
    const {context,client,nodes}=fixture();
    // Stock PoE2 node 240 (Lightning Mastery) uses isOnlyImage rather than
    // isMastery. The graph includes its links, but it cannot be allocated.
    Object.assign(nodes.find(node=>node.skill===200)!,imageFlags);
    const data=details(await suggest(context,{candidate_node_ids:[200,201]}));
    expect(data.candidates).toEqual([]);
    expect(data.rejected.map((row:any)=>row.nodeId)).toEqual([200,201]);
    expect(client.calcWith.mock.calls.every(([params])=>!params.addNodes?.length)).toBe(true);
  });

  it('does not treat a weapon-specific connection as a shared path',async()=>{
    const {context}=fixture();
    const shared=details(await suggest(context,{candidate_node_ids:[210],allocation_mode:'shared'}));
    expect(shared.candidates).toEqual([]);
    const set1=details(await suggest(context,{candidate_node_ids:[210],allocation_mode:'weapon1'}));
    expect(set1.candidates[0].weaponSets['210']).toBe(1);
    expect(set1.candidates[0].pointCost).toBe(1);
    const set2=details(await suggest(context,{candidate_node_ids:[210],allocation_mode:'weapon2'}));
    expect(set2.candidates).toEqual([]);
  });

  it('honors zero point limits and charges connectors against the limit',async()=>{
    const {context,client}=fixture();
    expect(details(await suggest(context,{candidate_node_ids:[201]},0)).candidates).toEqual([]);
    expect(client.calcWith).not.toHaveBeenCalled();
    expect(details(await suggest(context,{candidate_node_ids:[201]},1)).candidates).toEqual([]);
  });

  it('reports candidates left unassessed by max_candidates instead of silently dropping them',async()=>{
    const {context}=fixture();
    const result=await suggest(context,{candidate_node_ids:[200,201],max_candidates:1});
    expect(details(result).search.truncated).toBe(true);
    expect(details(result).search.cutoffs[0].unvisitedTargetIds).toEqual([201]);
    expect(details(result).rejected.some((entry:any)=>entry.nodeId===201)).toBe(false);
    expect(body(result)).toMatch(/partial search/i);
    expect(body(result)).toContain('201');
  });

  it('reports unevaluated attribute variants at a candidate cutoff',async()=>{
    const {context}=fixture();
    const result=await suggest(context,{candidate_node_ids:[300],max_candidates:1});
    expect(details(result).search.truncated).toBe(true);
    expect(details(result).search.cutoffs[0]).toMatchObject({targetNode:300,untestedAttributeVariants:2});
  });

  it('reports removal branches skipped after the candidate allowance is consumed',async()=>{
    const {context}=fixture();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{}, {candidate_node_ids:[200],max_candidates:1});
    expect(details(result).search.truncated).toBe(true);
    expect(details(result).search.cutoffs[0].unvisitedRemovalVariants).toBe(1);
  });

  it('does not claim truncation when the candidate limit exactly covers the requested alternatives',async()=>{
    const {context}=fixture();
    const result=await suggest(context,{candidate_node_ids:[200],max_candidates:1});
    expect(details(result).search.truncated).toBe(false);
    expect(details(result).search.cutoffs).toEqual([]);
  });

  it('counts selected ascendancy spending separately from ordinary and weapon points',async()=>{
    const {context}=fixture();
    const candidate=details(await suggest(context,{candidate_node_ids:[902]},1)).candidates[0];
    expect(candidate.budget.ascendancyPoints).toBe(2);
    expect(candidate.budget.perWeaponPoints).toEqual([3,3]);
  });

  it('rejects an attribute choice attached to a non-attribute node',async()=>{
    const {context,client}=fixture();
    await expect(suggest(context,{candidate_node_ids:[201],attribute_choices:{201:'int'}})).rejects.toThrow(/attribute/i);
    expect(client.calcWith).not.toHaveBeenCalled();
  });

  it('measures explicit changes to already allocated attribute choices at zero point cost',async()=>{
    const {context,client}=fixture();
    const result=details(await suggest(context,{candidate_node_ids:[101],attribute_choices:{101:'int'}},0));
    expect(result.candidates[0]).toMatchObject({addNodes:[],pointCost:0,attributeOverrides:{101:'int'}});
    expect(client.calcWith.mock.calls.some(([p])=>p.attributeOverrides?.['101']==='int')).toBe(true);
  });

  it('rejects the requested name when a different build is open without loading anything',async()=>{
    const {context,client}=fixture();
    await expect(handleSuggestOptimalNodes(context,'Different','life',2)).rejects.toThrow(/identity|different|requested/i);
    expect(client.calcWith).not.toHaveBeenCalled();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('rejects a same-title native build backed by a different saved file',async()=>{
    const {context,client}=fixture();
    const info={...await client.getBuildInfo(),fileName:'/other/Unsaved.xml',isSaved:true};
    client.getBuildInfo.mockResolvedValue(info);
    await expect(suggest(context,{candidate_node_ids:[201]})).rejects.toThrow(/identity|requested/i);
    expect(client.exportBuildXml).not.toHaveBeenCalled();
    expect(client.getStats).not.toHaveBeenCalled();
    expect(client.calcWith).not.toHaveBeenCalled();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('matches a nested requested file to its Windows native path even when the title is only the basename',async()=>{
    const {context,client}=fixture();
    context.buildService=new BuildService('/mnt/c/PoB2/Builds');
    const read=jest.spyOn(context.buildService,'readBuild');
    const info={...await client.getBuildInfo(),fileName:'C:\\PoB2\\Builds\\nested\\Unsaved.xml',isSaved:true};
    client.getBuildInfo.mockResolvedValue(info);
    const result=await handleSuggestOptimalNodes(context,'nested/Unsaved.xml','damage',0);
    expect(details(result).verification.unchanged).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(client.calcWith).not.toHaveBeenCalled();
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('includes fileName in the final identity check even when title, XML and stats remain equal',async()=>{
    const {context,client}=fixture();
    const info={...await client.getBuildInfo(),fileName:'/unused/Unsaved.xml',isSaved:true};
    client.getBuildInfo.mockResolvedValueOnce(info).mockResolvedValue({...info,fileName:'/other/Unsaved.xml'} as any);
    await expect(withPoe2TreeRead(context,'Unsaved',async()=>({read:true}))).rejects.toThrow(/state changed|preservation/i);
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('requires the configured build service for a named read instead of guessing its file directory',async()=>{
    const {context,client}=fixture();
    delete context.buildService;
    await expect(withPoe2TreeRead(context,'Unsaved',async()=>({read:true}))).rejects.toThrow(/build service|BuildService/i);
    expect(client.getBuildInfo).not.toHaveBeenCalled();
  });

  it('retains parser-only fallback for an unnamed current native read',async()=>{
    const {context}=fixture();
    delete context.buildService;
    const result=await withPoe2TreeRead(context,undefined,async evidence=>({root:evidence.build.__xmlRoot}));
    expect(result.root).toBe('PathOfBuilding2');
    expect(result.verification.unchanged).toBe(true);
  });

  it('passes explicit attribute choices to the native trial without changing current overrides',async()=>{
    const {context,client}=fixture();
    const result=details(await suggest(context,{candidate_node_ids:[300],attribute_choices:{300:'int'}}));
    expect(result.candidates[0].attributeOverrides['300']).toBe('int');
    expect(client.calcWith.mock.calls.some(([p])=>p.attributeOverrides?.['300']==='int')).toBe(true);
    expect(result.verification.unchanged).toBe(true);
  });

  it('guards every native tree calculation with the original build identity and XML',async()=>{
    const {context,client}=fixture();
    await suggest(context,{candidate_node_ids:[201]});
    expect(client.calcWith.mock.calls.length).toBeGreaterThan(0);
    for(const [request]of client.calcWith.mock.calls) {
      expect(request.expectedBuildName).toBe('Unsaved');
      expect(request.expectedXml).toBe(xml);
      expect(Object.keys(request).sort()).toEqual(['addNodes','attributeOverrides','expectedBuildName','expectedXml','removeNodes','useFullDPS','weaponSet','weaponSets']);
    }
  });

  it('rejects trials that break native attribute requirements',async()=>{
    const {context,client}=fixture();
    client.calcWith.mockImplementation(async(p:any)=>({...base,Str:p.addNodes?.length?5:20,calculationContext:{weaponSet:p.weaponSet??1,treeVersion:'0_5'}}));
    const result=details(await suggest(context,{candidate_node_ids:[200]}));
    expect(result.candidates).toEqual([]);
    expect(JSON.stringify(result.rejected)).toMatch(/Str|Strength|requirement/);
  });

  it('enforces explicit numeric constraints instead of merely printing them',async()=>{
    const {context}=fixture();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{minLife:2000},{candidate_node_ids:[201],max_candidates:4});
    expect(details(result).proposal).toBeNull();
    expect(JSON.stringify(details(result).rejected)).toMatch(/minLife|Life/);
  });

  it('rejects removals that disconnect retained nodes before any native trial',async()=>{
    const {context,client}=fixture();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{}, {remove_node_ids:[101],candidate_node_ids:[201]});
    expect(details(result).proposal).toBeNull();
    expect(JSON.stringify(details(result).rejected)).toMatch(/disconnect/i);
    expect(client.calcWith.mock.calls.every(([p])=>!p.removeNodes?.length)).toBe(true);
  });

  it('protects explicitly protected nodes in refund proposals',async()=>{
    const {context}=fixture();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{protectedNodes:['102']},{remove_node_ids:[102],candidate_node_ids:[201]});
    expect(details(result).proposal).toBeNull();
    expect(JSON.stringify(details(result).rejected)).toMatch(/protected/i);
  });

  it('does not silently ignore unknown constraints or numeric protected node IDs',async()=>{
    const {context,client}=fixture();
    await expect((handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{minMana:9999})).rejects.toThrow(/constraint/i);
    expect(client.calcWith).not.toHaveBeenCalled();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{protectedNodes:[102]}, {remove_node_ids:[102],candidate_node_ids:[201]});
    expect(details(result).proposal).toBeNull();
    expect(JSON.stringify(details(result).rejected)).toMatch(/protected/i);
  });

  it('returns an unapplied combined optimization proposal with measured results',async()=>{
    const {context,client}=fixture();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,1,{}, {remove_node_ids:[102],candidate_node_ids:[201],max_candidates:4});
    expect(details(result).proposal).toMatchObject({addNodes:[200,201],removeNodes:[102],applied:false});
    expect(details(result).proposal.measurements['1'].after.FullDPS).toBe(1216);
    expect(client.updateTreeDelta).not.toHaveBeenCalled();
  });

  it('finds a measured refund-and-reallocation when no additional points are allowed',async()=>{
    const {context,client}=fixture();
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',0,1,{}, {candidate_node_ids:[200],max_candidates:8});
    expect(details(result).proposal).toMatchObject({addNodes:[200],removeNodes:[102],pointCost:1,refundedPoints:1,applied:false});
    expect(details(result).proposal.measurements['1'].after.FullDPS).toBe(1106);
    expect(client.updateTreeDelta).not.toHaveBeenCalled();
  });

  it('uses max_iterations to grow one connected, cumulatively measured proposal',async()=>{
    const {context,client,nodes}=fixture();
    nodes.find(node=>node.skill===201)!.out.push('202');
    nodes.push(node(202,[201],{isNotable:true,name:'Next notable'}));
    client.calcWith.mockImplementation(async(p:any)=>({...base,
      CombinedDPS:1000+(p.addNodes?.includes(200)?10:0)+(p.addNodes?.includes(201)?100:0)+(p.addNodes?.includes(202)?20:0),
      FullDPS:1100+(p.addNodes?.includes(200)?11:0)+(p.addNodes?.includes(201)?110:0)+(p.addNodes?.includes(202)?22:0),
      calculationContext:{weaponSet:p.weaponSet??1,treeVersion:'0_5'}}));
    const result=await (handleOptimizeTree as any)(context,'Unsaved','damage',3,3,{},
      {remove_node_ids:[],candidate_node_ids:[200,201,202],max_distance:1,max_candidates:5});
    expect(details(result).proposal.addNodes).toEqual([200,201,202]);
    expect(details(result).proposal.measurements['1'].after.FullDPS).toBe(1243);
    expect(details(result).iterations).toBe(3);
    expect(client.updateTreeDelta).not.toHaveBeenCalled();
  });

  it('optimizes an explicitly requested native recovery stat without a hardcoded goal map',async()=>{
    const {context,client}=fixture();
    client.calcWith.mockImplementation(async(p:any)=>({...base,NetManaRegen:p.addNodes?.includes(201)?20:10,
      calculationContext:{weaponSet:p.weaponSet??1,treeVersion:'0_5'}}));
    const result=details(await (handleSuggestOptimalNodes as any)(context,'Unsaved','NetManaRegen',3,{candidate_node_ids:[201]}));
    expect(result.axes).toEqual(['NetManaRegen']);
    expect(result.candidates[0].measurements['1'].deltas.NetManaRegen).toBe(10);
  });

  it('uses the measured planner for passive upgrades without default Life-as-EHP scoring',async()=>{
    const {context}=fixture();
    const result=await (handleGetPassiveUpgrades as any)(context,'both',3,{candidate_node_ids:[201],points_available:3});
    expect(details(result).candidates[0].addNodes).toEqual([200,201]);
    expect(body(result)).toMatch(/Pareto|separate objectives/i);
    expect(body(result)).not.toMatch(/Score:|life pool too low|5500/);
  });

  it('does no simulations when zero passive upgrade results are requested',async()=>{
    const {context,client}=fixture();
    const result=await (handleGetPassiveUpgrades as any)(context,'both',0,{candidate_node_ids:[201],points_available:3});
    expect(details(result).candidates).toEqual([]);
    expect(client.calcWith).not.toHaveBeenCalled();
  });

  it('refuses to report preservation if XML changes during a trial',async()=>{
    const {context,client}=fixture();let changed=false;
    client.exportBuildXml.mockImplementation(async()=>changed?xml.replace('level="10"','level="11"'):xml);
    client.calcWith.mockImplementation(async(p:any)=>{if(p.addNodes?.length)changed=true;return {...base,calculationContext:{weaponSet:p.weaponSet??1,treeVersion:'0_5'}};});
    await expect(suggest(context,{candidate_node_ids:[200]})).rejects.toThrow(/changed|preserv|state/i);
    expect(client.loadBuildXml).not.toHaveBeenCalled();
  });

  it('keeps missing probe outputs unknown and recognizes legitimate zero sensitivity',async()=>{
    const {context,client}=fixture();
    const result=await handleComputeStatWeights(context,undefined,['+50 to maximum Life','+20 to Strength']);
    expect(body(result)).toContain('unknown'); // Missing minion axis, zero base percentage.
    expect(body(result)).not.toMatch(/SUSPECT|restart|relaunch|scoring function/i);
    expect(details(result).verification.unchanged).toBe(true);
    expect(details(result).rows[0].deltas.CombinedDPS).toBe(0);
    expect(details(result).rows[0].deltas.MinionCombinedDPS).toBeNull();
    expect(client.probeStatWeights).toHaveBeenCalled();
  });

  it('does not call an unrecognized stat a measured zero',async()=>{
    const {context,client}=fixture();
    client.probeStatWeights.mockResolvedValue({base:{...base},slot:'Ring 1',carrier:'Current',evaluated:1,failed:0,
      results:[{mod:'Bad probe',recognized:false,dpsDelta:0,ehpDelta:0}]} as any);
    const result=details(await handleComputeStatWeights(context,'Ring 1',['Bad probe']));
    expect(result.rows[0].status).toBe('unrecognized');
    expect(result.rows[0].deltas.CombinedDPS).toBeNull();
  });

  it('distinguishes uninstilled anoint baseline from current build and avoids oil/fixed combined scores',async()=>{
    const {context}=fixture();
    const result=await handleFindBestAnointment(context,{slot:'Amulet',focus:'both',max_results:10});
    expect(body(result)).not.toMatch(/Oils:|Cord Belt|Score:/);
    expect(body(result)).toMatch(/uninstilled/i);
    expect(details(result).candidates.find((c:any)=>c.nodeId===201).currentDeltas.CombinedDPS).toBe(50);
    expect(details(result).candidates.find((c:any)=>c.nodeId===210).currentDeltas.TotalEHP).toBe(500);
    expect(details(result).verification.unchanged).toBe(true);
  });

  it('does not report floating-point roundoff as an instilling upgrade',async()=>{
    const {context,client}=fixture();
    client.evaluateAnointCandidates.mockResolvedValue({base:{CombinedDPS:900,TotalEHP:4500},slot:'Amulet',baseType:'Amber Amulet',focus:'both',evaluated:1,skipped:0,
      candidates:[{nodeId:201,name:'Current instill',dpsDelta:100.000000000004,ehpDelta:500.00000000004,score:1,recipe:[]}]} as any);
    const result=details(await handleFindBestAnointment(context,{slot:'Amulet'}));
    expect(result.candidates[0].currentDeltas).toEqual({CombinedDPS:0,TotalEHP:0});
  });

  it('retains both Pareto extremes when only two instilling alternatives are requested',async()=>{
    const {context,client}=fixture();
    client.evaluateAnointCandidates.mockResolvedValue({base:{CombinedDPS:900,TotalEHP:4500},slot:'Amulet',baseType:'Amber Amulet',focus:'both',evaluated:4,skipped:0,
      candidates:[{nodeId:201,name:'Damage',dpsDelta:400,ehpDelta:-400,score:9,recipe:[]},
        {nodeId:202,name:'Middle 1',dpsDelta:300,ehpDelta:0,score:8,recipe:[]},
        {nodeId:203,name:'Middle 2',dpsDelta:200,ehpDelta:100,score:7,recipe:[]},
        {nodeId:204,name:'Defense',dpsDelta:0,ehpDelta:1000,score:6,recipe:[]}]} as any);
    const result=details(await handleFindBestAnointment(context,{slot:'Amulet',max_results:2}));
    expect(result.candidates.map((candidate:any)=>candidate.nodeId)).toEqual([201,204]);
  });
});
