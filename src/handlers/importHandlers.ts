/**
 * Character Import Handlers
 *
 * Bridge between the official PoE character API (HTTP, on the Node side) and
 * the Lua import handlers (`import_passive_tree`, `import_items_skills`).
 *
 * PoB headless cannot make HTTP requests itself (lcurl is disabled), so this
 * module fetches the JSON bodies from pathofexile.com and forwards them to
 * the Lua side for the actual import.
 */

import type { LuaHandlerContext } from "./luaHandlers.js";
import {
  fetchCharacterList,
  fetchPassiveSkills,
  fetchItems,
  type PoeRealm,
  type PoeCharacterListEntry,
} from "../services/poeCharacterApi.js";
import { wrapHandler } from "../utils/errorHandling.js";
import { handleGetBuildIssues } from "./buildGoalsHandlers.js";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

/** Options accepted by `handleImportCharacter`, mirroring the PoB GUI defaults. */
export interface ImportCharacterOptions {
  /** Entire PoB2 public export, taken from get_character_pob.pob_xml. */
  pobXml?: string;
  clearJewels?: boolean;
  clearItems?: boolean;
  clearSkills?: boolean;
  ignoreWeaponSwap?: boolean;
  /** Bandit choice: "None" (Kill All), "Alira", "Kraityn", or "Oak". */
  bandit?: string;
}

/** Subset of the LuaHandlerContext that import handlers actually need. */
export type ImportHandlerContext = Pick<
  LuaHandlerContext,
  "getLuaClient" | "ensureLuaClient"
>;

const CLASS_NAMES: Record<number, string> = {
  0: "Scion",
  1: "Marauder",
  2: "Ranger",
  3: "Witch",
  4: "Duelist",
  5: "Templar",
  6: "Shadow",
};

const ASCENDANCY_NAMES: Record<number, Record<number, string>> = {
  0: { 1: "Ascendant" },
  1: { 1: "Juggernaut", 2: "Berserker", 3: "Chieftain" },
  2: { 1: "Raider", 2: "Deadeye", 3: "Pathfinder" },
  3: { 1: "Occultist", 2: "Elementalist", 3: "Necromancer" },
  4: { 1: "Slayer", 2: "Gladiator", 3: "Champion" },
  5: { 1: "Inquisitor", 2: "Hierophant", 3: "Guardian" },
  6: { 1: "Assassin", 2: "Trickster", 3: "Saboteur" },
};

// Reverse-map the API's `class` field (which is the ascendancy name) to the
// base class. The PoE get-characters endpoint does NOT return classId.
const ASCENDANCY_TO_BASE_CLASS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [classIdStr, ascObj] of Object.entries(ASCENDANCY_NAMES)) {
    const baseClass = CLASS_NAMES[Number(classIdStr)];
    if (!baseClass) continue;
    for (const ascName of Object.values(ascObj)) {
      map[ascName] = baseClass;
    }
  }
  // Also include base-class names so an unascended character maps to itself.
  for (const baseClass of Object.values(CLASS_NAMES)) {
    map[baseClass] = baseClass;
  }
  return map;
})();

function classLabel(entry: PoeCharacterListEntry): string {
  if (typeof entry.class === "string" && entry.class) return entry.class;
  if (typeof entry.classId === "number") return CLASS_NAMES[entry.classId] ?? `Class ${entry.classId}`;
  return "Unknown";
}

function baseClassFor(entry: PoeCharacterListEntry): string {
  const ascOrClass = classLabel(entry);
  return ASCENDANCY_TO_BASE_CLASS[ascOrClass] ?? "Unknown";
}

function ascendancyLabel(entry: PoeCharacterListEntry): string {
  const ascOrClass = classLabel(entry);
  const base = ASCENDANCY_TO_BASE_CLASS[ascOrClass];
  if (!base) return "Unknown";
  // If `class` IS a base class, the character has no ascendancy yet.
  if (base === ascOrClass) return "None";
  return ascOrClass;
}

function resolveAccountName(accountName: string | undefined): string {
  const explicit = accountName?.trim();
  if (explicit) return explicit;

  const fromEnv = process.env.POE_ACCOUNT_NAME?.trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    "account_name is required (with discriminator, e.g. account#1234), or set POE_ACCOUNT_NAME"
  );
}

function formatLastLogin(unixSeconds: number | undefined, nowMs: number): string {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) return "?";
  const ms = unixSeconds * 1000;
  const date = new Date(ms);
  const iso = date.toISOString().slice(0, 16).replace("T", " ");
  const deltaMs = nowMs - ms;
  if (deltaMs < 0) return `${iso} UTC (future?)`;
  const deltaMin = Math.floor(deltaMs / 60_000);
  let rel: string;
  if (deltaMin < 60) rel = `${deltaMin}m ago`;
  else if (deltaMin < 60 * 24) rel = `${Math.floor(deltaMin / 60)}h ago`;
  else rel = `${Math.floor(deltaMin / (60 * 24))}d ago`;
  return `${iso} UTC (${rel})`;
}

/**
 * List all characters on a PoE account.
 * Does NOT require the Lua bridge to be running — purely an HTTP call.
 */
