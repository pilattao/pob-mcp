/**
 * PoB Base Item Data Loader
 *
 * Reads PoB community's `Data/Bases/*.lua` (install or source) and exposes
 * every base item as a typed JS object. Each base carries the tag chain
 * needed for accurate mod-roll filtering (e.g. an Astral Plate carries
 * ["armour","body_armour","str_armour","top_tier_base_item_type"]) plus
 * type/subType, requirement (level/str/dex/int), and implicit mod text.
 *
 * Same parse-once-cache pattern as pobModDataLoader. Auto-reloads when any
 * underlying file's mtime changes.
 *
 * Legal: same posture as the tree and mod loaders — PoB redistributes the
 * parsed Lua under their license; we don't extract from Bundles2/.
 */
import { readFileSync, statSync, readdirSync } from "fs";
import { join } from "path";
import luaparse from "luaparse";
import { resolvePobDataLocation } from "./pobDataPath.js";

export interface PobBaseRequirements {
  level?: number;
  str?: number;
  dex?: number;
  int?: number;
}

export interface PobBase {
  /** Display name as it appears in PoE, e.g. "Astral Plate". */
  name: string;
  /** PoB item type, e.g. "Body Armour", "Ring", "One Handed Sword". */
  type: string;
  /**
   * PoB subType (defence/category), e.g. "Armour", "Energy Shield",
   * "Armour/Energy Shield". Not present on every base (e.g. rings,
   * amulets). Empty string when absent.
   */
  subType: string;
  /**
   * The tag chain — what PoE's mod-rolling system uses to decide which
   * mods can roll. Order is as declared in the Lua source. E.g. an
   * Astral Plate is ["armour","body_armour","default","str_armour",
   * "top_tier_base_item_type"]. The "default" tag is always present.
   */
  tags: string[];
  /** Implicit mod text, e.g. "+(8-12)% to all Elemental Resistances". */
  implicit?: string;
  /** Stat/level requirements to equip the base. */
  req: PobBaseRequirements;
  /** Source file slug (e.g. "body", "ring"), useful for diagnostics. */
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Lua AST -> JS (duplicated from sibling loaders to keep modules independent)
// ---------------------------------------------------------------------------

type LuaNode = {
  type: string;
  value?: unknown;
  raw?: string;
  operator?: string;
  argument?: LuaNode;
  fields?: LuaField[];
  name?: string;
  variables?: LuaNode[];
  init?: LuaNode[];
  base?: LuaNode;
  index?: LuaNode;
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

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function basesDir(): string {
  return join(resolvePobDataLocation().dataDir, "Bases");
}

// ---------------------------------------------------------------------------
// File parsing — one base file
// ---------------------------------------------------------------------------

/**
 * Parse a single Bases/*.lua file. The shape is:
 *
 *   local itemBases = ...
 *   itemBases["Plate Vest"] = { type = "Body Armour", tags = {...}, ... }
 *   itemBases["Chestplate"] = { ... }
 *
 * We walk top-level AssignmentStatements where the LHS is an IndexExpression
 * on a name like "itemBases".
 */
function parseBaseFile(path: string, sourceFile: string): PobBase[] {
  const source = readFileSync(path, "utf-8");
  const ast = luaparse.parse(source, { comments: false, ranges: false });
  const body = (ast as { body: LuaNode[] }).body;
  const out: PobBase[] = [];
  for (const stmt of body) {
    if (stmt.type !== "AssignmentStatement") continue;
    const vars = stmt.variables ?? [];
    const inits = stmt.init ?? [];
    if (vars.length !== 1 || inits.length !== 1) continue;
    const lhs = vars[0];
    if (lhs.type !== "IndexExpression") continue;
    const baseId = lhs.base;
    if (!baseId || baseId.type !== "Identifier" || baseId.name !== "itemBases") continue;
    const keyVal = luaToJs(lhs.index);
    if (typeof keyVal !== "string") continue;
    const rhs = luaToJs(inits[0]) as Record<string, unknown> | null;
    if (!rhs || typeof rhs !== "object") continue;

    const type = typeof rhs.type === "string" ? rhs.type : "";
    const subType = typeof rhs.subType === "string" ? rhs.subType : "";
    const implicit = typeof rhs.implicit === "string" ? rhs.implicit : undefined;

    // tags is { tag = true, ... } in Lua; luaToJs gives { tag: true, ... }
    const tagsRaw = (rhs.tags ?? {}) as Record<string, unknown>;
    const tags = Object.keys(tagsRaw).filter((k) => tagsRaw[k] === true);

    const reqRaw = (rhs.req ?? {}) as Record<string, unknown>;
    const req: PobBaseRequirements = {};
    if (typeof reqRaw.level === "number") req.level = reqRaw.level;
    if (typeof reqRaw.str === "number") req.str = reqRaw.str;
    if (typeof reqRaw.dex === "number") req.dex = reqRaw.dex;
    if (typeof reqRaw.int === "number") req.int = reqRaw.int;

    out.push({
      name: keyVal,
      type,
      subType,
      tags,
      implicit,
      req,
      sourceFile,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Includes game, directory, file membership and individual timestamps. */
  signature: string;
  /** All bases indexed by exact name. */
  byName: Map<string, PobBase>;
  /** Same data indexed by lowercase name for case-insensitive lookup. */
  byNameLower: Map<string, PobBase>;
  /** All bases in declaration order (handy for "list all rings"). */
  all: PobBase[];
}

let cached: CacheEntry | null = null;

function load(): CacheEntry {
  const { dataDir, game } = resolvePobDataLocation();
  const dir = join(dataDir, "Bases");
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".lua"))
    .map((d) => d.name)
    .sort();

  // Skip non-equipment files. Flasks, fishing rods, jewels, and tinctures
  // don't take prefix/suffix mods in the same shape as equipment (jewels
  // do, but ModJewel.lua is a separate table — we'll add jewel-base
  // support later).
  const EQUIPMENT_FILES = new Set([
    "amulet.lua", "axe.lua", "belt.lua", "body.lua", "boots.lua",
    "bow.lua", "claw.lua", "dagger.lua", "gloves.lua", "helmet.lua",
    "mace.lua", "quiver.lua", "ring.lua", "shield.lua", "staff.lua",
    "sword.lua", "wand.lua",
  ]);
  // PoB2 base lookup covers every declared category, including crossbows,
  // focuses, spears and non-equipment. A base definition does not establish
  // item-mod eligibility: e.g. jewels/flasks have separate mod tables, and
  // hidden/legacy bases are not an availability list. Keep PoE1's scope.
  const eligible = game === "poe2" ? files : files.filter(f => EQUIPMENT_FILES.has(f));
  const signature = JSON.stringify([game, dir, eligible.map(f => {
    const stat = statSync(join(dir, f));
    return [f, stat.mtimeMs, stat.size];
  })]);
  if (cached && cached.signature === signature) return cached;

  const byName = new Map<string, PobBase>();
  const byNameLower = new Map<string, PobBase>();
  for (const f of eligible) {
    const slug = f.replace(/\.lua$/, "");
    const bases = parseBaseFile(join(dir, f), slug);
    for (const b of bases) {
      byName.set(b.name, b);
      byNameLower.set(b.name.toLowerCase(), b);
    }
  }

  // Lua assignments overwrite prior variants of a base. Searches and counts
  // must use the same final definitions as getBase, not the assignment history.
  const all = Array.from(byName.values());
  if (all.length === 0) throw new Error(`No base definitions found in ${dir}`);
  cached = { signature, all, byName, byNameLower };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function ensureBasesLoaded(): void {
  load();
}

/**
 * Look up a base by exact name (case-insensitive). Returns null if not
 * found. For fuzzy/suggestion matching, use `findBasesMatching`.
 */
export function getBase(name: string): PobBase | null {
  const c = load();
  return c.byNameLower.get(name.toLowerCase()) ?? null;
}

/**
 * Find bases whose name contains the given substring (case-insensitive).
 * Useful when the caller has a partial name or you want to surface
 * suggestions ("did you mean Astral Plate / Eternal Burgonet / ...?").
 */
export function findBasesMatching(query: string, limit = 20): PobBase[] {
  const c = load();
  const q = query.toLowerCase();
  const out: PobBase[] = [];
  for (const b of c.all) {
    if (b.name.toLowerCase().includes(q)) {
      out.push(b);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * All bases sharing a tag. E.g. `getBasesByTag("ring")` returns every
 * ring base. `getBasesByTag("str_armour")` returns every strength-based
 * armour piece.
 */
export function getBasesByTag(tag: string): PobBase[] {
  const c = load();
  return c.all.filter((b) => b.tags.includes(tag));
}

export function getBaseCount(): number {
  return load().all.length;
}

export function getBasesDir(): string {
  return basesDir();
}
