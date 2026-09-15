/**
 * Parser for PoB's internal item "raw" text — the multi-line block returned
 * by the get_items TCP action (and used in build XML). Extracts mod lines
 * with their kind (enchant / implicit / explicit / crafted / fractured / ...)
 * plus a few item-header fields.
 *
 * Extracted from itemSkillHandlers so multiple handlers can share it
 * (get_equipped_items for display, analyze_item_mods for identification).
 */

export interface ParsedModLine {
  /** The display text with {tag} markers stripped. */
  line: string;
  /** enchant | implicit | explicit | crafted | fractured | scourge | crucible */
  type: string;
}

// Non-mod trailer lines that appear after mods in PoB raw item text.
const ITEM_TRAILER_LINES = new Set([
  "Corrupted", "Fractured Item", "Mirrored", "Split", "Synthesised Item",
  "Veiled Prefix", "Veiled Suffix", "Elder Item", "Shaper Item",
  "Warlord Item", "Crusader Item", "Redeemer Item", "Hunter Item",
  "Sanctified",
]);

/**
 * Parse PoB internal item raw text to extract mod lines. After the
 * "Implicits: N" header, the first N lines are implicit/enchant and the
 * rest are explicit/crafted/fractured.
 */
export function parseItemRawMods(raw: string | undefined): ParsedModLine[] {
  if (!raw) return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const mods: ParsedModLine[] = [];
  let implicitTotal = 0;
  let pastImplicitsLine = false;
  let enchantCount = 0;
  let implicitCount = 0;

  for (const rawLine of lines) {
    const implicitsMatch = rawLine.match(/^Implicits:\s*(\d+)/);
    if (implicitsMatch) {
      implicitTotal = parseInt(implicitsMatch[1], 10);
      pastImplicitsLine = true;
      continue;
    }
    if (!pastImplicitsLine) continue;
    if (ITEM_TRAILER_LINES.has(rawLine)) continue;
    if (/^[A-Z][A-Za-z ]+:\s/.test(rawLine) && !/^[+\-\d]/.test(rawLine) && !/^(Grants Skill|Bonded):/.test(rawLine)) continue;

    let crafted = false, fractured = false, scourge = false, crucible = false, enchant = false, desecrated = false;
    const displayLine = rawLine
      .replace(/\{(\w+)(?::[^}]*)?\}/g, (_m, tag) => {
        if (tag === "crafted") crafted = true;
        else if (tag === "enchant") enchant = true;
        else if (tag === "desecrated") desecrated = true;
        else if (tag === "fractured") fractured = true;
        else if (tag === "scourge") scourge = true;
        else if (tag === "crucible") crucible = true;
        return "";
      })
      .replace(/\s*\((implicit|enchant|crafted|fractured)\)\s*$/, "")
      .trim();

    if (!displayLine) continue;

    const totalSoFar = enchantCount + implicitCount;
    let type: string;
    if ((crafted || enchant) && totalSoFar < implicitTotal) {
      type = "enchant"; enchantCount++;
    } else if (!crafted && totalSoFar < implicitTotal) {
      type = "implicit"; implicitCount++;
    } else if (desecrated) {
      type = "desecrated";
    } else if (fractured) {
      type = "fractured";
    } else if (scourge) {
      type = "scourge";
    } else if (crucible) {
      type = "crucible";
    } else if (crafted) {
      type = "crafted";
    } else {
      type = "explicit";
    }

    mods.push({ line: displayLine, type });
  }
  return mods;
}

/**
 * Extract the item level from raw text ("Item Level: 84"). Returns undefined
 * if not present.
 */
export function parseItemLevel(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^Item Level:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : undefined;
}
