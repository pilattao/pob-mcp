/**
 * Detect non-Timeless radius effects and report their geometric scope.
 * PoE2 supports native Time-Lost small/notable targets and Controlled
 * Metamorphosis rings. Other transformations remain explicitly unmodeled.
 * Legacy PoE1 effects remain text/geometry reports, not numeric simulations.
 */

import { getJewelRadius, nodesInRadius, radiusTree, type RadiusContext, type RadiusBand } from "./radiusUtils.js";
import type { PobNode } from './pobTreeDataLoader.js';

const RADIUS_PATTERN = /\bin\s+(?:the\s+)?radius\b/i;

const TIMELESS_INDICATORS: RegExp[] = [
  /conquered by the karui/i,
  /conquered by vaal/i,
  /conquered by the eternal/i,
  /conquered by the templars/i,
  /conquered by the maraketh/i,
  /conquered by the kalguur/i,
  /conquered by the abyssals/i,
  /commanded leadership over \d+ warriors under/i,
  /denoted service of \d+ dekhara/i,
  /carved to glorify \d+ new faithful/i,
  /commissioned \d+ coins to commemorate/i,
];

const THRESHOLD_PATTERN =
  /with(?:\s+at\s+least)?\s+\d+\s+(strength|dexterity|intelligence)\s+in\s+(?:the\s+)?radius/i;

function stripModSourcePrefix(line: string): string {
  return line
    .replace(/^\{[^}]+\}/, "")
    .replace(/\s*\[[^\]]+\]\s*$/, "")
    .trim();
}

/**
 * Decide whether a single mod line is a "radius-effect" mod that this service
 * should report — i.e., it mentions "in radius" but isn't a Timeless Jewel
 * signature or an attribute threshold.
 */
export function isRadiusEffectMod(rawLine: string): boolean {
  const line = stripModSourcePrefix(rawLine);
  if (!line) return false;
  if (!RADIUS_PATTERN.test(line)) return false;
  if (TIMELESS_INDICATORS.some((p) => p.test(line))) return false;
  if (THRESHOLD_PATTERN.test(line)) return false;
  return true;
}

export type RadiusCategory = "transform" | "grant" | "multiplier" | "other";

/**
 * Best-effort categorization of what KIND of radius effect a mod is. Useful
 * for grouping output but not load-bearing — callers should still read the
 * mod text.
 */
export function categorizeRadiusMod(rawLine: string): RadiusCategory {
  const line = stripModSourcePrefix(rawLine).toLowerCase();
  if (/are transformed to|are converted to/.test(line)) return "transform";
  if (/grant(?:s|ing|ed)?\b/.test(line)) return "grant";
  if (/double|triple|increased effect of/.test(line)) return "multiplier";
  return "other";
}

export interface JewelRadiusEffectInfo {
  /** Jewel socket node ID. */
  socketNodeId: string;
  /** Jewel display name. */
  jewelName: string;
  /** Mod lines matched by isRadiusEffectMod, cleaned of source prefixes. */
  radiusMods: Array<{ line: string; category: RadiusCategory }>;
  /** Radius used for the node-in-radius lookup (in tree-coord units). */
  radius: number;
  innerRadius?: number;
  treeVersion?: string;
  /** Geometric scope only for effects whose target rules are not implemented. */
  candidatesInRadius?: string[];
  eligibleUnallocated?: string[];
  notes?: string[];
  /** Allocated targets for supported rules; see notes for unmodeled effects. */
  affectedAllocated: string[];
}

export interface JewelSocketInfo {
  socketNodeId: string;
  jewelName: string;
  mods: string[];
  /** Explicit outer radius in tree-coordinate units; otherwise read native item radius. */
  radius?: number;
  innerRadius?: number;
  treeVersion?: string;
}

