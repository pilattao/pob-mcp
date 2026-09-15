/**
 * PoB Tree Data Loader
 *
 * Reads PoB community's `PathOfBuilding/src/TreeData/{version}/tree.lua` and
 * parses it via luaparse into a JS object. PoB maintains tree.lua for each
 * PoE league, updated via PR. The schema is identical to GGG's published
 * data.json (same readable field names: name, stats, group, orbit, orbitIndex,
 * isNotable, etc.) so consumers can treat the parsed output as a drop-in
 * substitute for GGG's export.
 *
 * Known difference from GGG: PoB renumbers `group` IDs in their own internal
 * order. Node IDs are stable across both; the `group` field is not.
 *
 * Legal: per legal_considerations.md, this only exposes the kind of structural
 * tree data GGG already publishes themselves. Stat description templates,
 * AlternatePassiveSkills tables, and other content-rich game data are not
 * read here.
 */

import { readFileSync, statSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import luaparse from "luaparse";

/**
 * Where a successful tree load came from. Surfaced so callers can warn when
 * we fell back off the primary source.
 *
 *   pob-tree-lua   — preferred. PathOfBuilding/src/TreeData/{ver}/tree.lua.
 *   ggg-data-json  — fallback. reference_data/skilltree/data.json.
 *                     Used only if the PoB submodule is missing or its
 *                     tree.lua failed to parse.
 *
 * Known divergence between the two: PoB renumbers `group` IDs internally.
 * Node IDs and connection IDs (`in`/`out`) are stable across both. Stat
 * descriptions, names, type flags, orbits — all stable.
 */
export type TreeDataSource = "pob-tree-lua" | "ggg-data-json";

export interface PobNode {
  skill: number;
  name: string;
  icon?: string;
  stats: string[];
  group: number;
  orbit: number;
  orbitIndex: number;
  in: string[];
  out: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isJewelSocket?: boolean;
  isMastery?: boolean;
  ascendancyName?: string;
  isAscendancyStart?: boolean;
  recipe?: string[];
  passivePointsGranted?: number;
  isMultipleChoice?: boolean;
  isMultipleChoiceOption?: boolean;
  flavourText?: string[];
  reminderText?: string[];
  spc?: unknown;
  [key: string]: unknown;
}

export interface PobGroup {
  x: number;
  y: number;
  orbits: number[];
  nodes: string[];
  background?: { image?: string; isHalfImage?: boolean; offsetX?: number; offsetY?: number };
}

export interface PobTreeData {
  tree: string;
  classes: unknown[];
  groups: Record<string, PobGroup>;
  nodes: Record<string, PobNode>;
  min_x?: number;
  min_y?: number;
  max_x?: number;
  max_y?: number;
  constants?: unknown;
  points?: unknown;
  jewelSlots?: unknown;
  alternate_ascendancies?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Lua AST -> JS object
// ---------------------------------------------------------------------------

type LuaNode = {
  type: string;
  value?: unknown;
  raw?: string;
  operator?: string;
  argument?: LuaNode;
  fields?: LuaField[];
  name?: string;
};

type LuaField = {
  type: "TableKey" | "TableKeyString" | "TableValue";
  key?: LuaNode | { type: "Identifier"; name: string };
  value: LuaNode;
};

function luaToJs(node: LuaNode | null | undefined): unknown {
  if (!node) return null;
  switch (node.type) {
    case "NumericLiteral":
      return node.value !== null && node.value !== undefined
        ? (node.value as number)
        : Number(node.raw);
    case "StringLiteral": {
      if (node.value !== null && node.value !== undefined) return node.value;
      const raw = node.raw ?? "";
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\");
      }
      const m = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
      if (m) return m[2];
      return raw;
    }
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-") {
        const arg = luaToJs(node.argument);
        return typeof arg === "number" ? -arg : null;
      }
      return null;
    case "TableConstructorExpression": {
      const fields = node.fields ?? [];
      const isSequence =
        fields.length > 0 && fields.every((f) => f.type === "TableValue");
      if (isSequence) {
        return fields.map((f) => luaToJs(f.value));
      }
      const obj: Record<string, unknown> = {};
      let implicitIndex = 1;
      for (const field of fields) {
        if (field.type === "TableKey") {
          const key = luaToJs(field.key as LuaNode);
          obj[String(key)] = luaToJs(field.value);
        } else if (field.type === "TableKeyString") {
          const k = (field.key as { name: string }).name;
          obj[k] = luaToJs(field.value);
        } else if (field.type === "TableValue") {
          obj[String(implicitIndex++)] = luaToJs(field.value);
        }
      }
      return obj;
    }
    default:
      return null;
  }
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    if (!entries.length) return [];
    if (entries.every(([key]) => /^\d+$/.test(key))) {
      return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value);
    }
  }
  return v ? [v] : [];
}

