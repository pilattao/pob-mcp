import type { PoBBuild } from '../types.js';
import { extractPoe2SkillSets, finiteNumber, type SkillGem } from '../skillLinkOptimizer.js';
import { costsPassivePoint } from './passiveBudget.js';
import { loadPoe2LevelingDefinitions, type LevelingDefinitions, type LevelingGem, type LevelRequirement } from './poe2LevelingData.js';

export interface LevelingArgs {
  build_name?: string; class_name?: string; main_skill?: string; ascendancy?: string;
  current_level?: number; target_level?: number;
  current_stage?: 'act-1'|'act-2'|'act-3'|'act-4'|'interlude-1'|'interlude-2'|'interlude-3'|'epilogue'|'endgame';
  completed_quests?: string[];
  /** Earned primary ascendancy points, including unspent points. Never inferred from allocations. */
  ascendancy_points?: number;
}
export interface LevelingEvidence { build: PoBBuild; stats: Record<string, any>; source: 'file'|'live'|'arguments'; note: string }
const normalize=(s: string) => s.trim().toLowerCase();
const nonempty=(s: unknown): s is string => typeof s === 'string' && !!s.trim();
const list=(x: any): any[] => Object.values(x ?? {});
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function selectedLevelingSpec(build: PoBBuild): any {
  const raw=build.Tree?.Spec; if (!raw) return undefined;
  const specs=Array.isArray(raw)?raw:[raw];
  const index=Number(build.Tree?.activeSpec ?? 1)-1;
  if (!Number.isInteger(index) || !specs[index]) throw new Error('Selected passive tree spec is missing');
  return specs[index];
}
/** These are checked sources, not a promise of freshness across future patches. */
const officialSources = [
  {kind:'official-ggg',patch:'0.3.0',checkedAt:'2026-09-15',url:'https://www.pathofexile.com/forum/view-thread/3826682',scope:'Act 4 and three Interludes replace Cruel; Act 4 island order is flexible'},
  {kind:'official-ggg',patch:'0.2.0f',checkedAt:'2026-09-15',url:'https://www.pathofexile.com/forum/view-thread/3762929',scope:'Chaos 7 chambers up to 4 ascendancy points; 10 chambers up to 6; ascendancy respec conditions'},
  {kind:'official-ggg',patch:'0.5.5',checkedAt:'2026-09-15',url:'https://www.pathofexile.com/forum/view-thread/4000864',scope:'Campaign/interlude structure remains; Chaos continuation and fragment rewards'},
  {kind:'official-ggg',patch:'0.5.0',checkedAt:'2026-09-15',url:'https://www.pathofexile.com/forum/view-thread/3932540',scope:'Campaign replay routing changed; Act 2 boss is in The Dreadnaught; Act 3 area order changed; Runic Ward contributes to starting Honour'},
];
export interface LevelingSkillPlan {
  name: string; id?: string; group: number|null; mainGroup: boolean; support?: boolean;
  source: string; currentGemLevel: number|null; minimumGemLevel?: number; engravingTier?: number;
  firstRequirement?: LevelRequirement; currentRequirement?: LevelRequirement;
  /** Character-level ceiling only; attributes, acquisition and other constraints still apply. */
  levelEligibleRequirement?: LevelRequirement;
  nextRequirement?: LevelRequirement; milestones: LevelRequirement[];
  status: 'blocked'|'requirements-met'|'conditional'|'unresolved'; conditions: string[];
}
function resolveGem(gem: SkillGem, catalog: LevelingGem[]): LevelingGem|undefined {
  const matches=gem.gemId ? catalog.filter(g => g.id === gem.gemId || g.gameId === gem.gemId)
    : gem.skillId ? catalog.filter(g => g.skillId === gem.skillId) : catalog.filter(g => normalize(g.name) === normalize(gem.name));
  return matches.length === 1 ? matches[0] : undefined;
}
function canonicalClass(name: string, definitions: LevelingDefinitions): any {
  const classes=list(definitions.tree.classes);
  const result=classes.find(c => normalize(c.name) === normalize(name));
  if (!result) throw new Error(`Unknown installed PoE2 class '${name}'. Available: ${classes.map(c => c.name).join(', ')}`);
  return result;
}
export function createPoe2LevelingPlan(evidence: LevelingEvidence, args: LevelingArgs, definitions?: LevelingDefinitions) {
  const {build,source}=evidence;
  if (build.__xmlRoot !== 'PathOfBuilding2') throw new Error('Leveling requires a PathOfBuilding2 build');
  const spec=selectedLevelingSpec(build);
  const data=definitions ?? loadPoe2LevelingDefinitions(spec?.treeVersion);
  const name=args.class_name ?? build.Build?.className;
  if (!nonempty(name)) throw new Error('Provide a selected build or class_name and current_level');
  const cls=canonicalClass(name,data);
  if (build.Build?.className && normalize(build.Build.className) !== normalize(cls.name)) throw new Error('class_name conflicts with the selected build class; select the intended build');
  const currentAscendancy=build.Build?.ascendClassName;
  const requestedAscendancy=args.ascendancy ?? currentAscendancy;
  const ascList=list(cls.ascendancies).map(c => c.name as string);
  const ascendancy=nonempty(requestedAscendancy) && !['none','unknown'].includes(normalize(requestedAscendancy))
    ? ascList.find(a => normalize(a) === normalize(requestedAscendancy)) : null;
  if (nonempty(requestedAscendancy) && !['none','unknown'].includes(normalize(requestedAscendancy)) && !ascendancy) throw new Error(`Ascendancy '${requestedAscendancy}' does not belong to ${cls.name} in installed PoE2 data. Available: ${ascList.join(', ')}`);
  const storedLevel=finiteNumber(build.Build?.level);
  const level=integer(args.current_level ?? storedLevel,'current_level',1,100);
  const targetLevel=integer(args.target_level ?? 100,'target_level',level,100);
  const earned=args.ascendancy_points === undefined ? null : integer(args.ascendancy_points,'ascendancy_points',0,8);
  if (earned !== null && earned % 2 !== 0) throw new Error('ascendancy_points must be 0, 2, 4, 6, or 8');
  const model=extractPoe2SkillSets(build);
  const allocatedIds=new Set(String(spec?.nodes ?? '').split(',').filter(Boolean));
  const gaps: string[]=[], actions: string[]=[];
  const stats=level === storedLevel ? evidence.stats : {};
  const attr=Object.fromEntries(['Str','Dex','Int'].map(k => [k,finiteNumber(stats[k]) ?? null]));
  if (source === 'arguments') gaps.push('Character gear, attributes, skills, and passives have no build evidence; this is an explicit planning scenario.');
  if (level !== storedLevel) gaps.push('Current level overrides the saved target level; target-build stats cannot establish current character requirements.');
  if (!args.current_stage) gaps.push('Current campaign stage is unknown; character level does not establish quest progress.');
  if (earned === null) gaps.push('Earned ascendancy points are unknown; selected class and allocated nodes do not prove trial completion.');
  if (!spec) gaps.push('Selected passive tree is unavailable.');
  if (data.version !== '0_5') gaps.push('Official campaign/trial guidance was checked through 0.5.5 for native 0_5; recheck progression for this version.');
  const selected=model.selected.groups.filter(g => g.enabled);
  const requestedGems=selected.flatMap(group => group.gems.filter(g => g.enabled !== false).map(gem => ({gem,group:group.index,mainGroup:group.isMainSkill,source:group.source})));
  if (args.main_skill !== undefined) {
    if (!nonempty(args.main_skill)) throw new Error('main_skill must be a non-empty exact native name or ID');
    const matches=data.gems.filter(g => g.id === args.main_skill || g.gameId === args.main_skill || g.skillId === args.main_skill || normalize(g.name) === normalize(args.main_skill!));
    if (matches.length !== 1 || matches[0].support) throw new Error(`main_skill '${args.main_skill}' is not a unique active skill in installed PoE2 gem data`);
    const target=matches[0];
    if (!requestedGems.some(row => resolveGem(row.gem,data.gems)?.id === target.id)) requestedGems.push({gem:{name:target.name,gemId:target.id},group:0,mainGroup:true,source:'requested-target'});
  }
  const skillPlans: LevelingSkillPlan[]=requestedGems.map(({gem,group,mainGroup,source:groupSource}) => {
    const native=resolveGem(gem,data.gems);
    const row: LevelingSkillPlan={name:native?.name ?? gem.name,id:native?.id,group:group || null,mainGroup,support:native?.support,
      source:groupSource ?? source,currentGemLevel:gem.level ?? null,status:'unresolved',milestones:[],conditions:[]};
    if (!native || !native.levels.length) {gaps.push(`${gem.name}: native gem requirements are unavailable or ambiguous.`);return row;}
    row.engravingTier=native.tier;
    const grants=Object.values(data.tree.nodes).filter(n => n.stats.some(s => s === `Grants Skill: ${native.name}`));
    if (grants.length && (!native.tier || groupSource)) {
      row.status='conditional';
      row.conditions.push(...grants.map(n => `Granted by ${n.name}${n.ascendancyName?` (${n.ascendancyName})`:''}, native passive ${n.skill}; ${allocatedIds.has(String(n.skill))?'allocated in the selected build':'not allocated in the selected build'}. This has no uncut-gem unlock level.`));
      if (!grants.some(n => allocatedIds.has(String(n.skill)))) {
        gaps.push(`${native.name}: the native granting passive is not allocated in this build.`);
        actions.push(`${native.name}: obtain its listed granting passive and meet its class/ascendancy conditions before relying on the skill.`);
      }
      return row;
    }
    if (groupSource && groupSource !== 'requested-target') {
      row.status='conditional'; row.conditions.push(`Granted by ${groupSource}; obtain and meet that source's requirements. Gem engraving rows do not prove availability.`);
      gaps.push(`${native.name}: source-granted skill acquisition needs the granting item or passive.`); return row;
    }
    if (native.support) {
      row.status='conditional'; row.conditions.push(native.lineage ? 'Lineage support acquisition is drop-specific; an Uncut Support Gem does not establish availability.'
        : native.tier ? `Acquire an Uncut Support Gem of tier ${native.tier} or higher, or the matching support gem; tier is not character level.` : 'Support acquisition tier is unavailable.');
      row.conditions.push('Verify the active skill supports this gem, its available support sockets, and any support-family limits.');
      if (!native.tier || native.legacy) gaps.push(`${native.name}: support acquisition needs verification.`);
      return row;
    }
    if (!native.tier || !native.naturalMaxLevel || native.legacy || native.tier > native.naturalMaxLevel) {
      row.conditions.push('No verified engravable level range in installed definitions.');gaps.push(`${native.name}: acquisition tier or natural gem cap is unresolved.`);return row;
    }
    row.minimumGemLevel=native.tier;
    const available=native.levels.filter(r => r.level >= native.tier! && r.level <= native.naturalMaxLevel!);
    row.firstRequirement=available.find(r => r.level === native.tier);
    row.milestones=available.filter(r => r.levelRequirement <= targetLevel);
    row.levelEligibleRequirement=available.filter(r => r.levelRequirement <= level).at(-1);
    if (!row.firstRequirement) {gaps.push(`${native.name}: engraving-tier requirements are missing.`);return row;}
    const invalidLevel=gem.level !== undefined && (!Number.isInteger(gem.level) || gem.level < native.tier || gem.level > native.naturalMaxLevel);
    if (invalidLevel) {
      row.conditions.push(`Recorded gem level ${gem.level} is outside the verified engraving range ${native.tier}–${native.naturalMaxLevel}; it may be a calculation-only level.`);
      gaps.push(`${native.name}: recorded gem level is outside its natural range.`);
    }
    row.currentRequirement=available.find(r => r.level === gem.level);
    row.nextRequirement=available.find(r => r.level > (gem.level ?? 0) && r.levelRequirement <= targetLevel);
    const required=row.currentRequirement ?? row.firstRequirement;
    const deficits:string[]=[];
    if (level < required.levelRequirement) deficits.push(`character level ${required.levelRequirement} (current ${level})`);
    for (const key of ['Str','Dex','Int'] as const) {
      const needed=required[`req${key}`];
      if (needed > 0 && attr[key] === null) gaps.push(`${native.name}: current ${key} is unknown; requires ${needed} at gem level ${required.level}.`);
      else if (needed > 0 && attr[key]! < needed) deficits.push(`${needed} ${key} (current ${attr[key]})`);
    }
    row.status=deficits.length ? 'blocked' : invalidLevel || ['Str','Dex','Int'].some(k => attr[k] === null) ? 'conditional' : 'requirements-met';
    const uncut=native.persistent ? 'Uncut Spirit Gem' : 'Uncut Skill Gem';
    row.conditions.push(`Acquire ${uncut} level ${native.tier} or higher (or the matching gem). Native calculation levels below tier ${native.tier} are not engraving availability.`);
    if (native.weaponRequirements) row.conditions.push(`Weapon requirement: ${native.weaponRequirements}; verify the equipped weapon set.`);
    if (gem.corrupted) {row.nextRequirement=undefined;row.conditions.push('Corrupted gem: verify an obtainable replacement before changing its level.');}
    const intermediate=row.levelEligibleRequirement;
    if (intermediate && gem.level !== undefined && gem.level > intermediate.level) actions.push(
      `Consider an intermediate ${native.name} gem level ${intermediate.level}: character level ${intermediate.levelRequirement}, ${intermediate.reqStr} Str / ${intermediate.reqDex} Dex / ${intermediate.reqInt} Int. Obtain it and check current attributes/resources before using it; target-build stats are not proof.`);
    if (deficits.length) actions.push(`${native.name}: meet ${deficits.join(' and ')} before using the recorded/first engravable gem level ${required.level}.`);
    else if (row.nextRequirement) {
      const next=row.nextRequirement;
      actions.push(`${native.name}: next natural gem level ${next.level} needs character level ${next.levelRequirement}, ${next.reqStr} Str / ${next.reqDex} Dex / ${next.reqInt} Int; obtain that gem and recheck resources.`);
    }
    return row;
  });
  if (!skillPlans.some(s => s.support === false)) gaps.push('No resolved active skill in the selected set; provide main_skill or fix the selected build.');
  if (!skillPlans.some(s => s.mainGroup && s.support === false)) gaps.push('No resolved main skill group; no first-group fallback was used.');
  for (const k of ['SpiritUnreserved','ManaUnreserved','LifeUnreserved']) {
    const n=finiteNumber(stats[k]); if (n !== undefined && n < 0) actions.unshift(`Resolve ${k} ${n} in the observed build before adding more reservation.`);
  }
  const stageIds=[...new Set(data.quests.map(q => q.stage))];
  if (args.current_stage && ![...stageIds,'endgame'].includes(args.current_stage)) throw new Error('current_stage is not a native campaign stage');
  if (args.completed_quests !== undefined && (!Array.isArray(args.completed_quests) || args.completed_quests.some(id => !nonempty(id) || !data.quests.some(q => q.id === id)))) throw new Error('completed_quests must contain native quest IDs from the plan');
  const completed=new Set(args.completed_quests ?? []);
  const campaign=stageIds.map(id => ({id,label:data.quests.find(q => q.stage === id)!.label,
    status:args.current_stage === id ? 'current' : 'unverified',
    quests:data.quests.filter(q => q.stage === id).map(q => ({...q,status:completed.has(q.id)?'completed':'unverified',source:'native-quests'}))}));
  const remaining=campaign.flatMap(s => s.quests).filter(q => q.status !== 'completed');
  const current=campaign.find(s => s.id === args.current_stage);
  for (const q of (current?.quests ?? remaining).filter(q => q.status !== 'completed').slice(0,3)) actions.push(`Check ${q.info} in ${q.area} (${q.label}); claim ${q.reward ?? 'one of the listed reward choices'} if outstanding. Quest ID: ${q.id}.`);
  const nodes=[...allocatedIds];
  const known=nodes.map(id => data.tree.nodes[id]).filter(Boolean);
  if (known.length !== nodes.length) gaps.push('Some allocated passive IDs are absent from the installed tree.');
  const paid=known.filter(n => costsPassivePoint(n as any));
  const questPoints=data.quests.filter(q => completed.has(q.id)).reduce((sum,q) => sum+q.passivePoints,0);
  const primaryAllocated=paid.filter(n => n.ascendancyName === currentAscendancy).length;
  if (earned !== null && primaryAllocated > earned) gaps.push(`Selected build allocates ${primaryAllocated} primary ascendancy points but caller reports only ${earned} earned; this is a target build or inconsistent progress.`);
  const nextPoints=earned === null ? null : earned < 8 ? earned+2 : null;
  const trialAction=earned === 8 ? 'All 8 primary ascendancy points are reported earned; no further primary trial reward is planned.'
    : `For ${nextPoints === null ? 'the next pair of' : `a total of ${nextPoints}`} primary ascendancy points, use Trial of the Sekhemas or Trial of Chaos only when the entry item indicates it will grant additional points; finish its required objective and claim the altar.`;
  actions.push(trialAction);
  const conditionalRoutes=data.version === '0_5' && earned !== 8 ? [
    {trial:'Trial of the Sekhemas',condition:'Entry item must grant the next pair for this character; complete the required trial and claim the altar.',characterLevelRequirement:null},
    {trial:'Trial of Chaos',upToPoints:4,chambers:7,entryAreaLevel:55,characterLevelRequirement:null,condition:'GGG 0.2.0f baseline; verify the actual key reward eligibility. The quest entry is a separate case.',source:officialSources[1].url},
    {trial:'Trial of Chaos',upToPoints:6,chambers:10,entryAreaLevel:65,characterLevelRequirement:null,condition:'GGG 0.2.0f baseline; verify the actual key reward eligibility. This is not the final primary ascendancy reward.',source:officialSources[1].url},
  ].filter(r => earned === null || r.upToPoints === undefined || r.upToPoints > earned) : [];
  return {
    game:'poe2',status:gaps.length?'partial':'planned',
    scope:'Campaign reward checklist, natural gem requirements, and conditional ascendancy objectives; no simulated tree order or combat-readiness claim.',
    character:{className:cls.name,ascendancy:currentAscendancy ?? null,targetAscendancy:ascendancy,level,targetLevel,source,skillSetId:model.selected.id,skillSetTitle:model.selected.title ?? null,attributes:attr},
    note:evidence.note,actions,skills:skillPlans,campaign,
    ascendancy:{available:ascList,earnedPoints:earned,allocatedPrimaryPoints:primaryAllocated,nextTotalPoints:nextPoints,action:trialAction,routes:conditionalRoutes,
      limitation:'Trial-entry inventory, completion, final-trial eligibility, and any secondary ascendancy progression are not present in PoB XML; confirm them in game. No character-level unlock is inferred.'},
    passives:{treeVersion:data.version,allocatedRegularPoints:paid.filter(n => !n.ascendancyName).length,confirmedQuestRewardPoints:questPoints,
      totalNativeQuestRewardPoints:data.quests.reduce((sum,q) => sum+q.passivePoints,0),recommendedOrder:null,
      note:'Quest reward points are reported only for caller-confirmed quests. Weapon-set points have separate allocation rules. Selected endgame nodes do not establish leveling order; no path is invented.'},
    gaps:[...new Set(gaps)],sources:[...data.sources,...officialSources],
    constraints:[
      'Quest AreaLevel values describe zones, not character-level unlocks. Progress and reward choices cannot be inferred from PoB level/configuration.',
      'Gem requirements are native base requirements; gear modifiers and converted requirements need a fresh native check. Requirements-met only covers the observed level and attributes.',
      'Support slots belong to skills. Verify current socket capacity and support compatibility; there is no equipment-link leveling schedule.',
      'Uncut gem availability, weapon compatibility, Spirit reservation and resource sustain must be met before switching. Base gem costs are not final character costs.',
      data.version === '0_5' ? 'Campaign sequence: Acts 1–4, then the three Interludes and Epilogue. Act 4 island ordering is flexible. GGG 0.5.0 moved the Act 2 boss to The Dreadnaught and changed Act 3 area order. Reward checklist is not a full quest walkthrough.' : 'Native reward labels are listed; the campaign sequence for this version needs official verification.',
    ],
  };
}
export function formatPoe2LevelingPlan(plan: ReturnType<typeof createPoe2LevelingPlan>): string {
  const lines=[`# PoE2 Leveling Plan: ${plan.character.className}`,`Status: ${plan.status}`,plan.note,
    `Character level: ${plan.character.level}; target: ${plan.character.targetLevel}; skill set: ${plan.character.skillSetId}${plan.character.skillSetTitle?` (${plan.character.skillSetTitle})`:''}`,
    `Ascendancy: ${plan.character.ascendancy ?? 'unselected'}; target: ${plan.character.targetAscendancy ?? 'unselected'}`,plan.scope,'','## Next actions',...plan.actions.map(a => `- ${a}`),'','## Skill requirements'];
  const req=(r: LevelRequirement) => `gem ${r.level}: character level ${r.levelRequirement}, ${r.reqStr} Str / ${r.reqDex} Dex / ${r.reqInt} Int`;
  for (const s of plan.skills) {
    lines.push('',`### ${s.name} — ${s.status} (${s.group?`group ${s.group}`:'requested target'})`,...s.conditions.map(c => `- ${c}`));
    if (s.firstRequirement) lines.push(`First engravable ${req(s.firstRequirement)}`);
    if (s.currentRequirement) lines.push(`Recorded ${req(s.currentRequirement)}`);
    if (s.levelEligibleRequirement) lines.push(`Ceiling by character level only: ${req(s.levelEligibleRequirement)}; acquisition and attribute checks still apply.`);
    if (s.nextRequirement) lines.push(`Next ${req(s.nextRequirement)}`);
    if (s.milestones.length) lines.push('Natural gem progression through the target level:',...s.milestones.map(r => `- ${req(r)}`));
  }
  lines.push('','## Campaign rewards','Completion is only marked for supplied quest IDs; area levels are zone metadata.');
  for (const stage of plan.campaign) {
    lines.push('',`### ${stage.label}${stage.status === 'current'?' (current)':''}`);
    for (const q of stage.quests) lines.push(`- [${q.status === 'completed'?'x':' '}] ${q.info} — ${q.area}: ${q.reward ?? q.options.join(' OR ')}. [${q.id}]${q.areaLevel !== undefined?` (area level ${q.areaLevel})`:''}`);
  }
  lines.push('','## Ascendancy',plan.ascendancy.action,`Available for this class: ${plan.ascendancy.available.join(', ')}`,plan.ascendancy.limitation,
    ...plan.ascendancy.routes.map(r => `- ${r.trial}${'chambers' in r?`: ${r.chambers} chambers, entry area level ${r.entryAreaLevel}, up to ${r.upToPoints} points`:''}: ${r.condition}`),
    '','## Passive progression',plan.passives.note,`Confirmed quest reward points: ${plan.passives.confirmedQuestRewardPoints}; native campaign total: ${plan.passives.totalNativeQuestRewardPoints}.`,
    '','## Constraints',...plan.constraints.map(c => `- ${c}`));
  if (plan.gaps.length) lines.push('','## Missing evidence',...plan.gaps.map(g => `- ${g}`));
  lines.push('','## Sources');
  for (const source of plan.sources) lines.push('url' in source ? `- [GGG ${source.patch}](${source.url}), checked ${source.checkedAt}: ${source.scope}` : `- ${source.kind}: ${source.path} (SHA-256 ${source.sha256})`);
  return lines.join('\n');
}
