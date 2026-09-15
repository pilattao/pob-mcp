/**
 * Timeless jewel identification and geometric candidate scope.
 * Seed/leader parsing does not compute transformations. Native node state is
 * needed to inspect what the installed PoB engine currently reports.
 */

import { nodesInRadius, JEWEL_RADII, getJewelRadius, radiusTree, type RadiusContext } from "./radiusUtils.js";
import { resolvePobDataLocation } from './pobDataPath.js';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import luaparse from 'luaparse';

/** Recognized Timeless jewel families; availability is game-specific. */
export type TimelessJewelType =
  | "Lethal Pride"
  | "Glorious Vanity"
  | "Militant Faith"
  | "Brutal Restraint"
  | "Elegant Hubris"
  | "Heroic Tragedy"
  | "Undying Hate";

const TIMELESS_JEWEL_NAMES: ReadonlySet<string> = new Set<string>([
  "Lethal Pride",
  "Glorious Vanity",
  "Militant Faith",
  "Brutal Restraint",
  "Elegant Hubris",
  "Heroic Tragedy",
  "Undying Hate",
]);

/**
 * Each Timeless Jewel's mod text encodes both a numeric seed and a historic
 * character. We parse the mod text rather
 * than computing the leader algorithmically — the in-game text is the
 * authoritative source for which leader applies.
 *
 * Pattern matches the canonical wordings observed in current PoE.
 */
