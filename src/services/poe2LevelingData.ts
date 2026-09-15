/** Read-only leveling definitions from ONE verified PoB2 installation. */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import luaparse from 'luaparse';
import { resolvePobDataLocation } from './pobDataPath.js';
import { getPobTreeData, type PobTreeData } from './pobTreeDataLoader.js';

export interface LevelRequirement {
  level: number;
  levelRequirement: number;
  reqStr: number;
  reqDex: number;
  reqInt: number;
  costs?: Record<string, number>;
}
export interface LevelingGem {
  id: string; gameId?: string; skillId: string; name: string; support: boolean;
  tier?: number; naturalMaxLevel?: number; gemType?: string; weaponRequirements?: string;
  legacy: boolean; lineage: boolean; persistent: boolean; levels: LevelRequirement[]; source: string;
}
export interface LevelingQuest {
  id: string; stage: string; label: string; area: string; info: string;
  reward?: string; options: string[]; areaLevel?: number; passivePoints: number;
}
export interface LevelingDefinitions {
  version: string; tree: PobTreeData; gems: LevelingGem[]; quests: LevelingQuest[];
  sources: Array<{kind: string; path: string; sha256: string}>;
}
const parse = (path: string): any => luaparse.parse(readFileSync(path).toString('latin1'), {comments:false,encodingMode:'pseudo-latin1'});
function literal(node: any): any {
  if (!node) return undefined;
  if (node.type === 'StringLiteral') return Buffer.from(node.value,'latin1').toString('utf8');
  if (['NumericLiteral','BooleanLiteral'].includes(node.type)) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-') return -literal(node.argument);
  if (node.type !== 'TableConstructorExpression') return undefined;
  const result: Record<string, any> = {}; let index = 0;
  for (const field of node.fields) {
    const key = field.type === 'TableValue' ? ++index : field.type === 'TableKeyString' ? field.key.name : literal(field.key);
    const value = literal(field.value);
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}
function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n,visit)); return; }
  visit(node);
  for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value,visit);
}
const rows = (table: any): any[] => Object.values(table ?? {});
export const levelingId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** Evaluate only the arithmetic/branches in the installed requirement function.
 * No Lua code, imports, I/O, or build state are executed. Unknown syntax fails closed.
 */
