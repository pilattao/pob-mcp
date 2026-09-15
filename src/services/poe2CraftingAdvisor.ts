import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { CraftingAdvisorContext } from '../handlers/craftingAdvisorHandler.js';
import { getBase, getBasesDir, findBasesMatching, type PobBase } from './pobBaseDataLoader.js';
import { searchMods, getMod, getModItemPath, normalizeStatLine, parseRolledValues, rolledValuesFitTemplate, type PobMod } from './pobModDataLoader.js';
import { findEssencesMatching, getEssenceCount, resolveEssenceMods } from './pobCraftDataLoader.js';
import { resolvePobDataLocation } from './pobDataPath.js';
import { calculatePoe2OneStepOdds } from './oddsCalculator.js';
import { readPoe2BuildEvidence } from './poe2BuildEvidence.js';
import { BuildService } from './buildService.js';
import { validationStat } from './passiveBudget.js';
import { resolveLeague } from './leagueResolver.js';
import { parseItemRawMods, parseItemLevel } from '../utils/itemRawParser.js';
import type { EconomyOverview } from './poeNinjaClient.js';

export interface Poe2CraftingAdvisorArgs {
  slot: string; base?: string; desired_mods?: string[]; ilvl?: number; league?: string;
  budget?: 'low' | 'medium' | 'high';
  item_text?: string;
  item_rarity?: 'normal' | 'magic' | 'rare' | 'unique';
  /** Complete ordinary CoE affix IDs for the supplied item state, not desired mods. */
  existing_mod_ids?: string[];
  method?: string;
}

// Mechanics reviewed 2026-09-15 against PoE2DB/PoE2 Wiki and GGG's 0.3 essence
// rework / 0.3.1 alchemy change. These are operation
// definitions, not probabilities. Essence outcomes come from the native loader.
const REVIEWED = '2026-09-15';
const WIKI = 'https://www.poe2wiki.net/wiki/';
const ESSENCES = 'https://poe2db.tw/us/Essence';
const ESSENCE_REWORK = 'https://www.pathofexile.com/forum/view-thread/3826682';
const operations = [
  { id: 'transmute', name: 'Orb of Transmutation', rarities: ['normal'],
    effect: 'normal to magic; add one random modifier', url: WIKI + 'Orb_of_Transmutation' },
  { id: 'augment', name: 'Orb of Augmentation', rarities: ['magic'],
    effect: 'magic item; add one random modifier in an open affix slot', url: WIKI + 'Orb_of_Augmentation' },
  { id: 'regal', name: 'Regal Orb', rarities: ['magic'],
    effect: 'magic to rare; retain existing modifiers and add one random modifier', url: WIKI + 'Regal_Orb' },
  { id: 'exalt', name: 'Exalted Orb', rarities: ['rare'],
    effect: 'rare item; retain existing modifiers and add one random modifier in an open affix slot', url: WIKI + 'Exalted_Orb' },
  { id: 'alchemy', name: 'Orb of Alchemy', rarities: ['normal', 'magic'],
    effect: 'normal or magic to rare with four new random modifiers; replace existing modifiers', url: 'https://www.pathofexile.com/forum/view-thread/3860076' },
  { id: 'chaos', name: 'Chaos Orb', rarities: ['rare'],
    effect: 'rare item; remove one random modifier and add one new random modifier; a wanted modifier can be lost', url: 'https://poe2db.tw/Rarity' },
  { id: 'annul', name: 'Orb of Annulment', rarities: ['magic', 'rare'],
    effect: 'magic or rare item; remove one random modifier, including a wanted modifier', url: WIKI + 'Orb_of_Annulment' },
];

function sourceFile(file: string): string {
  const contents = readFileSync(file);
  return `${file}; sha256=${createHash('sha256').update(contents).digest('hex')}; file modified ${statSync(file).mtime.toISOString()} (file time, not game patch date)`;
}