function normalizeNode(raw: Record<string, unknown>): PobNode {
  const out: PobNode = { ...(raw as PobNode) };
  out.stats = asArray(raw.stats) as string[];
  const connections = asArray(raw.connections).map(c => typeof c === 'object' && c !== null ? String((c as { id: unknown }).id) : String(c));
  out.in = raw.in === undefined ? connections : asArray(raw.in).map(String);
  out.out = raw.out === undefined ? connections : asArray(raw.out).map(String);
  if (raw.recipe) out.recipe = asArray(raw.recipe) as string[];
  if (raw.flavourText) out.flavourText = asArray(raw.flavourText) as string[];
  if (raw.reminderText) out.reminderText = asArray(raw.reminderText) as string[];
  return out;
}

function normalizeNodes(rawNodes: Record<string, Record<string, unknown>>): Record<string, PobNode> {
  const nodes = Object.fromEntries(Object.entries(rawNodes).map(([id, node]) => [id, normalizeNode(node)]));
  // PoB2 emits a connection on one endpoint only. The passive graph is undirected.
  for (const [id, raw] of Object.entries(rawNodes)) {
    if (raw.connections === undefined) continue;
    for (const adjacent of nodes[id].out) {
      if (!nodes[adjacent]) continue;
      nodes[adjacent].in = [...new Set([...nodes[adjacent].in, id])];
      nodes[adjacent].out = [...new Set([...nodes[adjacent].out, id])];
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// File resolution + cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  data: PobTreeData;
}

const treeCache = new Map<string, CacheEntry>();

/**
 * Resolve the suite root.
 *
 * `process.cwd()` is unreliable in production — the MCP server is launched
 * by Claude Code from PoB's user-builds directory, not from the suite root.
 * `import.meta.url` would be reliable but is incompatible with our CJS test
 * config (Jest+ts-jest+ESM is fragile to configure).
 *
 * Strategy: walk up from `process.argv[1]` (the entry script). In production
 * the entry is `<suite>/pob-mcp/build/index.js`, so walking up reliably finds
 * the suite. In tests the entry is the jest runner; we fall through to the
 * env-var or cwd fallback.
 *
 * Resolution order:
 *   1. POE_MCP_SUITE_ROOT env var (preferred for explicit configuration)
 *   2. Walk up from `process.argv[1]` looking for a `pob-mcp/package.json` marker
 *   3. Walk up from `process.cwd()` looking for the same marker
 *   4. Last-resort: `process.cwd()` itself (will produce a clear ENOENT)
 */
function searchUpwardForSuite(start: string): string | null {
  let dir = start;
  while (dir && dir !== dirname(dir)) {
    if (existsSync(join(dir, "pob-mcp", "package.json"))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function resolveSuiteRoot(): string {
  if (process.env.POE_MCP_SUITE_ROOT) return process.env.POE_MCP_SUITE_ROOT;
  const entry = process.argv[1];
  if (entry) {
    const found = searchUpwardForSuite(dirname(entry));
    if (found) return found;
  }
  const cwdFound = searchUpwardForSuite(process.cwd());
  if (cwdFound) return cwdFound;
  return process.cwd();
}

/**
 * PathOfBuilding submodule directory. Override with POE_MCP_SUITE_POB_DIR if
 * the submodule isn't at the canonical `<suite>/PathOfBuilding/` location.
 */
function resolvePobDir(): string {
  if (process.env.POB_INSTALL_DIR) return process.env.POB_INSTALL_DIR;
  if (process.env.POE_MCP_SUITE_POB_DIR) return process.env.POE_MCP_SUITE_POB_DIR;
  return join(resolveSuiteRoot(), "PathOfBuilding");
}

function resolveTreeDataDir(pobDir: string): string {
  const installed = join(pobDir, 'TreeData');
  return existsSync(installed) ? installed : join(pobDir, 'src', 'TreeData');
}

/**
 * Find the latest tree version directory under PathOfBuilding/src/TreeData/.
 * Versions are named like `3_28`, `3_27`, etc. We pick the lexically largest.
 */
function findLatestVersion(pobDir: string): string {
  const treeDataDir = resolveTreeDataDir(pobDir);
  const entries = readdirSync(treeDataDir, { withFileTypes: true });
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+_\d+$/.test(n))
    .filter((n) => process.env.POE_GAME !== 'poe2' || n.startsWith('0_'))
    .sort((a, b) => {
      const [aMaj, aMin] = a.split("_").map(Number);
      const [bMaj, bMin] = b.split("_").map(Number);
      if (aMaj !== bMaj) return bMaj - aMaj;
      return bMin - aMin;
    });
  if (versions.length === 0) {
    throw new Error(`No TreeData/X_Y/ directories found under ${treeDataDir}`);
  }
  return versions[0];
}

function treeLuaPath(version?: string): { path: string; version: string } {
  const pobDir = resolvePobDir();
  const ver = version ?? findLatestVersion(pobDir);
  if (process.env.POE_GAME === 'poe2' && !/^0_\d+$/.test(ver)) {
    throw new Error(`Tree version ${ver} does not belong to PoE2`);
  }
  return { path: join(resolveTreeDataDir(pobDir), ver, "tree.lua"), version: ver };
}

// Tracks which source the cached tree came from, for the version most
// recently loaded. Reset on every successful load.
let loadedSource: TreeDataSource = "pob-tree-lua";

function loadFromPobTreeLua(version?: string): { data: PobTreeData; resolvedVersion: string } {
  const { path, version: resolvedVersion } = treeLuaPath(version);
  const stat = statSync(path);
  const cached = treeCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return { data: cached.data, resolvedVersion };
  }

  const source = readFileSync(path, "utf-8");
  const ast = luaparse.parse(source, { comments: false, ranges: false });
  let rootTable: LuaNode | null = null;
  for (const stmt of (ast as { body: { type: string; arguments?: LuaNode[] }[] }).body) {
    if (stmt.type === "ReturnStatement" && stmt.arguments && stmt.arguments[0]) {
      rootTable = stmt.arguments[0];
      break;
    }
  }
  if (!rootTable) {
    throw new Error(`No return statement found in ${path}`);
  }
  const parsed = luaToJs(rootTable) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Failed to parse ${path}: top-level is not an object`);
  }

  const rawNodes = (parsed.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const nodes = normalizeNodes(rawNodes);

  const data: PobTreeData = {
    ...(parsed as PobTreeData),
    nodes,
    groups: Object.fromEntries(Object.entries((parsed.groups ?? {}) as Record<string, Record<string, unknown>>).map(([id, group]) => [id, {
      ...group, nodes: asArray(group.nodes).map(String), orbits: asArray(group.orbits).map(Number),
    }])) as Record<string, PobGroup>,
  };

  treeCache.set(path, { mtimeMs: stat.mtimeMs, data });
  return { data, resolvedVersion };
}

function loadFromGggDataJson(): { data: PobTreeData; resolvedVersion: string } {
  const gggPath = join(resolveSuiteRoot(), "reference_data", "skilltree", "data.json");
  if (!existsSync(gggPath)) {
    throw new Error(`GGG fallback data not found at ${gggPath}`);
  }
  const stat = statSync(gggPath);
  const cacheKey = "__ggg__";
  const cached = treeCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return { data: cached.data, resolvedVersion: "ggg" };
  }
  const raw = readFileSync(gggPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Failed to parse ${gggPath}: top-level is not an object`);
  }

  // GGG's data.json node fields already match PoB's tree.lua shape — same
  // names, same structure. Just normalize array fields like in the PoB path.
  const nodes: Record<string, PobNode> = {};
  const rawNodes = (parsed.nodes ?? {}) as Record<string, Record<string, unknown>>;
  for (const [id, node] of Object.entries(rawNodes)) {
    nodes[id] = normalizeNode(node);
  }

  const data: PobTreeData = {
    ...(parsed as PobTreeData),
    nodes,
    groups: (parsed.groups ?? {}) as Record<string, PobGroup>,
  };
  treeCache.set(cacheKey, { mtimeMs: stat.mtimeMs, data });
  return { data, resolvedVersion: "ggg" };
}

/**
 * Load and parse the passive tree, preferring PoB's tree.lua and falling
 * back to GGG's published data.json if PoB is unavailable.
 *
 * Failure mode: if both sources fail, throws a combined error so the caller
 * knows what went wrong with each path.
 */
export function getPobTreeData(version?: string): PobTreeData {
  try {
    const { data } = loadFromPobTreeLua(version);
    loadedSource = "pob-tree-lua";
    return data;
  } catch (pobErr) {
    if (process.env.POE_GAME === 'poe2' || version?.startsWith('0_')) {
      const message = pobErr instanceof Error ? pobErr.message : String(pobErr);
      throw new Error(`PoE2 tree data unavailable: ${message}. Configure POB_INSTALL_DIR with a PoB2 install; PoE1 fallback is disabled.`);
    }
    try {
      const { data } = loadFromGggDataJson();
      loadedSource = "ggg-data-json";
      // Emit a one-line warning so the calling handler can mention it. Uses
      // stderr so it doesn't pollute MCP JSON output.
      const msg = pobErr instanceof Error ? pobErr.message : String(pobErr);
      process.stderr.write(
        `[pobTreeDataLoader] PoB tree.lua unavailable (${msg}), using GGG data.json fallback\n`
      );
      return data;
    } catch (gggErr) {
      const pobMsg = pobErr instanceof Error ? pobErr.message : String(pobErr);
      const gggMsg = gggErr instanceof Error ? gggErr.message : String(gggErr);
      throw new Error(
        `Both tree data sources failed.\n  PoB tree.lua: ${pobMsg}\n  GGG data.json: ${gggMsg}\nEnsure either the PathOfBuilding submodule or the reference_data/skilltree submodule is checked out.`
      );
    }
  }
}

/**
 * Which source the most-recently-loaded tree data came from. Useful for
 * handlers that want to surface a "fell back to GGG" note in their output.
 */
export function getLoadedSource(): TreeDataSource {
  return loadedSource;
}

/**
 * Look up a single node by ID. Returns null if not found.
 */
export function getPobNode(nodeId: string, version?: string): PobNode | null {
  const tree = getPobTreeData(version);
  return tree.nodes[nodeId] ?? null;
}

/**
 * Look up which PoE version directory we loaded from (for diagnostics).
 */
export function getLoadedVersion(version?: string): string {
  return treeLuaPath(version).version;
}
