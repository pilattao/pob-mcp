/** Jewel geometry in native tree coordinates. No shared constants across versions. */
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import luaparse from 'luaparse';
import { getPobTreeData, getLoadedVersion, type PobNode, type PobTreeData } from './pobTreeDataLoader.js';
import { resolvePobDataLocation } from './pobDataPath.js';

export interface RadiusContext { treeVersion?: string; tree?: PobTreeData }
export interface RadiusBand { inner: number; outer: number; label?: string; index?: number }

export function radiusTree(context: RadiusContext = {}): Required<RadiusContext> {
  const tree = context.tree ?? getPobTreeData(context.treeVersion);
  const treeVersion = context.treeVersion ?? (/^\d+_\d+$/.test(tree.tree) ? tree.tree : getLoadedVersion());
  if (process.env.POE_GAME === 'poe2' && !treeVersion.startsWith('0_')) throw new Error('PoE2 jewel geometry cannot use a PoE1 tree.');
  return { tree, treeVersion };
}

// Lua's explicit numeric keys are 1-based objects; implicit arrays are 0-based JS arrays.
function entry(table: any, zeroIndex: number): any {
  return Array.isArray(table) ? table[zeroIndex] : table?.[zeroIndex + 1];
}

export const ORBIT_2_3_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
const FORTY_ANGLES = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180, 190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350];

function orbitAngle(orbit: number, index: number, context: Required<RadiusContext>): number | null {
  const constants = context.tree.constants as any;
  const angles = entry(constants?.orbitAnglesByOrbit, orbit);
  if (angles) {
    const angle = entry(angles, index);
    return typeof angle === 'number' && Number.isFinite(angle) ? angle : null;
  }
  if (context.treeVersion.startsWith('0_')) return null;
  const count = entry(constants?.skillsPerOrbit, orbit);
  if (!Number.isInteger(count) || count <= 0 || index < 0 || index >= count) return null;
  // Native legacy CalcOrbitAngles branches on orbit SIZE, not orbit number.
  const degrees = count === 16 ? ORBIT_2_3_ANGLES[index] : count === 40 ? FORTY_ANGLES[index] : index * 360 / count;
  return degrees * Math.PI / 180;
}

export function angleForOrbitIndex(orbit: number, orbitIndex: number, context: RadiusContext = {}): number {
  const angle = orbitAngle(orbit, orbitIndex, radiusTree(context));
  if (angle === null) throw new Error('Native orbit angle unavailable.');
  return angle * 180 / Math.PI;
}

export function getNodePosition(node: PobNode | null | undefined, context: RadiusContext = {}): { x: number; y: number } | null {
  if (!node) return null;
  const resolved = radiusTree(context);
  const group = resolved.tree.groups[String(node.group)];
  if (!group || !Number.isFinite(group.x) || !Number.isFinite(group.y)) return null;
  const radius = entry((resolved.tree.constants as any)?.orbitRadii, node.orbit);
  const angle = orbitAngle(node.orbit, node.orbitIndex, resolved);
  if (typeof radius !== 'number' || !Number.isFinite(radius) || angle === null) return null;
  // PassiveTree:ProcessNode, scaleImage=1: angles start north and turn clockwise.
  return { x: group.x + Math.sin(angle) * radius, y: group.y - Math.cos(angle) * radius };
}