type XmlElement = Record<string, any>;
const rows = (value: XmlElement | XmlElement[] | undefined): XmlElement[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const slotAliases: Record<string, string> = {
  helmet: 'Helmet', chest: 'Body Armour', gloves: 'Gloves', boots: 'Boots',
  weapon: 'Weapon 1', offhand: 'Weapon 2', ring: 'Ring 1', amulet: 'Amulet', belt: 'Belt',
};

function selectedItem(build: XmlElement, requestedSlot: string): { raw?: string; slot: string } {
  const items = build.Items;
  const sets = rows(items?.ItemSet);
  const set = items?.activeItemSet !== undefined
    ? sets.find(entry => String(entry.id) === String(items.activeItemSet)) : sets.length === 1 ? sets[0] : undefined;
  const alias = requestedSlot.toLowerCase();
  let slot = slotAliases[alias] ?? requestedSlot;
  if (alias === 'weapon' || alias === 'offhand') {
    const swap = set?.useSecondWeaponSet ?? items?.useSecondWeaponSet;
    if (swap === true || swap === 'true') slot += ' Swap';
    else if (swap !== false && swap !== 'false') return { slot: `${slot} (active weapon set unknown)` };
  }
  const equipped = rows(set?.Slot).find(entry => String(entry.name).toLowerCase() === slot.toLowerCase());
  const definition = rows(items?.Item).find(entry => String(entry.id) === String(equipped?.itemId));
  const raw = equipped?.Item ?? definition?.['#text'];
  return { slot, raw: typeof raw === 'string' ? raw : undefined };
}

function baseFromRaw(raw: string | undefined): PobBase | null {
  if (!raw) return null;
  // Exact native header names only; never infer a base from a modifier or fuzzy match.
  const header = raw.split(/\r?\n/).map(line => line.trim());
  const rarity = header.findIndex(line => /^Rarity:/.test(line));
  return header.slice(rarity + 1, rarity + 3).map(line => getBase(line)).find(Boolean) ?? null;
}

/** Only complete, contiguous, unique native affix matches establish occupancy.
 * All lines of a hybrid must match their rolled ranges; never count its second
 * stat as an extra affix or use a loader's best-guess candidate as a proven ID. */
function identifyAffixes(lines: string[], pool: PobMod[]): { ids?: string[]; known: PobMod[] } {
  const ids: string[] = [], known: PobMod[] = [];
  let complete = true;
  for (let index = 0; index < lines.length;) {
    const matches = pool.filter(mod => mod.statLines.length > 0 && mod.statLines.every((template, offset) => {
      const line = lines[index + offset];
      return line !== undefined && normalizeStatLine(line) === normalizeStatLine(template) &&
        rolledValuesFitTemplate(parseRolledValues(line), template);
    }));
    if (matches.length !== 1 || known.some(mod => mod.group === matches[0]?.group)) {
      complete = false; index++; continue;
    }
    known.push(matches[0]); ids.push(matches[0].id); index += matches[0].statLines.length;
  }
  return { ids: complete ? ids : undefined, known };
}

function essenceOperations(file: string): Map<string, 'upgrade' | 'replace'> {
  // The public essence loader omits native metadata IDs. Read only that mapping
  // here; modifiers and guarantees still come entirely from its existing API.
  const result = new Map<string, 'upgrade' | 'replace'>();
  const text = readFileSync(file, 'utf8');
  const pattern = /\["Metadata\/Items\/Currency\/(Currency(?:Lesser|Greater|Perfect|Corrupted)?Essence[^"\n]+)"\]\s*=\s*\{\s*name\s*=\s*"([^"\n]+)"/g;
  for (const match of text.matchAll(pattern)) {
    result.set(match[2], /^Currency(?:Perfect|Corrupted)Essence/.test(match[1]) ? 'replace' : 'upgrade');
  }
  return result;
}

function supportedEquipment(base: PobBase): boolean {
  return base.tags.some(tag => ['weapon', 'armour', 'ring', 'amulet', 'belt', 'jewel'].includes(tag));
}

function validateArgs(args: Poe2CraftingAdvisorArgs): void {
  if (typeof args.slot !== 'string' || !args.slot.trim()) throw new Error('A gear slot is required');
  if (args.base !== undefined && (typeof args.base !== 'string' || !args.base.trim())) throw new Error('base must be a nonempty native base name');
  if (args.ilvl !== undefined && (!Number.isInteger(args.ilvl) || args.ilvl < 1 || args.ilvl > 100)) throw new Error('ilvl must be an integer from 1 to 100');
  if (args.item_text !== undefined && (typeof args.item_text !== 'string' || !args.item_text.trim())) throw new Error('item_text must contain item text');
  if (args.item_rarity !== undefined && !['normal', 'magic', 'rare', 'unique'].includes(args.item_rarity)) throw new Error('Unknown item_rarity');
  if (args.desired_mods !== undefined && (!Array.isArray(args.desired_mods) || args.desired_mods.some(mod => typeof mod !== 'string' || !mod.trim()))) throw new Error('desired_mods must contain nonempty strings');
  if (args.existing_mod_ids !== undefined && (!Array.isArray(args.existing_mod_ids) || args.existing_mod_ids.some(id => typeof id !== 'string' || !id))) throw new Error('existing_mod_ids must be a complete string array');
}

/** Read-only advice from native item definitions, selected build evidence and
 * source-tagged economy data. Missing evidence narrows the advice, not its honesty. */
export async function suggestPoe2Crafting(context: CraftingAdvisorContext, args: Poe2CraftingAdvisorArgs): Promise<string> {
  validateArgs(args);
  const location = resolvePobDataLocation();
  if (location.game !== 'poe2') throw new Error('Crafting advice requires verified PoE2 native definitions');
  const league = resolveLeague(args.league);
  const lines = ['=== PoE2 Crafting Advisor ===', `League: ${league}`];
  let equipped: ReturnType<typeof selectedItem> | undefined;
  let liveStats: Record<string, any> = {};
  try {
    const evidence = await readPoe2BuildEvidence({
      buildService: context.buildService ?? new BuildService(process.env.POB_DIRECTORY ?? '/'),
      ensureLuaClient: context.ensureLuaClient, getLuaClient: context.getLuaClient,
    });
    equipped = selectedItem(evidence.build, args.slot);
    liveStats = evidence.stats;
    lines.push(evidence.note, `Selected slot: ${equipped.slot}`);
    const measured = ['Life', 'EnergyShield', 'Mana', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist']
      .flatMap(key => validationStat(liveStats, key) === null ? [] : [`${key}: ${validationStat(liveStats, key)}`]);
    lines.push(`Current build measurements: ${measured.join('; ') || 'unknown'}`);
    for (const kind of ['Fire', 'Cold', 'Lightning', 'Chaos']) {
      const missing = validationStat(liveStats, 'Missing' + kind + 'Resist');
      if (missing !== null && missing > 0) lines.push(`${kind} resistance: ${missing}% below the configured cap; this is a build gap, not proof that the chosen item must provide it.`);
    }
  } catch (error) {
    lines.push(`Current native build evidence: unknown (${error instanceof Error ? error.message : String(error)})`);
  }

  const equippedBase = baseFromRaw(equipped?.raw);
  const pastedBase = baseFromRaw(args.item_text);
  if (args.item_text && args.base && pastedBase && pastedBase.name.toLowerCase() !== args.base.trim().toLowerCase()) throw new Error('base conflicts with item_text');
  const base = args.base ? getBase(args.base.trim()) : pastedBase ?? equippedBase;
  if (!base) {
    const suggestions = args.base ? findBasesMatching(args.base, 5).map(base => base.name) : [];
    lines.push(`Target base: unknown. Provide an exact PoE2 base or item_text for ${args.slot}.`,
      ...(suggestions.length ? [`Matching native names to choose from: ${suggestions.join(', ')}`] : []));
    return lines.join('\n');
  }
  // An explicit different base/level/state describes a candidate, not the equipped item.
  const useEquipped = equippedBase?.name === base.name && args.existing_mod_ids === undefined && args.item_rarity === undefined &&
    (args.ilvl === undefined || args.ilvl === parseItemLevel(equipped?.raw));
  const raw = args.item_text ?? (useEquipped ? equipped?.raw : undefined);
  const rawLevel = parseItemLevel(raw);
  if (args.item_text && args.ilvl !== undefined && rawLevel !== undefined && args.ilvl !== rawLevel) throw new Error('ilvl conflicts with item_text');
  const ilvl = args.ilvl ?? rawLevel;
  const rawRarity = raw?.match(/^Rarity:\s*(NORMAL|MAGIC|RARE|UNIQUE)\s*$/mi)?.[1].toLowerCase();
  if (rawRarity && args.item_rarity && rawRarity !== args.item_rarity) throw new Error('item_rarity conflicts with item_text');
  const rarity = args.item_rarity ?? rawRarity;
  const modifiers = parseItemRawMods(raw);
  const hasModList = !!raw?.match(/^Implicits:\s*\d+\s*$/m);
  const specials = modifiers.filter(mod => !['implicit', 'explicit'].includes(mod.type)).map(mod => mod.type);
  for (const flag of ['Corrupted', 'Mirrored', 'Sanctified', 'Unidentified', 'Fractured Item']) {
    if (raw && new RegExp(`^${flag}\\s*$`, 'mi').test(raw)) specials.push(flag);
  }
  if (rarity === 'unique') specials.push('unique');
  if (!supportedEquipment(base)) specials.push('nonstandard equipment class');
  const allMods = searchMods({ itemTags: base.tags, limit: 0 }).filter(mod => ['Prefix', 'Suffix'].includes(mod.type));
  const pool = allMods.filter(mod => ilvl === undefined || mod.level <= ilvl);
  const identified = hasModList && ilvl !== undefined ? identifyAffixes(modifiers.filter(mod => mod.type === 'explicit').map(mod => mod.line), pool) : { ids: undefined, known: [] };
  let ids = args.existing_mod_ids ?? identified.ids;
  const idsConflict = !!(args.existing_mod_ids && hasModList && (identified.ids === undefined ||
    [...args.existing_mod_ids].sort().join('|') !== [...identified.ids].sort().join('|')));
  if (idsConflict) { ids = undefined; specials.push('supplied IDs do not match the complete raw affix list'); }
  const knownMods = ids ? ids.map(getMod).filter((mod): mod is PobMod => mod !== null) : identified.known;
  const sideCap = base.type === 'Jewel' ? 2 : 3;
  const duplicateIds = ids !== undefined && new Set(ids).size !== ids.length;
  const duplicateGroups = new Set(knownMods.map(mod => mod.group)).size !== knownMods.length;
  const ineligibleIds = args.existing_mod_ids !== undefined && knownMods.some(mod => !pool.some(eligible => eligible.id === mod.id));
  const currentCap = rarity === 'normal' ? 0 : rarity === 'magic' ? 1 : sideCap;
  const excessiveAffixes = knownMods.filter(mod => mod.type === 'Prefix').length > currentCap ||
    knownMods.filter(mod => mod.type === 'Suffix').length > currentCap;
  const inconsistent = duplicateIds || duplicateGroups || ineligibleIds || excessiveAffixes;
  if (inconsistent) specials.push('inconsistent supplied ordinary affix state (duplicates, ineligible IDs or rarity limits)');
  // An enchantment affects model coverage; it does not prohibit using currency.
  // Only established unmodifiable states or contradictory inputs block the route.
  const blocked = inconsistent || idsConflict || specials.some(flag => ['Corrupted', 'Mirrored', 'unique'].includes(flag));
  const occupancyKnown = !inconsistent && ids !== undefined && knownMods.length === ids.length;
  const prefix = occupancyKnown ? knownMods.filter(mod => mod.type === 'Prefix').length : null;
  const suffix = occupancyKnown ? knownMods.filter(mod => mod.type === 'Suffix').length : null;
  const occupied = new Set(knownMods.map(mod => mod.group));
  const count = prefix === null || suffix === null ? null : prefix + suffix;
  const targets = args.desired_mods?.length ? args.desired_mods.map(mod => mod.trim()) :
    ['Fire', 'Cold', 'Lightning', 'Chaos'].filter(kind => (validationStat(liveStats, 'Missing' + kind + 'Resist') ?? 0) > 0).map(kind => `${kind} Resistance`);
  lines.push('', '## Target item', `Base: ${base.name}; type: ${base.type}; native tags: ${base.tags.join(', ')}`,
    `Item level: ${ilvl ?? 'unknown'}`, `Rarity: ${rarity ?? 'unknown'}`,
    `Item state source: ${args.item_text ? 'supplied item_text' : raw ? 'selected native item' : args.existing_mod_ids ? 'supplied complete affix IDs and rarity; conditional model inputs' : 'base only'}`,
    `Implicit: ${base.implicit ?? 'none in native base definition'}`,
    `Current modifiers: ${hasModList ? (modifiers.length ? '' : 'none in the complete raw list') : args.existing_mod_ids ? args.existing_mod_ids.join(', ') || 'none (supplied complete list)' : 'unknown'}`);
  modifiers.forEach(mod => lines.push(`- [${mod.type}] ${mod.line}`));
  if (knownMods.length) lines.push(`Identified ordinary affixes: ${knownMods.map(mod => `${mod.id} (${mod.group})`).join('; ')}`);
  lines.push(`Prefixes: ${prefix ?? 'unknown'}; Suffixes: ${suffix ?? 'unknown'}; occupancy ${occupancyKnown ? 'established' : 'unknown'}`);
  if (specials.length) lines.push(`Special item state: ${[...new Set(specials)].join(', ')}; plain crafting model does not apply to this item.`);
  if (args.budget) lines.push(`Budget preference: ${args.budget}; no numeric spend limit supplied.`);

  lines.push('', '## Target modifier eligibility', 'Native PoB2 1/0 values establish eligibility only; they are not probability weights.');
  if (!targets.length) lines.push('No desired modifiers or measured resistance deficits supplied. Choose a modifier group from list_craftable_mods for this base before spending.');
  for (const target of targets) {
    const matching = allMods.filter(mod => mod.statLines.some(line => line.toLowerCase().includes(target.toLowerCase())) || mod.group.toLowerCase() === target.toLowerCase());
    const groups = [...new Set(matching.map(mod => mod.group))];
    lines.push(`Target: ${target}; ${groups.length} matching native group(s).`);
    if (!groups.length) lines.push('No ordinary eligible native group matched that exact description; refine the wording or inspect an essence-specific effect.');
    for (const group of groups.slice(0, 8)) {
      const tiers = matching.filter(mod => mod.group === group).sort((a, b) => b.level - a.level);
      const shown = ilvl === undefined ? tiers : [...tiers.filter(mod => mod.level <= ilvl), ...tiers.filter(mod => mod.level > ilvl).slice(-1)];
      lines.push(`- ${group} [${tiers[0].type}]; ${occupied.has(group) ? 'occupied: another mod in this group cannot be added' : occupancyKnown ? 'not occupied' : 'occupancy unknown'}`);
      for (const mod of shown.slice(0, 4)) lines.push(`  ${mod.id}: ${mod.statLines.join(' / ')}; ilvl ${mod.level}; ${ilvl === undefined ? 'item-level eligibility unknown' : mod.level > ilvl ? `requires ilvl ${mod.level}` : 'eligible at the supplied item level'}`);
    }
    if (groups.length > 8) lines.push('Showing eight groups; narrow the target for a complete tier comparison.');
  }

  lines.push('', '## Matching native essence effects');
  const essenceCandidates: Array<{ name: string; operation: 'upgrade' | 'replace'; group?: string }> = [];
  const essenceFile = join(location.dataDir, 'Essence.lua');
  try {
    const mapping = essenceOperations(essenceFile);
    for (const essence of findEssencesMatching('', getEssenceCount())) {
      const effect = resolveEssenceMods(essence.name, base.type)[0];
      if (!effect?.mod || !targets.some(target => effect.mod!.statLines.some(line => line.toLowerCase().includes(target.toLowerCase())) || effect.mod!.group.toLowerCase() === target.toLowerCase())) continue;
      const operation = mapping.get(essence.name);
      if (!operation) { lines.push(`${essence.name}: operation mapping unknown; ${effect.mod.statLines.join(' / ')}`); continue; }
      essenceCandidates.push({ name: essence.name, operation, group: effect.mod.group });
      if (essenceCandidates.length <= 16) lines.push(`- ${essence.name}: ${operation === 'upgrade' ? 'magic to rare; retain current mods and add the guaranteed modifier' : 'rare item; remove one random mod and add the guaranteed modifier'}; ${effect.mod.statLines.join(' / ')} [${effect.mod.type}; ${effect.mod.group}; ${effect.modId}]${occupied.has(effect.mod.group) ? '; group occupied: applicability must be checked before use' : ''}`);
    }
    if (!essenceCandidates.length) lines.push('No resolved native essence effect matched this base type and target text.');
    lines.push(`Essence definitions: ${sourceFile(essenceFile)}`, `Operation mapping checked ${REVIEWED}: ${ESSENCES}; GGG rework: ${ESSENCE_REWORK}. Native tierLevel is not used as an item-level requirement.`);
  } catch (error) { lines.push(`Essence definitions unavailable: ${error instanceof Error ? error.message : String(error)}. Ordinary mod advice remains available.`); }

  lines.push('', '## Craft operations for this item');
  const eligible = new Map<string, boolean | null>();
  for (const operation of operations) {
    let can: boolean | null = rarity === undefined ? null : operation.rarities.includes(rarity);
    if (blocked) can = false;
    else if (can && specials.some(flag => flag !== 'enchant')) can = null;
    let reason = '';
    if (can !== false && ['augment', 'exalt'].includes(operation.id)) {
      const cap = operation.id === 'augment' ? 2 : sideCap * 2;
      if (count === null) { can = null; reason = 'open affix slot unknown'; }
      else if (count >= cap) { can = false; reason = 'no open affix slot'; }
    }
    if (operation.id === 'annul' && count === 0) { can = false; reason = 'no affix to remove'; }
    eligible.set(operation.id, can);
    lines.push(`- ${operation.name}: ${operation.effect}. ${can === true ? specials.length ? 'Available at the reported rarity; inspect special effects before use' : 'Available under the plain-item assumptions' : can === false ? 'Ineligible for the supplied current state' : 'Conditional: establish rarity and item state'}${reason ? '; ' + reason : ''}. [Source](${operation.url}), checked ${REVIEWED}.`);
  }
  const matchingEssence = essenceCandidates.find(essence => essence.operation === 'upgrade' && !occupied.has(essence.group ?? ''));
  let chosen = args.method ?? (blocked ? 'replacement' : rarity === 'normal' ? 'transmute' :
    rarity === 'magic' ? matchingEssence ? 'essence' : count === 1 ? 'augment' : 'regal' : rarity === 'rare' ? count === null ? 'inspect' : count < sideCap * 2 ? 'exalt' : 'replacement' : 'replacement');
  lines.push('', '## Recommended next step');
  if (blocked || chosen === 'replacement') {
    chosen = 'replacement';
    lines.push(`Replacement route: start with an uncorrupted normal or magic ${base.name} at the item level required by the target group.`,
      'Use Transmutation on a normal base. Inspect the result, then compare a matching magic-to-rare Essence with Augmentation/Regal. Add further mods to a suitable rare only while an affix slot is open.',
      'Keep useful current equipment while evaluating the replacement. Candidate cost and success rate remain unknown until priced and modeled.');
  } else if (chosen === 'inspect') {
    lines.push('Inspect the current prefix/suffix occupancy and special modifier restrictions. If an ordinary rare has a free slot, compare one Exalted Orb against the eligible target groups; do not assume a free slot from an unresolved mod list.',
      'If the item is full, compare a replacement with the risk of losing a wanted modifier to Chaos. Keep the current item while making that comparison.');
  } else if (chosen === 'essence') {
    lines.push(matchingEssence && (rarity === 'magic' || rarity === undefined)
      ? `Compare ${matchingEssence.name} on a magic base: its native guaranteed effect matches a target group. Verify group compatibility and item state first; then inspect the resulting rare before another operation.`
      : 'No applicable matching magic-to-rare essence was established. Use the resolved effects above to choose a compatible item and rarity.');
  } else {
    const operation = operations.find(operation => operation.id === chosen);
    lines.push(operation ? `${operation.name}: ${eligible.get(chosen) === false ? 'do not apply to the supplied current state; prepare the required rarity or a replacement first' : 'check the eligible target groups and current affix slots, apply at most one operation, then inspect the changed item before continuing'}.`
      : `Method '${chosen}' has no verified operation mapping here. Choose a sourced operation above; no legacy method is substituted.`);
  }
  if (specials.length && !blocked) lines.push('Special-effect restrictions must be established before applying the chosen operation. If those restrictions prevent it, compare a replacement; numerical coverage alone does not determine whether an item can be crafted.');
  lines.push('Greater/Perfect orbs impose modifier-level bounds, which do not guarantee a top tier. Omens introduce additional effects. These variants and effects are outside the plain-operation odds below.');

  lines.push('', '## One-step odds');
  if (targets.some(target => /\d/.test(target))) {
    lines.push('Odds: unknown. Numeric target thresholds cannot be inferred from free text. Use calculate_mod_odds with an exact family and explicit min_tier; any-tier odds would answer a different question.');
  } else if (specials.length || ids === undefined || ilvl === undefined || !targets.length || !['augment', 'regal', 'exalt'].includes(chosen)) {
    lines.push('Odds: unknown. A modeled plain augment/regal/exalt needs item level, rarity, exact target text and a complete ordinary existing_mod_ids list. Special effects and replacement sequences require another model.');
  } else {
    try {
      const odds = calculatePoe2OneStepOdds(base, ilvl, { method: chosen, item_rarity: rarity,
        existing_mod_ids: ids, targets: targets.map(stat => ({ stat })) });
      if (odds.targets.every(target => target.already_satisfied)) lines.push('Matched target families are already present; no additional roll is needed to satisfy these unspecified-tier targets. Check actual values before choosing an upgrade.');
      else lines.push(`Probability: ${Number((odds.combined_probability * 100).toPrecision(10))}% for this one conditional operation.`,
        `Eligible weight: ${odds.pool.total_weight}; qualifying weight: ${odds.pool.qualifying_weight}.`);
      lines.push(`Modeled targets: ${odds.targets.map(target => `${target.label} (${target.group}; any source tier; ${target.already_satisfied ? 'already present' : 'must be added'})`).join('; ')}. No numeric roll threshold is implied.`);
      lines.push(`Source: ${odds.source.provider}; patch ${odds.source.patch}; weights ${odds.source.weight_kind}; fetched ${odds.source.fetched_at}; age ${odds.source.age_seconds}s; sha256=${odds.source.sha256}; ${odds.source.url}`,
        ...odds.assumptions, 'Repeated attempts and total currency cost are not modeled.');
    } catch (error) { lines.push(`Odds: unknown. ${error instanceof Error ? error.message : String(error)}`); }
  }

  lines.push('', '## Currency reference valuations');
  const requests = ['Currency', ...(essenceCandidates.length ? ['Essences'] : [])];
  const rates = await Promise.allSettled(requests.map(category => context.ninjaClient.getEconomyOverview(league, category)));
  for (let index = 0; index < rates.length; index++) {
    const result = rates[index];
    const category = requests[index];
    const overview: EconomyOverview | undefined = result.status === 'fulfilled' ? result.value : undefined;
    if (!overview || overview.provenance?.game !== 'poe2' || overview.provenance?.league !== league || overview.provenance?.category !== category) {
      lines.push(`${category} prices unavailable; currency values unknown${result.status === 'rejected' ? ': ' + String(result.reason) : ': source game/league/category not verified'}.`);
      continue;
    }
    const names = category === 'Currency' ? [...operations.map(operation => operation.name), 'Divine Orb'] : essenceCandidates.slice(0, 16).map(essence => essence.name);
    for (const name of names) {
      const matches = overview.rows.filter(row => row.name === name);
      const row = matches.length === 1 ? matches[0] : undefined;
      const chaos = row?.values.chaos;
      lines.push(`${name}: ${typeof chaos === 'number' && Number.isFinite(chaos) && chaos > 0 ? chaos + ' chaos per unit' : 'unknown'} (reference valuation).`);
    }
    const source = overview.provenance;
    lines.push(`Currency source: ${source.source}; game ${source.game}; league ${source.league}; fetched ${source.fetchedAt}; checked ${source.checkedAt}; cache age ${source.cacheAgeSeconds}s; market snapshot age ${source.sourceAgeSeconds ?? 'unknown'}.`);
  }
  lines.push('Valuations are not executable buy/sell quotes. Total crafting cost, availability and repeated-attempt odds are unknown.');
  lines.push('', '## Native definition provenance', sourceFile(join(getBasesDir(), base.sourceFile.replace(/\.lua$/, '') + '.lua')), sourceFile(getModItemPath()));
  return lines.join('\n');
}