const SEED_LEADER_PATTERNS: Array<{
  jewelType: TimelessJewelType;
  pattern: RegExp;
}> = [
  {
    // Lethal Pride: "Commanded leadership over N warriors under <Karui leader>"
    jewelType: "Lethal Pride",
    pattern: /Commanded leadership over (\d+) warriors under (\w[\w\s'-]*?)$/m,
  },
  {
    // Glorious Vanity uses blood sacrifices; dekhara is Brutal Restraint.
    jewelType: "Glorious Vanity",
    pattern: /Bathed in the blood of (\d+) sacrificed in the name of (\w[\w\s'-]*?)$/im,
  },
  {
    // Militant Faith: "Carved to glorify N new faithful converted by High Templar <name>"
    jewelType: "Militant Faith",
    pattern: /Carved to glorify (\d+) new faithful converted by High Templar (\w[\w\s'-]*?)$/m,
  },
  {
    // Brutal Restraint: "Denoted service of N dekhara in the akhara of <Maraketh leader>"
    jewelType: "Brutal Restraint",
    pattern: /Denoted service of (\d+) dekhara in the akhara of (\w[\w\s'-]*?)$/m,
  },
  {
    // Elegant Hubris: "Commissioned N coins to commemorate <Eternal leader>"
    jewelType: "Elegant Hubris",
    pattern: /Commissioned (\d+) coins to commemorate (\w[\w\s'-]*?)$/m,
  },
  { jewelType: 'Heroic Tragedy', pattern: /^Remembrancing (\d+) songworthy deeds by the line of (\w[\w\s'-]*?)$/i },
  { jewelType: 'Undying Hate', pattern: /^Glorifying the defilement of (\d+) souls in tribute to (\w[\w\s'-]*?)$/i },
];

export interface TimelessJewelInfo {
  jewelType: TimelessJewelType;
  seed: number;
  historicCharacter: string;
  radiusClass: string;
  radius: number; // numeric units
  game?: 'poe1' | 'poe2';
  conquerorType?: string;
}

function jewelType(name: string): TimelessJewelType | null {
  for (const type of TIMELESS_JEWEL_NAMES) {
    if (name === type || name.startsWith(type + ',') || name.startsWith(type + ' (')) return type as TimelessJewelType;
  }
  return null;
}

const catalogCache = new Map<string, { stamp: string; entries: string[] }>();
function nativeDefinition(type: TimelessJewelType, game: 'poe1' | 'poe2'): string {
  const location = resolvePobDataLocation();
  if (location.game !== game) throw new Error(`Timeless catalog game mismatch: expected ${game}, got ${location.game}.`);
  const file = join(location.dataDir, 'Uniques', 'jewel.lua'), stat = statSync(file), stamp = `${stat.mtimeMs}:${stat.size}`;
  let cached = catalogCache.get(file);
  if (cached?.stamp !== stamp) {
    const ast: any = luaparse.parse(readFileSync(file, 'utf8'), { comments: false, encodingMode: 'x-user-defined' });
    const table = ast.body.find((s: any) => s.type === 'ReturnStatement')?.arguments?.[0];
    if (table?.type !== 'TableConstructorExpression') throw new Error('Native Timeless catalog is unavailable.');
    cached = { stamp, entries: table.fields.filter((f: any) => f.value?.type === 'StringLiteral').map((f: any) => f.value.value) };
    catalogCache.set(file, cached);
  }
  const definition = cached.entries.find(raw => raw.trim().split(/\r?\n/)[0] === type);
  if (!definition) throw new Error(`${type} is absent from the installed ${game} jewel catalog.`);
  return definition;
}

/**
 * Given a jewel's display name and mod text, return Timeless Jewel info if
 * recognized; otherwise null (not a Timeless Jewel).
 *
 * @param jewelName   The jewel's name as shown in-game (e.g., "Lethal Pride").
 * @param mods        The jewel's mod text lines.
 */
export function parseTimelessJewelMod(
  jewelName: string,
  mods: string[],
  context?: RadiusContext
): TimelessJewelInfo | null {
  // First: check if the name itself indicates a Timeless Jewel.
  const matchedType = jewelType(jewelName);
  if (!matchedType) return null;

  // Pick the parser for the matched type and run it against each mod line.
  const matcher = SEED_LEADER_PATTERNS.find((p) => p.jewelType === matchedType);
  if (!matcher) return null;

  const nativeFamily = matchedType === 'Heroic Tragedy' || matchedType === 'Undying Hate';
  const needsTree = context !== undefined || nativeFamily || process.env.POE_GAME === 'poe2';
  const resolved = needsTree ? radiusTree(context) : undefined;
  const game = resolved?.treeVersion.startsWith('0_') ? 'poe2' : 'poe1';
  if (game === 'poe2' && !nativeFamily) throw new Error(`${matchedType} is a PoE1 jewel; PoE2 evaluation requires a verified native counterpart.`);
  const matches = mods.map(line => line.replace(/^(?:\{[^}]+\})+/, '').trim().match(matcher.pattern)).filter((m): m is RegExpMatchArray => m !== null);
  if (!matches.length) return null;
  if (new Set(matches.map(m => `${m[1]}:${m[2]}`)).size !== 1) throw new Error('Timeless seed/leader is ambiguous; select one native item variant.');
  const seed = Number(matches[0][1]), historicCharacter = matches[0][2].trim();
  if (!Number.isSafeInteger(seed) || seed < 1) throw new Error('Invalid Timeless seed.');
  if (nativeFamily) {
    const definition = nativeDefinition(matchedType, game);
    const variants = definition.split(/\r?\n/).flatMap(line => {
      const range = /\((\d+)-(\d+)\)/.exec(line);
      if (!range) return [];
      const parsed = line.replace(/^(?:\{[^}]+\})+/, '').replace(range[0], range[1]).trim().match(matcher.pattern);
      return parsed ? [{ leader: parsed[2].trim(), min: Number(range[1]), max: Number(range[2]) }] : [];
    });
    const variant = variants.find(v => v.leader.toLowerCase() === historicCharacter.toLowerCase());
    if (!variant) throw new Error(`Leader ${historicCharacter} is unavailable in the installed ${game} ${matchedType} catalog.`);
    if (seed < variant.min || seed > variant.max) throw new Error(`Seed ${seed} is outside the native catalog range ${variant.min}-${variant.max}.`);
    const radiusClass = /^Radius:\s*(.+)$/im.exec(definition)?.[1].trim();
    if (!radiusClass) throw new Error('Native Timeless radius is unavailable.');
    return { jewelType: matchedType, seed, historicCharacter: variant.leader, game,
      conquerorType: matchedType === 'Heroic Tragedy' ? 'kalguur' : 'abyss', radiusClass: radiusClass.toLowerCase(), radius: getJewelRadius(radiusClass, resolved).outer };
  }
  return {
        jewelType: matchedType,
        seed,
        historicCharacter,
        radiusClass: "large",
        radius: JEWEL_RADII.large,
        game,
      };
}

/**
 * Identifies which Timeless Jewels (if any) are in a set of equipped jewels,
 * and identifies geometric candidates around each allocated socket.
 *
 * @param equippedJewels  Array of (socket_node_id, name, mods) describing each
 *                        jewel currently socketed in the tree.
 * @param allocatedNodes  The set of allocated node IDs (used to filter results
 *                        to the selected weapon set. Unallocated candidates
 *                        are reported separately; no transformation is inferred).
 */
export interface JewelSocketInfo {
  socketNodeId: string;
  jewelName: string;
  mods: string[];
}

export interface AffectedNodeRecord {
  nodeId: string;
  affectingJewels: Array<{
    socketNodeId: string;
    jewel: TimelessJewelInfo;
  }>;
}

export interface FindAffectedResult {
  timelessJewels: Array<{
    socketNodeId: string;
    jewel: TimelessJewelInfo;
    affectedAllocated: string[];
    affectedUnallocated: string[];
    active: boolean;
  }>;
  /** Per-node geometric candidates; native conquest and transformed stats are separate evidence. */
  byNode: Record<string, AffectedNodeRecord>;
  unresolvedJewels: Array<{ socketNodeId: string; jewelName: string; reason: string }>;
  notes: string[];
}

export function findAffectedNodes(
  equippedJewels: JewelSocketInfo[],
  allocatedNodes: Set<string>,
  context: RadiusContext = {}
): FindAffectedResult {
  const result: FindAffectedResult = {
    timelessJewels: [],
    byNode: {},
    unresolvedJewels: [],
    notes: ['Radius matches are geometric candidates. Seed-dependent transformations are not calculated by this service.'],
  };

  for (const j of equippedJewels) {
    if (!jewelType(j.jewelName) && !j.mods.some(m => /^(?:Historic|Timeless Jewel)$/i.test(m))) continue;
    let info: TimelessJewelInfo | null;
    let inRadius: string[];
    try {
      const resolved = radiusTree(context);
      info = parseTimelessJewelMod(j.jewelName, j.mods, resolved);
      if (!info) throw new Error('Timeless identity or seed/leader data is missing or unsupported.');
      inRadius = nodesInRadius(j.socketNodeId, info.radius, node => !node.classesStart && !node.isJewelSocket && !node.ascendancyName, resolved);
    } catch (error) {
      result.unresolvedJewels.push({ socketNodeId: j.socketNodeId, jewelName: j.jewelName, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const active = allocatedNodes.has(j.socketNodeId);
    const affectedAllocated: string[] = [];
    const affectedUnallocated: string[] = [];
    for (const nodeId of active ? inRadius : []) {
      if (allocatedNodes.has(nodeId)) {
        affectedAllocated.push(nodeId);
        if (!result.byNode[nodeId]) {
          result.byNode[nodeId] = { nodeId, affectingJewels: [] };
        }
        result.byNode[nodeId].affectingJewels.push({
          socketNodeId: j.socketNodeId,
          jewel: info,
        });
      } else {
        affectedUnallocated.push(nodeId);
      }
    }
    result.timelessJewels.push({
      socketNodeId: j.socketNodeId,
      jewel: info,
      active,
      affectedAllocated,
      affectedUnallocated,
    });
  }
  if (result.timelessJewels.filter(j => j.active).length > 1) result.notes.push('Multiple Historic jewels are socketed; native jewel limits and overlap resolution must be checked.');
  return result;
}