function jewelRadius(jewel: JewelSocketInfo, context: Required<RadiusContext>): RadiusBand {
  if (jewel.radius !== undefined) return { inner: jewel.innerRadius ?? 0, outer: jewel.radius };
  const lines = jewel.mods.map(stripModSourcePrefix);
  const rings = lines.flatMap(line => /^(?:Only )?affects Passives in (.+) Ring$/i.exec(line)?.[1]?.toLowerCase() ?? []);
  const radiusLabel = lines.find(l => /^Radius:/i.test(l))?.replace(/^Radius:\s*/i, '').trim();
  if (context.treeVersion.startsWith('0_')) {
    if (rings.length || radiusLabel?.toLowerCase() === 'variable') {
      // ModParser.lua maps these ring variants to native radius indices 5..12.
      const labels = ['very small', 'small', 'medium-small', 'medium', 'medium-large', 'large', 'very large', 'massive'];
      const variants = [...new Set(rings)];
      if (variants.length !== 1 || !labels.includes(variants[0])) throw new Error('PoE2 ring radius is unknown: provide one selected ring variant.');
      return getJewelRadius(labels.indexOf(variants[0]) + 5, context);
    }
    const upgrades = lines.flatMap(l => /^Upgrades Radius to (.+)$/i.exec(l)?.[1] ?? []);
    if (new Set(upgrades.map(s => s.toLowerCase())).size > 1) throw new Error('PoE2 radius upgrade is ambiguous.');
    const label = upgrades[0] ?? radiusLabel ?? (/Time-Lost (Ruby|Emerald|Sapphire|Diamond)/i.test(jewel.jewelName) ? 'Small' : undefined);
    if (!label) throw new Error('PoE2 jewel radius is unknown: provide the native Radius line or explicit bounds.');
    return getJewelRadius(label, context);
  }
  return getJewelRadius(radiusLabel ?? 'Small', context);
}

function targetsNode(line: string, node: PobNode): boolean | null {
  if (/Passives in Radius can be Allocated without being connected to your tree/i.test(line)) {
    return !node.classesStart && !node.isJewelSocket && !node.ascendancyName;
  }
  // PoB2 ModParser explicitly excludes attribute travel nodes from "Small".
  if (/^(?:\d+% increased Effect of Small Passive Skills in Radius$|Small Passive Skills in Radius also grant |Allocated Small Passive Skills in Radius grant nothing$)/i.test(line)) return !node.isNotable && !node.isKeystone && !node.isJewelSocket && !node.classesStart && !node.isAscendancyStart && !node.isAttribute;
  if (/^(?:\d+% increased Effect of Notable Passive Skills in Radius$|Notable Passive Skills in Radius (?:also grant |grant nothing$|are Transformed to instead grant:))/i.test(line)) return !!node.isNotable;
  return null;
}

export interface FindRadiusEffectsResult {
  jewelsScanned: number;
  jewelsWithRadiusEffects: number;
  jewels: JewelRadiusEffectInfo[];
}

/**
 * Find all jewels in the build that have non-Timeless, non-Threshold "in
 * Radius" mods. For each, list the affected allocated nodes.
 */
export function findRadiusEffectJewels(
  jewels: JewelSocketInfo[],
  allocatedNodes: Set<string>,
  context: RadiusContext = {}
): FindRadiusEffectsResult {
  const out: FindRadiusEffectsResult = {
    jewelsScanned: jewels.length,
    jewelsWithRadiusEffects: 0,
    jewels: [],
  };
  for (const j of jewels) {
    const matchedMods = j.mods
      .map(stripModSourcePrefix)
      .filter((l) => l.length > 0 && isRadiusEffectMod(l));
    if (matchedMods.length === 0) continue;
    out.jewelsWithRadiusEffects++;

    const resolved = radiusTree({ ...context, treeVersion: j.treeVersion ?? context.treeVersion });
    const poe2 = resolved.treeVersion.startsWith('0_');
    const band = jewelRadius(j, resolved);
    const inRadius = nodesInRadius(j.socketNodeId, band, undefined, resolved);
    const notes: string[] = [];
    const active = !poe2 || allocatedNodes.has(j.socketNodeId);
    if (!active) notes.push('The jewel socket is not allocated; its radius effects are inactive.');
    const affectedAllocated = inRadius.filter(id => active && allocatedNodes.has(id) &&
      (!poe2 || matchedMods.some(line => targetsNode(line, resolved.tree.nodes[id]) === true)));
    if (poe2 && matchedMods.some(line => targetsNode(line, {} as PobNode) === null)) {
      throw new Error(`PoE2 radius effect evaluation unavailable for ${j.jewelName}: unimplemented target/transform rules require native evaluation; no empty affected-node result is inferred.`);
    }
    const allowsDisconnected = matchedMods.some(line => /can be Allocated without being connected/i.test(line));
    const eligibleUnallocated = poe2 && active && allowsDisconnected ? inRadius.filter(id => !allocatedNodes.has(id) &&
      matchedMods.some(line => /can be Allocated without being connected/i.test(line) && targetsNode(line, resolved.tree.nodes[id]))) : [];

    out.jewels.push({
      socketNodeId: j.socketNodeId,
      jewelName: j.jewelName,
      radiusMods: matchedMods.map((line) => ({
        line,
        category: categorizeRadiusMod(line),
      })),
      radius: band.outer,
      innerRadius: band.inner,
      treeVersion: resolved.treeVersion,
      candidatesInRadius: inRadius,
      eligibleUnallocated,
      notes,
      affectedAllocated,
    });
  }
  return out;
}