function requirementFunction(ast: any): (level: number, multi: number, support: boolean) => number {
  const fn = ast.body.find((n: any) => n.type === 'FunctionDeclaration' && n.identifier?.base?.name === 'calcLib' && n.identifier?.identifier?.name === 'getGemStatRequirement');
  if (!fn) throw new Error('Native getGemStatRequirement definition is missing');
  const expr = (n: any, env: Record<string, any>): any => {
    if (['NumericLiteral','BooleanLiteral'].includes(n.type)) return n.value;
    if (n.type === 'Identifier' && n.name in env) return env[n.name];
    if (n.type === 'UnaryExpression' && n.operator === '-') return -expr(n.argument,env);
    if (n.type === 'LogicalExpression') {
      const left=expr(n.left,env), truth=left !== false && left != null;
      return n.operator === 'or' ? truth ? left : expr(n.right,env) : truth ? expr(n.right,env) : left;
    }
    if (n.type === 'BinaryExpression') {
      const a = expr(n.left,env), b = expr(n.right,env);
      switch (n.operator) { case '+':return a+b; case '-':return a-b; case '*':return a*b; case '/':return a/b; case '^':return a**b; case '<':return a<b; case '>':return a>b; case '<=':return a<=b; case '>=':return a>=b; case '==':return a===b; }
    }
    if (n.type === 'CallExpression' && n.base?.name === 'round' && n.arguments.length === 1) return Math.floor(expr(n.arguments[0],env)+0.5);
    throw new Error(`Unsupported native requirement expression: ${n.type}`);
  };
  const run = (body: any[], env: Record<string, any>): {value: number} | undefined => {
    for (const n of body) {
      if (n.type === 'ReturnStatement') return {value:expr(n.arguments[0],env)};
      if (n.type === 'LocalStatement') { n.variables.forEach((v: any,i: number) => {env[v.name]=expr(n.init[i],env);}); continue; }
      if (n.type === 'IfStatement') {
        for (const clause of n.clauses) if (!clause.condition || expr(clause.condition,env)) { const result=run(clause.body,env); if (result) return result; break; }
        continue;
      }
      throw new Error(`Unsupported native requirement statement: ${n.type}`);
    }
  };
  return (level,multi,support) => {
    const values = [level,multi,support];
    const result=run(fn.body,Object.fromEntries(fn.parameters.map((p: any,i: number) => [p.name,values[i]])))?.value;
    if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) throw new Error('Invalid native gem requirement result');
    return result;
  };
}
let cache: {signature: string; value: LevelingDefinitions} | undefined;
export function loadPoe2LevelingDefinitions(requestedVersion?: string): LevelingDefinitions {
  const {dataDir,game} = resolvePobDataLocation();
  if (game !== 'poe2') throw new Error('Leveling requires installed PoB2 definitions');
  const root = dirname(dataDir), versionFile=join(root,'GameVersions.lua');
  let version: string | undefined;
  // liveTargetVersion identifies the XML target, not the current passive tree.
  for (const n of parse(versionFile).body) if (n.type === 'AssignmentStatement') n.variables.forEach((v: any,i: number) => {
    if (v.name === 'treeVersionList') version=rows(literal(n.init[i])).at(-1);
  });
  if (!version?.startsWith('0_')) throw new Error('Installed PoB2 version is unavailable');
  if (requestedVersion && requestedVersion !== version) throw new Error(`Build tree ${requestedVersion} differs from installed leveling definitions ${version}; use matching data before planning`);
  const files = [versionFile,join(root,'TreeData',version,'tree.lua'),join(dataDir,'QuestRewards.lua'),join(dataDir,'Gems.lua'),join(root,'Modules/CalcTools.lua'),
    ...readdirSync(join(dataDir,'Skills')).filter(n => /^(act_|sup_|other\.lua)/.test(n) && n.endsWith('.lua')).sort().map(n => join(dataDir,'Skills',n))];
  const signature=files.map(f => `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`).join('|');
  if (cache?.signature === signature) return cache.value;
  const tree=getPobTreeData(version);
  const questTable=literal(parse(files[2]).body.find((n: any) => n.type === 'ReturnStatement')?.arguments[0]);
  const gemTable=literal(parse(files[3]).body.find((n: any) => n.type === 'ReturnStatement')?.arguments[0]);
  if (!questTable || !gemTable) throw new Error('Native quest/gem definitions are missing');
  const requirement=requirementFunction(parse(files[4]));
  const effects: Record<string, any> = {};
  for (const file of files.slice(5)) walk(parse(file),n => {
    if (n.type !== 'AssignmentStatement') return;
    n.variables.forEach((v: any,i: number) => {
      if (v.type !== 'IndexExpression' || v.base?.name !== 'skills') return;
      const selected = n.init[i]?.fields?.filter((f: any) => ['levels','support','legacy','isLineage'].includes(f.key?.name));
      effects[literal(v.index)] = literal({type:'TableConstructorExpression',fields:selected ?? []});
    });
  });
  const gems: LevelingGem[] = Object.entries<any>(gemTable).flatMap(([id,g]) => {
    const e=effects[g.grantedEffectId]; if (!e?.levels) return [];
    const levels: LevelRequirement[] = Object.entries<any>(e.levels).flatMap(([level,row]) => {
      if (!positive(+level) || typeof row.levelRequirement !== 'number' || row.levelRequirement < 0) return [];
      if (![g.reqStr,g.reqDex,g.reqInt].every(n => typeof n === 'number' && n >= 0)) return [];
      return [{level:+level,levelRequirement:row.levelRequirement,reqStr:requirement(row.levelRequirement,g.reqStr,e.support === true),
        reqDex:requirement(row.levelRequirement,g.reqDex,e.support === true),reqInt:requirement(row.levelRequirement,g.reqInt,e.support === true),costs:row.cost}];
    }).sort((a,b) => a.level-b.level);
    return [{id,gameId:g.gameId,skillId:g.grantedEffectId,name:g.name,support:e.support === true,tier:positive(g.Tier)?g.Tier:undefined,
      naturalMaxLevel:positive(g.naturalMaxLevel)?g.naturalMaxLevel:undefined,gemType:g.gemType,weaponRequirements:g.weaponRequirements,
      legacy:e.legacy === true,lineage:e.isLineage === true,persistent:g.tags?.persistent === true,levels,source:'native-gems'}];
  });
  const quests: LevelingQuest[]=rows(questTable).map(q => {
    const stage=q.Description === 'Epilog' ? 'epilogue' : levelingId(q.Description);
    return {id:`${stage}/${levelingId(q.Info)}`,stage,label:q.Description === 'Epilog'?'Epilogue':q.Description,
      area:q.Area,info:q.Info,reward:q.Stat,options:rows(q.Options),areaLevel:q.AreaLevel,passivePoints:q.questPoints ?? 0};
  });
  const sources=files.map((path,i) => ({kind:i===0?'native-version':i===1?'native-tree':i===2?'native-quests':i===4?'native-requirements':'native-gems',path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
  const value={version,tree,gems,quests,sources}; cache={signature,value}; return value;
}