export async function handleListCharacters(
  _context: ImportHandlerContext,
  accountName?: string,
  realm?: string
) {
  return wrapHandler("list characters", async () => {
    const accountTrimmed = resolveAccountName(accountName);

    const effectiveRealm = (realm ?? "pc") as PoeRealm;
    const characters = await fetchCharacterList(accountTrimmed, effectiveRealm);

    if (characters.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No characters found on account "${accountTrimmed}" (realm: ${effectiveRealm}).\n\n` +
              `Tips:\n` +
              `- Make sure the account name includes the discriminator (e.g. account#1234).\n` +
              `- If the profile is private, set POE_SESSION_ID env var.`,
          },
        ],
      };
    }

    // Sort by last-login descending so the active character is on top.
    const sorted = [...characters].sort((a, b) => {
      const ta = typeof a.lastLoginTime === "number" ? a.lastLoginTime : 0;
      const tb = typeof b.lastLoginTime === "number" ? b.lastLoginTime : 0;
      return tb - ta;
    });

    // Render a markdown table with all fields the API actually returns.
    const lines: string[] = [];
    lines.push(`=== Characters on ${accountTrimmed} ===`);
    lines.push("");
    lines.push(`| Name | Level | Class | Ascendancy | League | Realm | Last Login | Pinnable |`);
    lines.push(`|------|-------|-------|------------|--------|-------|------------|----------|`);
    const nowMs = Date.now();
    for (const c of sorted) {
      const level = typeof c.level === "number" ? String(c.level) : "?";
      const base = baseClassFor(c);
      const asc = ascendancyLabel(c);
      const league = typeof c.league === "string" ? c.league : "?";
      const realm = typeof c.realm === "string" ? c.realm : "?";
      const lastLogin = formatLastLogin(c.lastLoginTime, nowMs);
      let pinnable: string = "?";
      if (typeof c.pinnable === "boolean") pinnable = c.pinnable ? "yes" : "no";
      lines.push(`| ${c.name} | ${level} | ${base} | ${asc} | ${league} | ${realm} | ${lastLogin} | ${pinnable} |`);
    }
    lines.push("");
    lines.push(`Total: ${characters.length} character(s). Sorted by most recent login.`);
    lines.push(
      `Use lua_import_character with account_name + character_name to import one into the loaded build.`
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  });
}

/**
 * A snapshot of the build state captured before/after import so we can
 * compute a diff and show the user what actually changed.
 */
interface BuildSnapshot {
  level: number | null;
  className: string | null;
  ascendClassName: string | null;
  treeNodeCount: number;
  stats: Record<string, number>;
  // slot name → item summary
  itemsBySlot: Record<string, { name: string; baseName?: string; rarity?: string }>;
  socketGroups: Array<{
    index: number;
    label: string;
    slot: string;
    gems: Array<{ name: string; level: number; quality: number }>;
  }>;
}

/** Stat keys we surface in the diff — kept short, focused on actionable numbers. */
const DIFF_STATS: ReadonlyArray<{ key: string; label: string; pct?: boolean }> = [
  { key: "Life", label: "Life" },
  { key: "EnergyShield", label: "ES" },
  { key: "Mana", label: "Mana" },
  { key: "TotalEHP", label: "EHP" },
  { key: "Armour", label: "Armour" },
  { key: "Evasion", label: "Evasion" },
  { key: "FireResist", label: "Fire Res", pct: true },
  { key: "ColdResist", label: "Cold Res", pct: true },
  { key: "LightningResist", label: "Light Res", pct: true },
  { key: "ChaosResist", label: "Chaos Res", pct: true },
  { key: "BlockChance", label: "Block", pct: true },
  { key: "EffectiveSpellSuppressionChance", label: "Spell Supp", pct: true },
];

async function captureBuildSnapshot(
  luaClient: import("../pobLuaBridge.js").AnyLuaClient
): Promise<BuildSnapshot> {
  // The bridge does not support concurrent requests (single-threaded stdio),
  // so we MUST call these sequentially, not via Promise.all.
  const info = await luaClient.getBuildInfo().catch(() => null);
  const stats = await luaClient.getStats().catch(() => ({}));
  const items = await luaClient.getItems().catch(() => []);
  const skills = await luaClient.getSkills().catch(() => null);
  const tree = await luaClient.getTree().catch(() => null);

  const itemsBySlot: BuildSnapshot["itemsBySlot"] = {};
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const slot = typeof it.slot === "string" ? it.slot : null;
      const name = typeof it.name === "string" ? it.name : null;
      if (!slot || !name) continue;
      // PoB returns id=0 for empty slot entries.
      if (it.id === 0) continue;
      itemsBySlot[slot] = {
        name,
        baseName: typeof it.baseName === "string" ? it.baseName : undefined,
        rarity: typeof it.rarity === "string" ? it.rarity : undefined,
      };
    }
  }

  const socketGroups: BuildSnapshot["socketGroups"] = [];
  if (skills && Array.isArray(skills.groups)) {
    for (const g of skills.groups) {
      if (!g || typeof g !== "object") continue;
      const gemList: BuildSnapshot["socketGroups"][number]["gems"] = [];
      if (Array.isArray(g.gems)) {
        for (const gem of g.gems) {
          if (!gem || typeof gem.name !== "string") continue;
          gemList.push({
            name: gem.name,
            level: typeof gem.level === "number" ? gem.level : 0,
            quality: typeof gem.quality === "number" ? gem.quality : 0,
          });
        }
      }
      socketGroups.push({
        index: typeof g.index === "number" ? g.index : 0,
        label: typeof g.label === "string" ? g.label : "",
        slot: typeof g.slot === "string" ? g.slot : "",
        gems: gemList,
      });
    }
  }

  return {
    level: info && typeof info.level === "number" ? info.level : null,
    className: info && typeof info.className === "string" ? info.className : null,
    ascendClassName:
      info && typeof info.ascendClassName === "string" ? info.ascendClassName : null,
    treeNodeCount: tree && Array.isArray(tree.nodes) ? tree.nodes.length : 0,
    stats: (stats as Record<string, number>) || {},
    itemsBySlot,
    socketGroups,
  };
}