export function getNodePositionById(nodeId: string, context: RadiusContext = {}): { x: number; y: number } | null {
  const resolved = radiusTree(context);
  return getNodePosition(resolved.tree.nodes[nodeId], resolved);
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Legacy PoE1 compatibility; PoE2 callers must resolve the native radius. */
export const JEWEL_RADII = { small: 800, medium: 1200, large: 1500 } as const;
export type JewelRadiusClass = keyof typeof JEWEL_RADII;

// Read only literal native configuration; never execute installation code here.
function literal(node: any): any {
  if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral'].includes(node?.type)) return node.value;
  if (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'NumericLiteral') return -node.argument.value;
  if (node?.type !== 'TableConstructorExpression') throw new Error('Nonliteral native jewel radius configuration.');
  const result: Record<string, any> = {}; let index = 1;
  for (const field of node.fields) {
    const key = field.type === 'TableValue' ? index++ : field.type === 'TableKeyString' ? field.key.name : literal(field.key);
    result[String(key)] = literal(field.value);
  }
  return result;
}

const nativeConfigCache = new Map<string, { stamp: string; value: any }>();
function nativeAssignment(file: string, member: string): any {
  const st = statSync(file), stamp = `${st.mtimeMs}:${st.size}`, key = `${file}:${member}`;
  const cached = nativeConfigCache.get(key);
  if (cached?.stamp === stamp) return cached.value;
  const ast: any = luaparse.parse(readFileSync(file, 'utf8'), { comments: false, encodingMode: 'x-user-defined', luaVersion: '5.2' });
  for (const statement of ast.body) {
    if (statement.type !== 'AssignmentStatement') continue;
    for (let i = 0; i < statement.variables.length; i++) {
      const variable = statement.variables[i];
      if (variable.type === 'MemberExpression' && variable.base?.name === 'data' && variable.identifier?.name === member) {
        const value = literal(statement.init[i]);
        nativeConfigCache.set(key, { stamp, value }); return value;
      }
    }
  }
  throw new Error(`Native jewel configuration ${member} is unavailable.`);
}

/** Mirrors Modules/Data.lua:setJewelRadiiGlobally, including the distance multiplier. */
export function getJewelRadius(labelOrIndex: string | number, context: RadiusContext = {}): RadiusBand {
  const resolved = radiusTree(context);
  if (typeof labelOrIndex === 'string' && labelOrIndex.toLowerCase() === 'variable') throw new Error('Variable jewel radius is unknown without a selected ring variant.');
  if (!resolved.treeVersion.startsWith('0_')) {
    const outer = JEWEL_RADII[String(labelOrIndex).toLowerCase() as JewelRadiusClass];
    if (outer === undefined) throw new Error(`Legacy jewel radius ${labelOrIndex} is unavailable.`);
    return { inner: 0, outer, label: String(labelOrIndex) };
  }
  const location = resolvePobDataLocation();
  if (location.game !== 'poe2') throw new Error('PoE2 jewel radii require PoB2 data; PoE1 fallback is disabled.');
  const radii = nativeAssignment(join(dirname(location.dataDir), 'Modules', 'Data.lua'), 'jewelRadii');
  const constants = nativeAssignment(join(location.dataDir, 'Misc.lua'), 'gameConstants');
  const [major, minor] = resolved.treeVersion.split('_').map(Number);
  const versions = Object.keys(radii).filter(v => /^\d+_\d+$/.test(v)).filter(v => {
    const [a, b] = v.split('_').map(Number); return a === major && b <= minor;
  }).sort((a, b) => Number(b.split('_')[1]) - Number(a.split('_')[1]));
  const table = radii[versions[0]];
  const index = typeof labelOrIndex === 'number' ? labelOrIndex : Number(Object.keys(table ?? {}).find(k => table[k].label?.toLowerCase() === labelOrIndex.toLowerCase()));
  const info = table?.[index], scale = constants.PassiveTreeJewelDistanceMultiplier;
  if (!info || !Number.isFinite(scale) || scale <= 0) throw new Error(`Native PoE2 jewel radius ${labelOrIndex} is unavailable.`);
  const band = { inner: info.inner * scale, outer: info.outer * scale, label: info.label, index };
  checkBand(band); return band;
}

function checkBand(band: RadiusBand): void {
  if (!Number.isFinite(band.inner) || !Number.isFinite(band.outer) || band.inner < 0 || band.outer < band.inner) throw new Error('Invalid jewel radius bounds.');
}

export function nodesInRadius(socketNodeId: string, radius: number | RadiusBand, filter?: (node: PobNode) => boolean, context: RadiusContext = {}): string[] {
  const resolved = radiusTree(context), tree = resolved.tree;
  const band = typeof radius === 'number' ? { inner: 0, outer: radius } : radius;
  checkBand(band);
  const socket = tree.nodes[socketNodeId], socketPos = getNodePosition(socket, resolved);
  if (!socketPos) throw new Error(`Jewel radius unavailable: socket ${socketNodeId} has no native position.`);
  if (socket.noRadius || socket.containJewelSocket || socket.name === 'Charm Socket') throw new Error(`Socket ${socketNodeId} does not support a native jewel radius.`);
  const matches: string[] = [];
  for (const [id, node] of Object.entries(tree.nodes)) {
    const group = tree.groups[String(node.group)] as any;
    if (id === socketNodeId || node.isBlighted || node.isProxy || node.isMastery || !group || group.isProxy || (filter && !filter(node))) continue;
    const pos = getNodePosition(node, resolved);
    if (!pos) throw new Error(`Jewel radius unavailable: node ${id} has incomplete native geometry.`);
    const squared = (socketPos.x - pos.x) ** 2 + (socketPos.y - pos.y) ** 2;
    if (squared <= band.outer ** 2 && squared >= band.inner ** 2) matches.push(id);
  }
  return matches;
}

/** Printed base attributes only; callers must account for allocation/transform semantics. */
export function sumAttributeInRadius(socketNodeId: string, radius: number | RadiusBand, attribute: 'Strength' | 'Dexterity' | 'Intelligence', allocatedNodes?: Set<string>, context: RadiusContext = {}): number {
  const resolved = radiusTree(context);
  let total = 0;
  for (const id of nodesInRadius(socketNodeId, radius, undefined, resolved)) {
    if (allocatedNodes && !allocatedNodes.has(id)) continue;
    for (const stat of resolved.tree.nodes[id].stats ?? []) {
      const match = /^([+-]\d+) to (all Attributes|(?:Strength|Dexterity|Intelligence)(?: and (?:Strength|Dexterity|Intelligence))?)$/.exec(stat);
      if (match && (match[2] === 'all Attributes' || match[2].split(' and ').includes(attribute))) total += Number(match[1]);
    }
  }
  return total;
}
