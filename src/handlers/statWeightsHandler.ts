/**
 * compute_stat_weights — empirical per-mod DPS/EHP sensitivity for the loaded build.
 *
 * Runs a battery of single-mod probes through the non-mutating GetMiscCalculator
 * closure (the probe_stat_weights Lua action): each probe clones the carrier
 * slot's item, appends one mod line, and reads the calc delta. The user's build
 * is never mutated — no undo state, no buildFlag, nothing changes in the GUI.
 *
 * Minion builds are auto-detected (minion DPS > player DPS) and get a
 * minion-focused battery; deltas are read from MinionCombinedDPS. Note the
 * probe path measures the MAIN skill's minion — multi-group swarm totals come
 * from minion_dps_breakdown instead.
 *
 * Output is the build's *measured* scoring function: per-unit DPS/EHP weights
 * that replace hand-curated intuition in build-profile Sections 3-4 and feed
 * find_weighted_trade_items directly.
 */

import { wrapHandler } from "../utils/errorHandling.js";
import type { LuaHandlerContext } from "./luaHandlers.js";
import { measurePoe2StatWeights } from '../services/poe2TreeMeasurements.js';

interface Probe {
  mod: string;
  /** Magnitude of the probe, for per-unit normalization. */
  per: number;
  unit: string;
}

// Standard battery: common trade-searchable stat axes at realistic magnitudes.
// Magnitudes are large enough to rise above calc noise, small enough to stay
// in the locally-linear regime.
const DEFAULT_PROBES: Probe[] = [
  { mod: "+50 to maximum Life", per: 50, unit: "1 life" },
  { mod: "+50 to maximum Energy Shield", per: 50, unit: "1 ES" },
  { mod: "+50 to maximum Mana", per: 50, unit: "1 mana" },
  { mod: "8% increased maximum Life", per: 8, unit: "1% inc life" },
  { mod: "+20 to Strength", per: 20, unit: "1 str" },
  { mod: "+20 to Dexterity", per: 20, unit: "1 dex" },
  { mod: "+20 to Intelligence", per: 20, unit: "1 int" },
  { mod: "10% increased Attack Speed", per: 10, unit: "1% attack speed" },
  { mod: "10% increased Cast Speed", per: 10, unit: "1% cast speed" },
  { mod: "+25% to Global Critical Strike Multiplier", per: 25, unit: "1% crit multi" },
  { mod: "25% increased Global Critical Strike Chance", per: 25, unit: "1% inc crit chance" },
  { mod: "10% increased Elemental Damage with Attack Skills", per: 10, unit: "1% ele attack dmg" },
  { mod: "Adds 10 to 15 Physical Damage to Attacks", per: 1, unit: "10-15 flat phys" },
  { mod: "Adds 15 to 25 Fire Damage to Attacks", per: 1, unit: "15-25 flat fire" },
  { mod: "+13% to all Elemental Resistances", per: 13, unit: "1% all res" },
];

// Minion battery: the axes minion builds actually shop for. Player attack/cast
// speed stay in — trigger-based minions (e.g. Holy Relic) scale with the
// PLAYER's trigger rate.
const MINION_PROBES: Probe[] = [
  { mod: "+1 to Level of all Minion Skill Gems", per: 1, unit: "1 gem level" },
  { mod: "Minions deal 20% increased Damage", per: 20, unit: "1% minion dmg" },
  { mod: "Minions have 10% increased Attack and Cast Speed", per: 10, unit: "1% minion AS/CS" },
  { mod: "Minions have 20% increased maximum Life", per: 20, unit: "1% minion life" },
  { mod: "10% increased Attack Speed", per: 10, unit: "1% attack speed (trigger rate)" },
  { mod: "10% increased Cast Speed", per: 10, unit: "1% cast speed" },
  { mod: "+50 to maximum Life", per: 50, unit: "1 life" },
  { mod: "8% increased maximum Life", per: 8, unit: "1% inc life" },
  { mod: "+20 to Strength", per: 20, unit: "1 str" },
  { mod: "+20 to Intelligence", per: 20, unit: "1 int" },
  { mod: "+13% to all Elemental Resistances", per: 13, unit: "1% all res" },
];

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return String(Math.round(n * 100) / 100);
}