function fmtNum(n: number, pct: boolean | undefined): string {
  if (!Number.isFinite(n)) return "?";
  if (pct) return `${Math.round(n)}%`;
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString("en-US");
  return Math.round(n * 10) / 10 + "";
}

function fmtDelta(delta: number, pct: boolean | undefined): string {
  if (delta === 0) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${fmtNum(delta, pct)}`;
}

function buildStatsDiff(before: BuildSnapshot, after: BuildSnapshot): string[] {
  const lines: string[] = [];
  lines.push(`| Stat | Before | After | Δ |`);
  lines.push(`|------|--------|-------|---|`);
  for (const { key, label, pct } of DIFF_STATS) {
    const b = Number(before.stats[key] ?? 0);
    const a = Number(after.stats[key] ?? 0);
    if (b === 0 && a === 0) continue;
    const delta = a - b;
    const indicator = delta > 0 ? "▲" : delta < 0 ? "▼" : "=";
    lines.push(
      `| ${label} | ${fmtNum(b, pct)} | ${fmtNum(a, pct)} | ${indicator} ${fmtDelta(delta, pct)} |`
    );
  }
  return lines;
}

function buildItemsDiff(before: BuildSnapshot, after: BuildSnapshot): string[] {
  const lines: string[] = [];
  const slots = new Set<string>([
    ...Object.keys(before.itemsBySlot),
    ...Object.keys(after.itemsBySlot),
  ]);
  const orderedSlots = Array.from(slots).sort((a, b) => a.localeCompare(b));

  const added: string[] = [];
  const removed: string[] = [];
  const replaced: string[] = [];
  const unchanged: string[] = [];

  for (const slot of orderedSlots) {
    const b = before.itemsBySlot[slot];
    const a = after.itemsBySlot[slot];
    if (!b && a) added.push(`+ **${slot}**: ${a.name}${a.rarity ? ` (${a.rarity})` : ""}`);
    else if (b && !a) removed.push(`- **${slot}**: ${b.name}${b.rarity ? ` (${b.rarity})` : ""}`);
    else if (b && a) {
      if (b.name !== a.name || b.baseName !== a.baseName) {
        replaced.push(`~ **${slot}**: ${b.name} → ${a.name}`);
      } else {
        unchanged.push(slot);
      }
    }
  }

  lines.push(`Items: ${added.length} added, ${removed.length} removed, ${replaced.length} replaced, ${unchanged.length} unchanged.`);
  if (added.length || removed.length || replaced.length) {
    lines.push("");
    if (added.length) {
      lines.push("**Added:**");
      lines.push(...added);
    }
    if (removed.length) {
      if (added.length) lines.push("");
      lines.push("**Removed:**");
      lines.push(...removed);
    }
    if (replaced.length) {
      if (added.length || removed.length) lines.push("");
      lines.push("**Replaced (same slot):**");
      lines.push(...replaced);
    }
  }
  return lines;
}

function gemSignature(g: { name: string; level: number; quality: number }): string {
  return `${g.name} ${g.level}/${g.quality}`;
}

function buildSkillsDiff(before: BuildSnapshot, after: BuildSnapshot): string[] {
  const lines: string[] = [];
  const totalBefore = before.socketGroups.length;
  const totalAfter = after.socketGroups.length;
  const totalGemsBefore = before.socketGroups.reduce((acc, g) => acc + g.gems.length, 0);
  const totalGemsAfter = after.socketGroups.reduce((acc, g) => acc + g.gems.length, 0);

  lines.push(
    `Socket groups: ${totalBefore} → ${totalAfter} (${fmtDelta(totalAfter - totalBefore, false)}). ` +
      `Gems total: ${totalGemsBefore} → ${totalGemsAfter} (${fmtDelta(totalGemsAfter - totalGemsBefore, false)}).`
  );

  // Try to match groups by label+slot. If too noisy, just show overall.
  const beforeKeys = new Set(before.socketGroups.map((g) => `${g.label}|${g.slot}`));
  const afterKeys = new Set(after.socketGroups.map((g) => `${g.label}|${g.slot}`));
  const removedGroups = before.socketGroups.filter((g) => !afterKeys.has(`${g.label}|${g.slot}`));
  const addedGroups = after.socketGroups.filter((g) => !beforeKeys.has(`${g.label}|${g.slot}`));

  if (removedGroups.length || addedGroups.length) {
    lines.push("");
    if (removedGroups.length) {
      lines.push(`**Removed groups (${removedGroups.length}):**`);
      for (const g of removedGroups) {
        lines.push(`- ${g.label || "(no label)"} [${g.slot}]: ${g.gems.map(gemSignature).join(", ") || "no gems"}`);
      }
    }
    if (addedGroups.length) {
      if (removedGroups.length) lines.push("");
      lines.push(`**Added groups (${addedGroups.length}):**`);
      for (const g of addedGroups) {
        lines.push(`+ ${g.label || "(no label)"} [${g.slot}]: ${g.gems.map(gemSignature).join(", ") || "no gems"}`);
      }
    }
  }
  return lines;
}

/**
 * Import a character from the official PoE API into the currently loaded
 * Lua-bridge build. Replaces tree, jewels, items, and skill gems.
 *
 * Captures a before/after snapshot and reports stat deltas + item/gem changes
 * so the user can verify the import did what they expected.
 */
export async function handleImportCharacter(
  context: ImportHandlerContext,
  accountName: string | undefined,
  characterName: string,
  realm?: string,
  options?: ImportCharacterOptions
) {
  return wrapHandler("import character", async () => {
    if (process.env.POE_GAME === 'poe2') {
      if (typeof options?.pobXml !== 'string' || !options.pobXml.trim()) {
        throw new Error('PoE2 public import: call get_character_pob and pass its pob_xml field; PoE1 character-window endpoints are not a PoE2 source');
      }
      if (accountName !== undefined || realm !== undefined ||
          Object.entries(options).some(([key,value]) => key !== 'pobXml' && value !== undefined)) {
        throw new Error('A complete PoB2 XML snapshot replaces the whole build; account lookup and selective import options do not apply');
      }
      await context.ensureLuaClient();
      const client = context.getLuaClient();
      if (!client) throw new Error('Lua client not initialized');
      const title = characterName?.trim() || 'Public PoE2 Snapshot';
      await client.loadBuildXml(options.pobXml, title);
      return {content:[{type:'text' as const,text:`✅ Public PoE2 snapshot loaded as "${title}". Complete XML preserved, including its item, skill, tree and configuration sets.`}]};
    }
    if (options?.pobXml !== undefined) throw new Error('pob_xml import requires PoE2 mode');
    const accountTrimmed = resolveAccountName(accountName);
    if (!characterName || !characterName.trim()) {
      throw new Error("character_name is required");
    }

    const effectiveRealm = (realm ?? "pc") as PoeRealm;
    const charTrimmed = characterName.trim();

    // 1. Bridge required — must have a build loaded for items/tree to attach to.
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error("Lua client not initialized");
    }

    const buildInfo = await luaClient.getBuildInfo().catch(() => null);
    if (!buildInfo) {
      throw new Error("No build loaded. Use lua_load_build or lua_new_build first.");
    }

    // Resolve defaults to match the PoB GUI behavior.
    const clearJewels = options?.clearJewels ?? true;
    const clearItems = options?.clearItems ?? true;
    const clearSkills = options?.clearSkills ?? true;
    const ignoreWeaponSwap = options?.ignoreWeaponSwap ?? false;
    const bandit = options?.bandit ?? null;

    // 2. Fetch passive skills + items + character list in parallel.
    //    The list is needed only for `name`, `level`, `league`, and the
    //    ascendancy name (returned in `class`); the actual classId / ascendId
    //    come from the passive-skills JSON itself, not from this list.
    //    See ImportTab.lua:709 for the canonical contract — `charData` only
    //    needs `name`, `level`, `class`, and `league`.
    const [passiveJson, itemsJson, characters] = await Promise.all([
      fetchPassiveSkills(accountTrimmed, charTrimmed, effectiveRealm),
      fetchItems(accountTrimmed, charTrimmed, effectiveRealm),
      fetchCharacterList(accountTrimmed, effectiveRealm),
    ]);

    // 3. Find this character in the list to build char_data.
    const charMeta = characters.find(
      (c) => typeof c.name === "string" && c.name === charTrimmed
    );
    if (!charMeta) {
      throw new Error(
        `Character "${charTrimmed}" not found on account "${accountTrimmed}" (realm: ${effectiveRealm}). ` +
          `Use lua_list_characters to see available characters.`
      );
    }

    // 3b. Refuse to apply an empty payload. The PoE API can return HTTP 200 with
    // empty/false bodies (expired POESESSID, profile privacy, or a GGG incident)
    // while the character LIST still works. Applying that "success" wipes every
    // item, gem, and passive from the loaded build — observed 2026-08-23: a
    // level-97 character imported as 0 nodes / 0 items / 0 gems, twice, and only
    // the on-disk save prevented data loss. A real character above level 2 always
    // has passives and items; an empty pair is an auth/API failure, never a build.
    const levelForSanity = typeof charMeta.level === "number" ? charMeta.level : 99;
    if (levelForSanity > 2) {
      let passiveCount = -1;
      let itemCount = -1;
      try {
        const p = JSON.parse(passiveJson);
        passiveCount = Array.isArray(p?.hashes) ? p.hashes.length : 0;
      } catch { /* unparseable = not a real payload; counts stay -1 */ }
      try {
        const it = JSON.parse(itemsJson);
        itemCount = Array.isArray(it?.items) ? it.items.length : 0;
      } catch { /* as above */ }
      if (passiveCount <= 0 && itemCount <= 0) {
        throw new Error(
          `PoE API returned an EMPTY character payload for level-${levelForSanity} "${charTrimmed}" ` +
            `(passives: ${Math.max(passiveCount, 0)}, items: ${Math.max(itemCount, 0)}) — refusing to import, ` +
            `as applying it would wipe the loaded build. The character list still resolving while content ` +
            `endpoints return nothing usually means the POE_SESSION_ID has expired (get a fresh POESESSID ` +
            `cookie from pathofexile.com and update the MCP config), the profile's Characters tab was made ` +
            `private, or the PoE API is having an incident. The loaded build is untouched.`
        );
      }
    }

    const charDataForLua = {
      name: charMeta.name,
      level: typeof charMeta.level === "number" ? charMeta.level : 1,
      class: classLabel(charMeta),
      league: typeof charMeta.league === "string" ? charMeta.league : "Standard",
    };

    // 4. Snapshot the build state BEFORE applying the import.
    const before = await captureBuildSnapshot(luaClient);

    // 5. Apply imports — sequential because the Lua bridge is single-request.
    //    A failure between the tree and items calls leaves the build in a
    //    partial state (new tree, old items). Surface that explicitly so the
    //    user knows they should `lua_reload_build` to revert.
    try {
      await luaClient.importPassiveTree({
        json: passiveJson,
        char_data: charDataForLua,
        clear_jewels: clearJewels,
      });
    } catch (err) {
      throw new Error(
        `import_passive_tree failed: ${(err as Error).message}. The build is unchanged — no rollback needed.`
      );
    }

    try {
      await luaClient.importItemsSkills({
        json: itemsJson,
        clear_items: clearItems,
        clear_skills: clearSkills,
        ignore_weapon_swap: ignoreWeaponSwap,
      });
    } catch (err) {
      throw new Error(
        `import_items_skills failed after the passive tree was already imported: ${(err as Error).message}. ` +
          `The build is in a PARTIAL state (new tree, old items). Run lua_reload_build to revert to the on-disk state, ` +
          `or lua_save_build to a new filename to keep the partial state.`
      );
    }

    // 5b. Apply bandit choice if provided — not available from the PoE API.
    if (bandit !== null) {
      try {
        await luaClient.setConfig({ bandit });
      } catch {
        // Non-fatal — report in output but don't fail the import.
      }
    }

    // 5c. Append an import summary to the Notes tab so future sessions can
    //     read back bandit choice, quest status, and other non-API data
    //     without having to ask the user again.
    try {
      const existingNotes = await luaClient.getNotes();
      const importDate = new Date().toISOString().slice(0, 10);
      const banditLine = bandit !== null
        ? `Bandit: ${bandit === 'None' ? 'Kill All (None)' : bandit}`
        : 'Bandit: NOT SET — ask user (Kill All / Alira / Kraityn / Oak)';
      const newSection =
        `\n--- Imported from PoE API: ${importDate} ---\n` +
        `Character: ${charDataForLua.name} (Level ${charDataForLua.level} ${baseClassFor(charMeta)}` +
          (ascendancyLabel(charMeta) !== 'None' ? ` / ${ascendancyLabel(charMeta)}` : '') +
          `, ${charDataForLua.league})\n` +
        `${banditLine}\n` +
        `Quest passives: Verify in-game (24 pts from quests across Acts in PoE1)\n` +
        `Pantheon: NOT SET — configure in PoB Config tab\n` +
        `---`;
      await luaClient.setNotes((existingNotes + newSection).trim());
    } catch {
      // Non-fatal — notes are a convenience, don't fail the import.
    }

    // 6. Snapshot AFTER and compute the diff.
    const after = await captureBuildSnapshot(luaClient);

    // 7. Format the report.
    const ascLabel = ascendancyLabel(charMeta);
    const baseClass = baseClassFor(charMeta);
    const importedParts: string[] = ["passive tree"];
    if (clearJewels) importedParts.push("jewels");
    if (clearItems) importedParts.push("items");
    if (clearSkills) importedParts.push("skill gems");
    if (ignoreWeaponSwap) importedParts.push("(ignored weapon swap items)");

    const lines: string[] = [];
    lines.push(`# Import: "${charDataForLua.name}"`);
    lines.push("");
    lines.push(
      `Level ${charDataForLua.level} ${baseClass}${ascLabel !== "None" ? ` (${ascLabel})` : ""} — ${charDataForLua.league} (${effectiveRealm})`
    );
    lines.push("");
    lines.push(`Replaced from PoE API: ${importedParts.join(", ")}.`);

    // Class / ascendancy / level deltas (most often unchanged but worth showing).
    if (
      before.level !== after.level ||
      before.className !== after.className ||
      before.ascendClassName !== after.ascendClassName
    ) {
      lines.push("");
      lines.push(`## Build identity`);
      lines.push(
        `Level: ${before.level ?? "?"} → ${after.level ?? "?"} (${fmtDelta((after.level ?? 0) - (before.level ?? 0), false)})`
      );
      lines.push(
        `Class: ${before.className ?? "?"} → ${after.className ?? "?"}`
      );
      lines.push(
        `Ascendancy: ${before.ascendClassName ?? "?"} → ${after.ascendClassName ?? "?"}`
      );
    }

    // Tree node count.
    const treeDelta = after.treeNodeCount - before.treeNodeCount;
    lines.push("");
    lines.push(`## Passive tree`);
    lines.push(
      `Allocated nodes: ${before.treeNodeCount} → ${after.treeNodeCount} (${fmtDelta(treeDelta, false)})`
    );

    // Stats diff.
    lines.push("");
    lines.push(`## Stats`);
    lines.push(...buildStatsDiff(before, after));

    // Items diff.
    lines.push("");
    lines.push(`## Items`);
    lines.push(...buildItemsDiff(before, after));

    // Skills diff.
    lines.push("");
    lines.push(`## Skills`);
    lines.push(...buildSkillsDiff(before, after));

    // Bandit note — always show since it's never available from the API.
    lines.push("");
    lines.push(`## ⚠️ Bandit choice (manual step required)`);
    lines.push(
      bandit
        ? `Bandit set to **${bandit}** (passed as parameter).`
        : `Bandit choice is **not available** from the PoE API and has been left unchanged.`
    );
    lines.push("");
    lines.push(`Current passive point values (PoE1):`);
    lines.push(`- **Kill All** (None): +1 passive point from bandit quest`);
    lines.push(`  *(+1 additional point comes from the "Through Sacred Ground" quest — verify in-game quest log)*`);
    lines.push(`- **Alira**: +5 Mana Regen/sec, +15% all Elemental Resistances, +20% Critical Strike Multiplier`);
    lines.push(`- **Kraityn**: +6% Attack/Cast Speed, +6% chance to Avoid Elemental Ailments, +6% Movement Speed`);
    lines.push(`- **Oak**: +2% Life Regenerated per second, +20 to Maximum Life, +6% Physical Damage Reduction`);
    lines.push("");
    lines.push(
      bandit
        ? `To change it: ask the user which bandit they chose, then call \`set_config\` with \`bandit\` = "None"/"Alira"/"Kraityn"/"Oak".`
        : `Ask the user which bandit they chose (or check their in-game quest log under "Deal with the Bandits"), ` +
          `then call \`set_config\` with \`bandit\` = "None"/"Alira"/"Kraityn"/"Oak". Alternatively, pass \`bandit\` directly to \`lua_import_character\`.`
    );

    // What's preserved (informational footer).
    lines.push("");
    lines.push(`## Preserved (NOT touched by import)`);
    lines.push(`- Pantheon, enemy stats, charge toggles (set these in PoB Config tab)`);
    lines.push(`- Build notes`);
    lines.push(`- Other tree specs (only the active spec was replaced)`);
    lines.push(`- Other item sets (only the active set was replaced)`);
    lines.push(`- pob-mcp snapshots/history`);
    lines.push("");
    lines.push(
      `Run \`lua_save_build\` to persist these changes to disk, or \`validate_build\` for a full health audit.`
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  });
}

