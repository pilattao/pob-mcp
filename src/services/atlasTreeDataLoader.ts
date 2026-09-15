/**
 * Atlas data, separated by game. PoB2 itself does not ship an atlas graph.
 *
 * PoE2: RePoE's public native PSG2 export, fetched into memory on demand.
 * Source/schema verified against RePoE/parser/poe2/passives.py on 2026-09-15.
 * No dataset, art or user data is written to the checkout or a global cache.
 * The provider's export version (e.g. 4.5.5.2) is NOT a guessed game patch.
 *
 * Offline PoE2 override: POE2_ATLAS_FILE, or ATLASTREE_DIRECTORY/poe2-atlas.json,
 * containing { game: "poe2", version, source, retrievedAt, data: <Atlas.json> }.
 * An explicit file must work on its own; failure never invokes another source.
 * PoE1 retains ATLASTREE_DIRECTORY / reference_data/atlastree and its variants.
 *
 * getAtlasTreeData/getAtlasNode are async because native PoE2 may need HTTPS.
 * Callers must await them. Only atlas handlers consume these APIs in this repo.
 */
import { readFileSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { createHash } from 'crypto';

export type AtlasVariant = 'default' | 'league' | 'ruthless' | 'ruthless-league';
export type AtlasGame = 'poe1' | 'poe2';

export interface AtlasNode {
  skill: number;
  name?: string;
  icon?: string;
  stats?: string[];
  group: number;
  orbit: number;
  orbitIndex: number;
  in?: string[];
  out?: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isJewelSocket?: boolean;
  isMastery?: boolean;
  isAtlasWormhole?: boolean;
  ascendancyName?: string;
  flavourText?: string[];
  reminderText?: string[];
  recipe?: string[];
  /** Native PoE2 subtree ID; the main tree uses its native art ID, Atlas. */
  subtree?: string;
  isAtlasRoot?: boolean;
  isDisplayOnly?: boolean;
  /** Display selector stat IDs do not provide the available or selected effects. */
  hasUnresolvedOptions?: boolean;
  statIds?: Record<string, number>;
  [key: string]: unknown;
}

export interface AtlasGroup {
  x: number;
  y: number;
  orbits?: number[];
  nodes?: string[];
  [key: string]: unknown;
}

export interface AtlasProvenance {
  provider: 'RePoE' | 'local-export';
  transport: 'file' | 'https';
  source: string;
  versionSource?: string;
  localPath?: string;
  retrievedAt: string;
  sha256: string;
  lastModified?: string;
  patches?: { path: string; sha256: string };
}

export interface AtlasTreeData {
  tree: string;
  game: AtlasGame;
  /** Advertised export version, or null for unversioned legacy PoE1 files. */
  version: string | null;
  provenance: AtlasProvenance;
  roots: string[];
  nodes: Record<string, AtlasNode>;
  groups: Record<string, AtlasGroup>;
  constants?: { orbitRadii?: number[]; skillsPerOrbit?: number[]; [key: string]: unknown };
  capabilities: { pathing: 'topology-only'; allocationValidation: false };
  sourceGaps: string[];
  coverage: { nodes: number; displayOnlyNodes: number; pathableNodes: number; edges: number; components: number };
  min_x?: number;
  min_y?: number;
  max_x?: number;
  max_y?: number;
  points?: unknown;
  [key: string]: unknown;
}

const POE2_INDEX = 'https://repoe-fork.github.io/poe2/';
const POE2_SOURCE = POE2_INDEX + 'passive_skill_trees/Atlas.json';
const CACHE_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;
const POE2_GAPS = [
  'Paths are published graph distances only. Quest/boss unlocks, area-level gates, allocation state and point costs are not validated by this export.',
  'Selector descriptions and stat IDs are retained; option effects and selected choices are not supplied.',
  'The version identifies the provider export, not a verified user-facing game patch. Local-file provenance is caller supplied.',
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected an object.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected an array.`);
  return value;
}
function numeric(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}: expected a finite number.`);
  return value;
}
function idString(value: unknown, label: string): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${label}: expected a numeric node ID.`);
  }
  return String(value);
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map(v => {
    if (typeof v !== 'string') throw new Error(`Invalid ${label}: expected text.`);
    return v;
  });
}
function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function displayText(text: string): string {
  return text.replace(/\[(?:[^\]|]*\|)?([^\]]*)\]/g, '$1');
}

function selectedGame(): AtlasGame {
  const game = process.env.POE_GAME || 'poe1';
  if (game !== 'poe1' && game !== 'poe2') throw new Error(`Unknown POE_GAME: ${game}`);
  return game;
}
function validateVariant(game: AtlasGame, variant: AtlasVariant): void {
  if (game === 'poe2' && variant !== 'default') throw new Error(`PoE2 atlas variant '${variant}' is unsupported; only 'default' has a verified native source. No PoE1 fallback is used.`);
  if (!['default', 'league', 'ruthless', 'ruthless-league'].includes(variant)) throw new Error(`Unknown atlas variant: ${variant}`);
}
function searchUpwardForSuite(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pob-mcp', 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function resolveSuiteRoot(): string {
  if (process.env.POE_MCP_SUITE_ROOT) return process.env.POE_MCP_SUITE_ROOT;
  const entry = process.argv[1];
  return (entry && searchUpwardForSuite(dirname(entry))) || searchUpwardForSuite(process.cwd()) || process.cwd();
}
function localPath(game: AtlasGame, variant: AtlasVariant): string | null {
  if (game === 'poe2') {
    if (process.env.POE2_ATLAS_FILE) return resolve(process.env.POE2_ATLAS_FILE);
    return process.env.ATLASTREE_DIRECTORY ? resolve(process.env.ATLASTREE_DIRECTORY, 'poe2-atlas.json') : null;
  }
  const dir = process.env.ATLASTREE_DIRECTORY || join(resolveSuiteRoot(), 'reference_data', 'atlastree');
  return resolve(dir, variant === 'default' ? 'data.json' : `${variant}.json`);
}

/** Normalize declared edges once, including their reverse direction. Never
 * connect subtrees through PoE1's synthetic root or a display-only decoration. */
function indexGraph(data: Omit<AtlasTreeData, 'coverage'>): AtlasTreeData {
  const nodes = data.nodes as Record<string, AtlasNode>;
  for (const [id, node] of Object.entries(nodes)) {
    node.in = [...new Set(node.in ?? [])];
    node.out = [...new Set(node.out ?? [])];
    for (const target of [...node.in, ...node.out]) {
      if (target !== 'root' && !nodes[target]) throw new Error(`Atlas node ${id} references missing node ${target}.`);
    }
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (id === 'root') continue;
    for (const target of node.out!) {
      if (target !== 'root' && !nodes[target].in!.includes(id)) nodes[target].in!.push(id);
    }
    for (const target of node.in!) {
      if (target !== 'root' && !nodes[target].out!.includes(id)) nodes[target].out!.push(id);
    }
  }
  const pathable = new Set(Object.keys(nodes).filter(id => id !== 'root' && !nodes[id].isDisplayOnly));
  const edges = new Set<string>();
  for (const id of pathable) {
    for (const target of [...nodes[id].in!, ...nodes[id].out!]) {
      if (pathable.has(target) && target !== id) edges.add([id, target].sort().join(':'));
    }
  }
  const unseen = new Set(pathable);
  let components = 0;
  while (unseen.size) {
    components++;
    const pending = [unseen.values().next().value!];
    while (pending.length) {
      const id = pending.pop()!;
      if (!unseen.delete(id)) continue;
      for (const target of [...nodes[id].in!, ...nodes[id].out!]) if (unseen.has(target)) pending.push(target);
    }
  }
  return { ...data, coverage: {
    nodes: Object.keys(nodes).filter(id => id !== 'root').length,
    displayOnlyNodes: Object.values(nodes).filter(n => n.isDisplayOnly).length,
    pathableNodes: pathable.size, edges: edges.size, components,
  } } as AtlasTreeData;
}

function normalizePoe2(raw: unknown, version: string, provenance: AtlasProvenance): AtlasTreeData {
  const input = object(raw, 'PoE2 atlas');
  if (object(input.art, 'PoE2 atlas art identity').id !== 'Atlas') throw new Error('Not a native PoE2 Atlas export.');
  const passives = object(input.passives, 'PoE2 passives');
  const groupsRaw = array(input.groups, 'PoE2 groups');
  const roots = array(input.roots, 'PoE2 roots').map(v => idString(v, 'atlas root'));
  if (!roots.length || !groupsRaw.length || !Object.keys(passives).length) throw new Error('Empty native PoE2 atlas graph.');
  const orbitRadii = array(input.orbit_radii, 'PoE2 orbit radii').map(v => numeric(v, 'orbit radius'));
  const skillsPerOrbit = array(input.skills_per_orbit, 'PoE2 skills per orbit').map(v => numeric(v, 'skills per orbit'));
  const nodes: Record<string, AtlasNode> = Object.create(null);
  const groups: Record<string, AtlasGroup> = Object.create(null);
  for (const [id, value] of Object.entries(passives)) {
    const meta = object(value, `PoE2 passive ${id}`);
    if (idString(meta.hash, `hash ${id}`) !== id || typeof meta.is_atlas_root !== 'boolean' ||
      typeof meta.is_icon_only !== 'boolean' || typeof meta.id !== 'string' || typeof meta.name !== 'string') {
      throw new Error(`Invalid native PoE2 passive ${id}.`);
    }
    const statIds = object(meta.stats, `stat IDs for ${id}`);
    for (const [statId, value] of Object.entries(statIds)) numeric(value, `stat ${statId} on ${id}`);
    const rawStats = strings(meta.stat_text, `stat text for ${id}`);
    const subtree = meta.atlas_subtree === undefined ? 'Atlas' : object(meta.atlas_subtree, `subtree of ${id}`).id;
    if (typeof subtree !== 'string' || !subtree) throw new Error(`Invalid subtree for PoE2 node ${id}.`);
    nodes[id] = {
      skill: Number(id), id: meta.id, name: meta.name || meta.id, stats: rawStats.map(displayText),
      rawStats, statIds: statIds as Record<string, number>, subtree,
      group: -1, orbit: 0, orbitIndex: 0, in: [], out: [], placements: [],
      isNotable: meta.is_notable === true, isKeystone: meta.is_keystone === true,
      isJewelSocket: meta.is_jewel_socket === true, isAtlasRoot: meta.is_atlas_root,
      isDisplayOnly: meta.is_icon_only,
      hasUnresolvedOptions: meta.is_multiple_choice === true || meta.is_multiple_choice_option === true ||
        Object.keys(statIds).some(key => key.startsWith('dummy_display_') && key.includes('selector')),
      ...(typeof meta.icon === 'string' ? { icon: meta.icon } : {}),
      reminderText: strings(meta.reminder_text, `reminder text for ${id}`).map(displayText),
      ...(typeof meta.flavour_text === 'string' && meta.flavour_text ? { flavourText: [displayText(meta.flavour_text)] } : {}),
    };
  }
  groupsRaw.forEach((value, index) => {
    const group = object(value, `group ${index}`);
    const groupId = index + 1;
    const groupNodes: string[] = [];
    const orbits = new Set<number>();
    for (const value of array(group.passives, `group ${groupId} passives`)) {
      const placement = object(value, 'passive placement');
      const id = idString(placement.hash, 'placed node');
      const node = nodes[id];
      if (!node) throw new Error(`Missing native PoE2 description for placed node ${id}.`);
      const orbit = numeric(placement.radius, `orbit for ${id}`);
      const orbitIndex = numeric(placement.position_clockwise, `orbit index for ${id}`);
      if (!Number.isInteger(orbit) || orbit < 0 || orbit >= orbitRadii.length ||
        !Number.isInteger(orbitIndex) || orbitIndex < 0 || orbitIndex >= skillsPerOrbit[orbit]) throw new Error(`Invalid PoE2 placement for ${id}.`);
      const connections = array(placement.connections, `connections for ${id}`).map(v => idString(v, `connection of ${id}`));
      const splines = array(placement.splines, `splines for ${id}`).map(v => numeric(v, `spline of ${id}`));
      if (connections.length !== splines.length) throw new Error(`Mismatched PoE2 connections/splines for ${id}.`);
      // Native exports can repeat a decorative hash at different positions.
      // Keep all positions and union edges; do not duplicate the logical node.
      (node.placements as unknown[]).push({ group: groupId, orbit, orbitIndex });
      if (node.group === -1) Object.assign(node, { group: groupId, orbit, orbitIndex });
      node.out!.push(...connections);
      groupNodes.push(id);
      orbits.add(orbit);
    }
    groups[String(groupId)] = { x: numeric(group.x, 'group x'), y: numeric(group.y, 'group y'), nodes: groupNodes, orbits: [...orbits] };
  });
  for (const id of roots) if (!nodes[id]?.isAtlasRoot || nodes[id].isDisplayOnly) throw new Error(`Invalid PoE2 atlas root ${id}.`);
  for (const [id, node] of Object.entries(nodes)) {
    if (node.group === -1) throw new Error(`PoE2 node ${id} has no graph placement.`);
    if (node.isAtlasRoot && !roots.includes(id)) throw new Error(`PoE2 root ${id} is missing from roots.`);
  }
  return indexGraph({ tree: 'Atlas', game: 'poe2', version, provenance, roots, nodes, groups,
    constants: { orbitRadii, skillsPerOrbit }, capabilities: { pathing: 'topology-only', allocationValidation: false },
    sourceGaps: [...POE2_GAPS] });
}

interface FileCache { signature: string; data: AtlasTreeData }
const fileCache = new Map<string, FileCache>();
function fileSignature(path: string): (string | number)[] {
  const stat = statSync(path);
  return [path, stat.mtimeMs, stat.ctimeMs, stat.size];
}
function loadLocal(game: AtlasGame, variant: AtlasVariant, path: string): AtlasTreeData {
  const patchesPath = game === 'poe1' ? join(dirname(path), 'data_patches.json') : undefined;
  const patchesExist = patchesPath && existsSync(patchesPath);
  const signature = JSON.stringify([fileSignature(path), patchesExist ? fileSignature(patchesPath) : null]);
  const key = `${game}:${variant}:${path}`;
  const cached = fileCache.get(key);
  if (cached?.signature === signature) return cached.data;
  const raw = readFileSync(path, 'utf-8');
  const input = object(JSON.parse(raw), `${game} atlas file`);
  let data: AtlasTreeData;
  if (game === 'poe2') {
    if (input.game !== 'poe2') throw new Error('PoE2 local atlas requires a game=poe2 provenance envelope; PoE1 fallback is disabled.');
    if (typeof input.version !== 'string' || !/^\d+(?:\.\d+)+$/.test(input.version)) throw new Error('PoE2 local atlas requires an explicit export version.');
    if (typeof input.source !== 'string' || !/^https:\/\//.test(input.source) ||
      typeof input.retrievedAt !== 'string' || !Number.isFinite(Date.parse(input.retrievedAt))) {
      throw new Error('PoE2 local atlas requires source URL and retrievedAt provenance.');
    }
    data = normalizePoe2(input.data, input.version, { provider: 'RePoE', transport: 'file', source: input.source,
      localPath: path, retrievedAt: input.retrievedAt, sha256: sha256(raw) });
  } else {
    if (input.game === 'poe2' || input.passives || !['Atlas', 'AtlasCurrentLeague'].includes(String(input.tree))) throw new Error('Not a PoE1 atlas export.');
    const nodes = object(input.nodes, 'PoE1 atlas nodes') as unknown as Record<string, AtlasNode>;
    const groups = object(input.groups, 'PoE1 atlas groups') as unknown as Record<string, AtlasGroup>;
    if (!Object.keys(nodes).length) throw new Error('Empty PoE1 atlas graph.');
    const provenance: AtlasProvenance = { provider: 'local-export', transport: 'file', source: path,
      retrievedAt: new Date().toISOString(), sha256: sha256(raw) };
    if (patchesExist) {
      const patchesRaw = readFileSync(patchesPath, 'utf-8');
      const patches = object(JSON.parse(patchesRaw), 'atlas patches');
      for (const [id, value] of Object.entries(patches)) {
        const node = nodes[id];
        if (!node) continue;
        const patch = object(value, `atlas patch ${id}`);
        if (patch.stats_add) node.stats = [...(node.stats ?? []), ...strings(patch.stats_add, 'stats_add')];
        if (patch.stats_replace) node.stats = strings(patch.stats_replace, 'stats_replace');
        if (typeof patch.name_replace === 'string') node.name = patch.name_replace;
        if (patch.flags_set) Object.assign(node, object(patch.flags_set, 'flags_set'));
      }
      provenance.patches = { path: patchesPath, sha256: sha256(patchesRaw) };
    }
    data = indexGraph({ ...input, tree: String(input.tree), game, version: typeof input.version === 'string' ? input.version : null,
      provenance, nodes, groups, roots: nodes.root?.out ?? [], capabilities: { pathing: 'topology-only', allocationValidation: false },
      sourceGaps: ['Allocation state and progression requirements are not validated.'] });
  }
  fileCache.set(key, { signature, data });
  return data;
}

let remoteCache: { data: AtlasTreeData; expiresAt: number } | undefined;
let inFlight: Promise<AtlasTreeData> | undefined;
let lastFailure: { error: Error; retryAt: number } | undefined;
class AtlasSourceError extends Error {
  constructor(message: string, readonly retryAt = Date.now() + FAILURE_RETRY_MS) { super(message); }
}
async function fetchText(url: string): Promise<{ text: string; lastModified?: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error',
    headers: { Accept: url === POE2_SOURCE ? 'application/json' : 'text/html', 'User-Agent': 'pob-mcp-atlas/1.0' } });
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const retryAt = retryAfter && /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '');
    throw new AtlasSourceError(`PoE2 atlas source HTTP ${response.status}: ${url}. No PoE1 fallback is used.`,
      Math.max(Date.now() + FAILURE_RETRY_MS, Number.isFinite(retryAt) ? retryAt : 0));
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new AtlasSourceError(`PoE2 atlas response is unexpectedly large: ${url}`);
  return { text, ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}) };
}
function exportVersion(html: string): string {
  const version = html.match(/<title>\s*RePoE\s*-\s*PoE2 version (\d+(?:\.\d+)+)\s*<\/title>/i)?.[1];
  if (!version) throw new AtlasSourceError('Cannot verify the PoE2 export version from the RePoE index.');
  return version;
}
async function loadRemote(): Promise<AtlasTreeData> {
  if (remoteCache && remoteCache.expiresAt > Date.now()) return remoteCache.data;
  if (inFlight) return inFlight;
  if (lastFailure && lastFailure.retryAt > Date.now()) throw lastFailure.error;
  inFlight = (async () => {
    try {
      const version = exportVersion((await fetchText(POE2_INDEX)).text);
      const source = await fetchText(POE2_SOURCE);
      // Fail if publication changed while fetching; never label a mixed update.
      if (exportVersion((await fetchText(POE2_INDEX)).text) !== version) throw new AtlasSourceError('PoE2 atlas publication version changed during retrieval; retry later.');
      const data = normalizePoe2(JSON.parse(source.text), version, { provider: 'RePoE', transport: 'https', source: POE2_SOURCE,
        versionSource: POE2_INDEX, retrievedAt: new Date().toISOString(), sha256: sha256(source.text),
        ...(source.lastModified ? { lastModified: source.lastModified } : {}) });
      remoteCache = { data, expiresAt: Date.now() + CACHE_MS };
      lastFailure = undefined;
      return data;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastFailure = { error: err, retryAt: err instanceof AtlasSourceError ? err.retryAt : Date.now() + FAILURE_RETRY_MS };
      throw err;
    } finally { inFlight = undefined; }
  })();
  return inFlight;
}

export async function getAtlasTreeData(variant: AtlasVariant = 'default'): Promise<AtlasTreeData> {
  const game = selectedGame();
  validateVariant(game, variant);
  const path = localPath(game, variant);
  return path ? loadLocal(game, variant, path) : loadRemote();
}
export async function getAtlasNode(nodeId: string, variant: AtlasVariant = 'default'): Promise<AtlasNode | null> {
  return (await getAtlasTreeData(variant)).nodes[nodeId] ?? null;
}
/** For HTTPS, exists=null means availability has not been checked by this call. */
export function getAtlasVariantInfo(variant: AtlasVariant = 'default'): { path: string; exists: boolean | null; game: AtlasGame; transport: 'file' | 'https' } {
  const game = selectedGame();
  validateVariant(game, variant);
  const path = localPath(game, variant);
  return { path: path ?? POE2_SOURCE, exists: path ? existsSync(path) : null, game, transport: path ? 'file' : 'https' };
}