export async function handleComputeStatWeights(
  context: LuaHandlerContext,
  slot?: string,
  customMods?: string[]
) {
  return wrapHandler("compute stat weights", async () => {
    if (process.env.POE_GAME === 'poe2') return measurePoe2StatWeights(context, slot, customMods);
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error("Lua client not initialized. Use lua_start first.");
    if (typeof (luaClient as any).probeStatWeights !== "function") {
      throw new Error(
        "probe_stat_weights action unavailable — the PoB API Lua files predate this tool. " +
          "Re-run InstallTcpApi.ps1 (or relaunch via LaunchPoBWithAPI.bat) and restart PoB."
      );
    }

    // Detect minion builds cheaply before choosing the battery (best-effort —
    // if getStats is unavailable, fall back to the player battery).
    let minionBuild = false;
    if (typeof (luaClient as any).getStats === "function") {
      const s = await (luaClient as any)
        .getStats(["TotalDPS", "CombinedDPS", "MinionTotalDPS", "MinionCombinedDPS", "FullDPS"])
        .catch(() => null);
      if (s) {
        const playerDps = Number(s.CombinedDPS) || Number(s.TotalDPS) || 0;
        const minionDps = Number(s.MinionCombinedDPS) || Number(s.MinionTotalDPS) || 0;
        const fullDps = Number(s.FullDPS) || 0;
        // Minion-dominant directly, or a Full-DPS build where the player's own
        // skill is a minor contributor (trigger bots, aurabots, summoners whose
        // minion DPS lives only in the FullDPS aggregate).
        minionBuild = minionDps > playerDps || (fullDps > 0 && playerDps < fullDps * 0.5);
      }
    }

    const probes: Probe[] = customMods?.length
      ? customMods.map((m) => ({ mod: m, per: 1, unit: "probe" }))
      : minionBuild
        ? MINION_PROBES
        : DEFAULT_PROBES;

    const res = await (luaClient as any).probeStatWeights({
      slot,
      mods: probes.map((p) => p.mod),
    });

    const baseDPS = Number(res.base?.CombinedDPS) || 0;
    const baseEHP = Number(res.base?.TotalEHP) || 0;
    const baseMinionDPS = Number(res.base?.MinionCombinedDPS) || 0;
    const baseFullDPS = Number(res.base?.FullDPS) || 0;
    // Headline axis: Full DPS when the build aggregates skills (the calc
    // recomputes it per probe), else main-skill minion DPS, else player DPS.
    const useFullDps = baseFullDPS > 0;
    const headlineBase = useFullDps ? baseFullDPS : minionBuild ? baseMinionDPS : baseDPS;
    const headlineLabel = useFullDps ? "Full DPS" : minionBuild ? "Minion DPS" : "DPS";

    interface Row {
      probe: Probe;
      dpsDelta: number;
      minionDpsDelta: number;
      fullDpsDelta: number;
      ehpDelta: number;
      recognized: boolean;
      error?: string;
    }
    const rows: Row[] = res.results.map((r: any, i: number) => ({
      probe: probes[i] ?? { mod: String(r.mod), per: 1, unit: "probe" },
      dpsDelta: Number(r.dpsDelta) || 0,
      minionDpsDelta: Number(r.minionDpsDelta) || 0,
      fullDpsDelta: Number(r.fullDpsDelta) || 0,
      ehpDelta: Number(r.ehpDelta) || 0,
      recognized: r.recognized !== false && !r.error,
      error: r.error ? String(r.error) : undefined,
    }));

    const headline = (r: Row) =>
      useFullDps ? r.fullDpsDelta : minionBuild ? r.minionDpsDelta : r.dpsDelta;
    const ok = rows.filter((r) => r.recognized && !r.error);
    const bad = rows.filter((r) => !r.recognized || r.error);
    ok.sort((a, b) => Math.abs(headline(b)) - Math.abs(headline(a)));

    const lines: string[] = [
      "=== Stat Weights (measured via live PoB sim; build not modified) ===",
      minionBuild
        ? `Minion build detected — minion battery used${useFullDps ? "; deltas are Full DPS (all flagged groups × counts)" : "; deltas are MAIN-SKILL minion DPS (per-group table: minion_dps_breakdown)"}.`
        : "",
      `Baseline: ${useFullDps ? `Full DPS ${fmt(baseFullDPS)} | ` : ""}${minionBuild ? `Minion DPS ${fmt(baseMinionDPS)} | Player DPS ${fmt(baseDPS)}` : `DPS ${fmt(baseDPS)}`} | EHP ${fmt(baseEHP)} — carrier: ${res.carrier} (${res.slot})`,
      "",
    ].filter(Boolean);

    const dpsHeader = `${headlineLabel} Δ`;
    lines.push(`| Probe | ${dpsHeader} | Δ/unit | EHP Δ | EHP Δ/unit | ${dpsHeader.replace(" Δ", "")} % |`);
    lines.push("|---|---|---|---|---|---|");
    for (const r of ok) {
      const h = headline(r);
      const perUnit = h / r.probe.per;
      const perUnitEhp = r.ehpDelta / r.probe.per;
      const pct = headlineBase > 0 ? (100 * h) / headlineBase : 0;
      lines.push(
        `| ${r.probe.mod} | ${fmt(h)} | ${fmt(perUnit)} per ${r.probe.unit} | ${fmt(r.ehpDelta)} | ${fmt(perUnitEhp)} | ${pct >= 0 ? "+" : ""}${fmt(pct)}% |`
      );
    }

    // A battery where EVERY recognized probe reads exactly zero means the
    // replacement path silently didn't apply (e.g. repSlotName mismatch) —
    // a +25% crit multi probe cannot genuinely be worth nothing.
    const allZero =
      ok.length >= 5 && ok.every((r) => headline(r) === 0 && r.dpsDelta === 0 && r.ehpDelta === 0);
    if (allZero) {
      lines.push("");
      lines.push(
        "🔴 SUSPECT RESULT: every probe returned exactly zero delta — the item-replacement " +
          "override likely did not apply (PoB API files may be stale; relaunch PoB via " +
          "LaunchPoBWithAPI.bat). Do NOT record these as real weights."
      );
    }
    if (bad.length > 0) {
      lines.push("");
      lines.push(
        `⚠️ ${bad.length} probe(s) not usable (unrecognized mod text or calc error): ${bad.map((r) => `"${r.probe.mod}"${r.error ? ` (${r.error})` : ""}`).join("; ")}`
      );
    }
    lines.push("");
    lines.push(
      "Usage: these per-unit weights are this build's measured scoring function — feed them to " +
        "find_weighted_trade_items, and record the table (with today's date) in build-profile.md " +
        "Section 3/4 so future sessions rank mods by measurement, not intuition. Re-run after " +
        "respecs or major gear changes."
    );

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}