// ---------------------------------------------------------------------------
// pobb.in import
// ---------------------------------------------------------------------------

/**
 * User-Agent for PoB build sharing API requests.
 * Format required by pobb.in: "app-name/version hosted.domain (contact: email)"
 */
const POBB_USER_AGENT =
  "pob-mcp/1.0 pobb.in-import (contact: github.com/charleslucas/poe_mcp_suite)";

/** Timeout for build fetch HTTP requests (ms). */
const POBB_TIMEOUT_MS = 20_000;

/**
 * Parsed result from a pobb.in or poedb.tw URL or raw ID.
 */
interface PobImportTarget {
  /** Short display identifier, e.g. "kpRns1vROvV3" */
  displayId: string;
  /** Human-readable source label, e.g. "pobb.in" or "poedb.tw" */
  source: string;
  /** URL to fetch full PoB XML from */
  xmlUrl: string;
  /** URL to fetch JSON metadata from, or null if not available */
  metaUrl: string | null;
}

/**
 * Parse a pobb.in or poedb.tw build URL (or raw ID) into concrete fetch URLs.
 *
 * Supported forms:
 *   pobb.in
 *     https://pobb.in/kpRns1vROvV3
 *     https://pobb.in/u/username/kpRns1vROvV3
 *     kpRns1vROvV3   (raw ID, no dots/slashes)
 *
 *   poedb.tw
 *     https://poedb.tw/us/PathOfBuilding?id=E22R8MtObaQv
 *     https://poedb.tw/pt/PathOfBuilding?id=E22R8MtObaQv
 */
function parsePobImportInput(urlOrId: string): PobImportTarget {
  const trimmed = urlOrId.trim();

  // ── poedb.tw ──────────────────────────────────────────────────────────────
  if (trimmed.includes("poedb.tw")) {
    // Extract id= query parameter from any locale path
    const idMatch = trimmed.match(/[?&]id=([^&]+)/);
    if (!idMatch) {
      throw new Error(
        `Cannot extract build ID from poedb.tw URL: "${trimmed}". ` +
          `Expected format: https://poedb.tw/us/PathOfBuilding?id=ABC123`
      );
    }
    const id = idMatch[1];
    return {
      displayId: id,
      source: "poedb.tw",
      xmlUrl: `https://poedb.tw/pob/${id}/xml`,
      metaUrl: null, // poedb.tw has no JSON metadata endpoint
    };
  }

  // ── pobb.in ───────────────────────────────────────────────────────────────
  // User-namespaced: https://pobb.in/u/{username}/{id}
  const userMatch = trimmed.match(/pobb\.in\/u\/([^/]+)\/([^/?#]+)/);
  if (userMatch) {
    const id = userMatch[2];
    return {
      displayId: id,
      source: "pobb.in",
      xmlUrl: `https://pobb.in/${id}/xml`,
      metaUrl: `https://pobb.in/${id}/json`,
    };
  }

  // Simple URL: https://pobb.in/{id}
  const simpleMatch = trimmed.match(/pobb\.in\/([^/u][^/?#]*)/);
  if (simpleMatch) {
    const id = simpleMatch[1];
    return {
      displayId: id,
      source: "pobb.in",
      xmlUrl: `https://pobb.in/${id}/xml`,
      metaUrl: `https://pobb.in/${id}/json`,
    };
  }

  // Raw ID — no slashes, no dots that look like a domain → assume pobb.in
  if (!trimmed.includes("/") && !trimmed.includes(".")) {
    return {
      displayId: trimmed,
      source: "pobb.in",
      xmlUrl: `https://pobb.in/${trimmed}/xml`,
      metaUrl: `https://pobb.in/${trimmed}/json`,
    };
  }

  throw new Error(
    `Cannot parse build URL or ID from: "${trimmed}". ` +
      `Supported: pobb.in URLs (https://pobb.in/abc123), ` +
      `poedb.tw URLs (https://poedb.tw/us/PathOfBuilding?id=abc123), ` +
      `or a bare pobb.in ID (abc123).`
  );
}

/**
 * Fetch a build resource URL with the required User-Agent and a timeout.
 * Returns the raw response text on success; throws a descriptive Error on failure.
 */
async function fetchBuildUrl(url: string, context: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POBB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": POBB_USER_AGENT, "Accept": "*/*" },
      signal: controller.signal,
    });

    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      const snippet = body.length > 300 ? body.slice(0, 300) + "..." : body;
      if (res.status === 403) {
        throw new Error(
          `Build host returned 403 Forbidden for ${context}. ` +
            `The build may be private, the ID may be wrong, or the User-Agent was rejected.`
        );
      }
      if (res.status === 404) {
        throw new Error(`Build not found (404) for ${context}. Check that the ID is correct.`);
      }
      throw new Error(
        `Build fetch failed (${context}): HTTP ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`
      );
    }

    return await res.text();
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(`Build fetch timed out after ${POBB_TIMEOUT_MS}ms (${context}).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load a Path of Building build from a pobb.in URL or ID into PoB.
 *
 * Flow:
 *   1. Parse the URL/ID to extract the build ID.
 *   2. Fetch metadata JSON  (GET /{id}/json)  → title, class, main skill.
 *   3. Fetch build XML      (GET /{id}/xml)   → full PoB XML (50-60 KB typical).
 *   4. Write XML to a temp file in pobDirectory (`pobb-{id}.xml`).
 *   5. Call luaClient.loadBuildXml() to open the build in PoB.
 *   6. Delete the temp file (best-effort).
 *   7. Return an auto-context summary (stats, specs, top issues).
 *
 * Works in both TCP mode (opens in running PoB GUI) and headless mode.
 */
export async function handleImportPobb(
  context: LuaHandlerContext,
  urlOrId: string
) {
  return wrapHandler("import PoB build", async () => {
    if (!urlOrId || !urlOrId.trim()) {
      throw new Error("url_or_id is required");
    }

    const target = parsePobImportInput(urlOrId);
    const { displayId: id, source, xmlUrl, metaUrl } = target;

    // Fetch XML (required) and metadata (optional) — in parallel when both present.
    const [xml, metaText] = await Promise.all([
      fetchBuildUrl(xmlUrl, `XML for ${id} (${source})`),
      metaUrl ? fetchBuildUrl(metaUrl, `metadata for ${id}`).catch(() => null) : Promise.resolve(null),
    ]);

    // Parse the metadata JSON (best-effort — don't fail if malformed).
    let title: string = id;
    let metaClass = "";
    let metaSkill = "";
    try {
      const meta = JSON.parse(metaText ?? "") as {
        metadata?: {
          title?: string;
          ascendancy_or_class?: string;
          main_skill_name?: string;
        };
      };
      if (meta?.metadata?.title) title = meta.metadata.title;
      if (meta?.metadata?.ascendancy_or_class) metaClass = meta.metadata.ascendancy_or_class;
      if (meta?.metadata?.main_skill_name) metaSkill = meta.metadata.main_skill_name;
    } catch {
      // Metadata parse failure is non-fatal — XML is the source of truth.
    }

    // Ensure the Lua bridge is ready before touching the filesystem.
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error("Lua client not initialized. Use lua_start to connect to PoB first.");
    }

    // Write the XML to a temp file so TCP mode can register it in PoB's
    // recent-files list (loadBuildXml passes the path to the TCP handler).
    const safeSource = source.replace(/[^a-z0-9]/gi, "-");
    const tempFileName = `${safeSource}-${id}.xml`;
    const tempFilePath = path.join(context.pobDirectory, tempFileName);
    await fs.writeFile(tempFilePath, xml, "utf-8");

    let loadResult: { content: Array<{ type: string; text: string }> };
    try {
      await luaClient.loadBuildXml(xml, title, tempFilePath);

      // Check for multiple specs / item sets and inform the user.
      const extraLines: string[] = [];
      try {
        const specsResult = await luaClient.listSpecs();
        const itemSetsResult = await luaClient.listItemSets();
        if (specsResult?.specs?.length > 1) {
          extraLines.push("");
          extraLines.push(`This build has ${specsResult.specs.length} passive tree specs:`);
          const maxNodes = Math.max(...specsResult.specs.map((s: any) => s.nodeCount ?? 0));
          for (const s of specsResult.specs) {
            const hint = s.nodeCount === maxNodes && !s.active ? " (likely endgame)" : "";
            extraLines.push(
              `  ${s.active ? ">" : " "} [${s.index}] ${s.title} — ${s.className}/${s.ascendClassName}, ${s.nodeCount} nodes${hint}`
            );
          }
          const activeSpec = specsResult.specs.find((s: any) => s.active);
          if (activeSpec && activeSpec.nodeCount < maxNodes) {
            const endgameSpec = specsResult.specs.find((s: any) => s.nodeCount === maxNodes);
            extraLines.push(
              `Warning: Active spec is a leveling tree (${activeSpec.nodeCount} nodes). For endgame analysis, run: select_spec(${endgameSpec?.index})`
            );
          }
          extraLines.push("Use select_spec to switch specs.");
        }
        if (itemSetsResult?.itemSets?.length > 1) {
          extraLines.push("");
          extraLines.push(`This build has ${itemSetsResult.itemSets.length} item sets:`);
          for (const s of itemSetsResult.itemSets) {
            extraLines.push(`  ${s.active ? ">" : " "} [${s.id}] ${s.title}`);
          }
          extraLines.push("Use select_item_set to switch item sets.");
        }
      } catch {
        // Non-fatal: spec/item set info is advisory only.
      }

      // Auto-context summary: key stats + top issues.
      const summaryLines: string[] = [];
      const metaHeaderParts: string[] = [
        `Imported from ${source}: ${xmlUrl.replace(/\/xml$/, "")}`,
      ];
      if (metaClass) metaHeaderParts.push(`Class: ${metaClass}`);
      if (metaSkill) metaHeaderParts.push(`Main skill: ${metaSkill}`);

      try {
        const info = await luaClient.getBuildInfo().catch(() => null);
        if (info) {
          summaryLines.push(
            `**${info.name || title}** | Level ${info.level} ${info.className ?? ""}${info.ascendClassName ? ` (${info.ascendClassName})` : ""}`
          );
        }

        const s = await luaClient
          .getStats([
            "Life", "TotalDPS", "CombinedDPS", "MinionTotalDPS",
            "FireResist", "ColdResist", "LightningResist", "ChaosResist", "TotalEHP",
          ])
          .catch(() => null);
        if (s) {
          const dps = Number(s.CombinedDPS || s.TotalDPS || s.MinionTotalDPS || 0);
          const dpsLabel = s.MinionTotalDPS && !s.TotalDPS ? "Minion DPS" : "DPS";
          summaryLines.push(
            `Life: ${Number(s.Life ?? 0).toLocaleString()} | ${dpsLabel}: ${Math.round(dps).toLocaleString()} | EHP: ${Number(s.TotalEHP ?? 0).toLocaleString()}`
          );
          summaryLines.push(`Resists: F${s.FireResist}% C${s.ColdResist}% L${s.LightningResist}% Ch${s.ChaosResist}%`);
        }

        const issuesResult = await handleGetBuildIssues(context).catch(() => null);
        if (issuesResult) {
          const { issues } = issuesResult;
          const topIssues = issues
            .filter((i: any) => i.severity === "error" || i.severity === "warning")
            .slice(0, 3);
          if (topIssues.length > 0) {
            summaryLines.push("");
            summaryLines.push("**Top Issues:**");
            for (const issue of topIssues) {
              const icon = issue.severity === "error" ? "[ERROR]" : "[WARN]";
              summaryLines.push(`  ${icon} ${issue.message}`);
            }
          } else {
            summaryLines.push("");
            summaryLines.push("No critical issues detected.");
          }
        }
      } catch { /* auto-context is best-effort */ }

      const extraText = extraLines.length > 0 ? "\n" + extraLines.join("\n") : "";
      const summaryText = summaryLines.length > 0 ? "\n---\n" + summaryLines.join("\n") : "";
      const loadText =
        `Build loaded: "${title}"${extraText}\n\n${metaHeaderParts.join(" | ")}${summaryText}`;

      loadResult = {
        content: [{ type: "text" as const, text: loadText }],
      };
    } finally {
      // Best-effort cleanup of the temp file — delete failure must not
      // surface as an error or mask the load result.
      fs.unlink(tempFilePath).catch(() => { /* ignore */ });
    }

    return loadResult;
  });
}

// ---------------------------------------------------------------------------
// pobb.in / poedb.tw build export (share)
// ---------------------------------------------------------------------------

const deflateAsync = promisify(zlib.deflate);

/**
 * Normalise the 'platform' argument.
 * Accepts 'poedb', 'poedb.tw' as aliases for poedb.tw; everything else is pobb.in.
 */
function normalisePlatform(platform: string): 'pobb.in' | 'poedb.tw' {
  const lc = platform.toLowerCase().trim();
  if (lc === 'poedb' || lc === 'poedb.tw') return 'poedb.tw';
  return 'pobb.in';
}

/**
 * Export the currently loaded PoB build and upload it to pobb.in or poedb.tw.
 * Returns a shareable URL. No account is required — creates an anonymous paste.
 *
 * Compression format (verified empirically):
 *   body = URL-safe base64(zlib.deflate(xml_utf8)), padding stripped
 * This matches the format used by both platforms.
 */
export async function handleSharePobb(
  context: LuaHandlerContext,
  platform: string = 'pobb.in'
) {
  return wrapHandler('share build', async () => {
    const target = normalisePlatform(platform);

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start to connect to PoB first.');
    }

    // 1. Export the build XML from the running PoB instance.
    const xml = await luaClient.exportBuildXml();
    if (!xml || !xml.trim()) {
      throw new Error('exportBuildXml returned empty XML. Make sure a build is loaded.');
    }

    // 2. Compress with zlib deflate (what the PoB paste sites call "zlib.compress").
    const compressed = await deflateAsync(Buffer.from(xml, 'utf-8'));

    // 3. URL-safe base64, no padding.
    const body = compressed
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // 4. POST to the appropriate endpoint.
    let shareUrl: string;
    if (target === 'poedb.tw') {
      const responseText = await fetchBuildUrl_post(
        'https://poedb.tw/pob/api/gen',
        body,
        'POST to poedb.tw'
      );
      // poedb.tw responds with the full URL directly (e.g. "https://poedb.tw/pob/0YtpjzLi6H").
      shareUrl = responseText.trim();
      if (!shareUrl.startsWith('http')) {
        throw new Error(
          'poedb.tw returned an unexpected response: ' + responseText.slice(0, 200)
        );
      }
    } else {
      // pobb.in responds with just the paste ID (e.g. "kpRns1vROvV3").
      const responseText = await fetchBuildUrl_post(
        'https://pobb.in/pob/',
        body,
        'POST to pobb.in'
      );
      const pasteId = responseText.trim();
      if (!pasteId || pasteId.includes(' ') || pasteId.includes('<')) {
        throw new Error(
          'pobb.in returned an unexpected response: ' + responseText.slice(0, 200)
        );
      }
      shareUrl = 'https://pobb.in/' + pasteId;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: [
            'Build shared successfully!',
            '',
            'URL: ' + shareUrl,
            '',
            'Platform: ' + target,
            '(Anyone with the link can import this build into Path of Building.)',
          ].join('\n'),
        },
      ],
    };
  });
}

/**
 * POST plain-text body to a URL and return the response text.
 * Uses the same User-Agent and timeout as fetchBuildUrl.
 */
async function fetchBuildUrl_post(url: string, body: string, context: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POBB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': POBB_USER_AGENT,
        'Content-Type': 'text/plain',
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      throw new Error(
        'Share upload failed (' + context + '): HTTP ' + res.status + ' ' + res.statusText +
        (snippet ? ' — ' + snippet : '')
      );
    }

    return await res.text();
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error('Share upload timed out after ' + POBB_TIMEOUT_MS + 'ms (' + context + ').');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
