/** Read-only PoE2 shopping evidence, selected sets and bounded public listings. */
import type { PoBBuild } from '../types.js';
import { TradeApiClient, tradeSearchUrl } from './tradeClient.js';
import { StatMapper } from './statMapper.js';
import { PoeNinjaClient, withCurrencyAliases, type ItemPriceMatch } from './poeNinjaClient.js';
import { TradeQueryBuilder } from './tradeQueryBuilder.js';
import { ItemRecommendationEngine, applyItemSpiritRequirement, type UpgradeContext } from './itemRecommendationEngine.js';
import { CostBenefitAnalyzer, getChaosRate, getListingPrice, itemModifierLines, normalizeCurrencyId, priceInCurrency } from './costBenefitAnalyzer.js';
import { SkillGemService, type GemReadOptions } from './skillGemService.js';
import { extractPoe2SkillSets, xmlBoolean } from '../skillLinkOptimizer.js';
import { getBase, type PobBase } from './pobBaseDataLoader.js';
import { resolvePobDataLocation } from './pobDataPath.js';
import { parseItemRawMods } from '../utils/itemRawParser.js';
import { validationStat } from './passiveBudget.js';
import type { ItemListing, TradeQuery } from '../types/tradeTypes.js';

export type UpgradePriority = 'critical' | 'high' | 'medium' | 'low';
export type BudgetTier = 'budget' | 'medium' | 'endgame';
export type ShoppingRequirements = NonNullable<UpgradeContext['itemRequirements']> & { itemName?: string };
export interface ShoppingOptions {
  budget?: number;
  currency?: string;
  maxPricePerItem?: number;
  slots?: string[];
  itemRequirements?: Record<string, ShoppingRequirements>;
  runeTargets?: Record<string, string[]>;
  includeGems?: boolean;
  priority?: 'dps' | 'defense' | 'resistance' | 'balanced';
  limitPerSlot?: number;
  maxSearches?: number;
  stats?: Record<string, unknown>;
  sourceNote?: string;
  source?: 'file' | 'live';
  gemOptions?: GemReadOptions;
}
export interface ShoppingDependencies {
  recommendationEngine?: Pick<ItemRecommendationEngine, 'findUpgrades'>;
  skillGemService?: Pick<SkillGemService, 'prepareBuild'>;
  baseLookup?: (name: string) => PobBase | null;
}
export interface ShoppingCandidate {
  listingId: string;
  name: string;
  baseType: string;
  price?: { amount: number; currency: string };
  priceInBudgetCurrency?: number;
  url: string;
  source: { league: string; queryId: string; checkedAt: string; indexed?: string; kind: 'listing' };
  itemEvidence: ReturnType<CostBenefitAnalyzer['analyzeItem']>['stats'];
  mods: string[];
  warnings: string[];
}
export interface ShoppingListItem {
  id: string;
  kind: 'equipment' | 'charm' | 'gem' | 'rune';
  slot: string;
  priority: UpgradePriority;
  reason: string[];
  warnings: string[];
  currentItem?: { id?: string; name: string; baseType: string; rarity: string; issues: string[]; active?: boolean };
  requirements: ShoppingRequirements;
  search: { query?: TradeQuery; url?: string; name?: string; category?: string };
  candidates: ShoppingCandidate[];
  price: { status: 'listed' | 'unpriced'; amount?: number; currency?: string };
  referencePrice?: ItemPriceMatch;
  /** Remains empty until an actual native replacement calculation is supplied. */
  estimatedImpact: { life?: number; es?: number; dps?: number; resistances?: number };
  gem?: { gemId?: string; groupIndex: number; gemIndex: number; currentLevel?: number; targetLevel?: number;
    currentQuality?: number; targetQuality?: number; levelRequirement?: number; requirementsMet?: boolean;
    attributes?: { str?: number; dex?: number; int?: number }; metadataSource?: string };
}
export interface ShoppingList {
  buildName: string;
  league: string;
  source: { kind: 'file' | 'live'; note: string };
  selection: { itemSetId?: string; skillSetId: string; weaponSet: 1 | 2 };
  summary: { totalItems: number; criticalUpgrades: number; quotedItems: number; unpricedItems: number;
    quotedSubtotal?: number; currency: string; requestedBudget?: number;
    totalBudgetCost?: never; totalMediumCost?: never; totalEndgameCost?: never };
  items: ShoppingListItem[];
  priorities: { immediate: string[]; shortTerm: string[]; longTerm: string[] };
  buildNeeds: { lifeNeeded?: number; esNeeded?: number; currentDPS?: number;
    resistanceGaps: Partial<Record<'fire' | 'cold' | 'lightning' | 'chaos', number>>;
    attributes: Partial<Record<'str' | 'dex' | 'int', number>>; spiritShortfall?: number };
  gems: Array<{ name: string; gemId?: string; groupIndex: number; gemIndex: number; level?: number; naturalMaxLevel?: number; support?: boolean; source?: string }>;
  runes: Array<{ slot: string; capacity?: number; occupied: string[]; empty?: number; warnings: string[] }>;
  charms: { capacity?: number; beltCapacity?: number; capacitySource: 'native-output' | 'belt-header' | 'unknown'; equipped: number; warnings: string[] };
  warnings: string[];
}
const many = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const finite = (value: unknown): number | undefined => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return undefined;
  const n = Number(value); return Number.isFinite(n) ? n : undefined;
};
const resistanceTypes = ['fire', 'cold', 'lightning', 'chaos'] as const;
const title = (s: string) => s[0].toUpperCase() + s.slice(1);
const normalizeSlot = (s: string) => s.trim().replace(/^(Weapon|Ring)(\d)/, '$1 $2');
const normalizedKeys = <T>(values: Record<string, T> | undefined): Record<string, T> | undefined => {
  if (!values) return undefined;
  const result: Record<string, T> = Object.create(null);
  for (const [slot, value] of Object.entries(values)) {
    const key = normalizeSlot(slot);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`Conflicting constraints for slot ${key}`);
    result[key] = value;
  }
  return result;
};
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const nonnegative = (name: string, n: number | undefined) => { if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new Error(`${name} must be a finite non-negative number`); };

interface Equipped { slot: string; raw?: string; itemId?: string; active?: boolean; dangling: boolean }
interface ParsedEquipment { current: NonNullable<ShoppingListItem['currentItem']>; baseline: NonNullable<UpgradeContext['currentItem']>; base?: PobBase; runes: ShoppingList['runes'][number]; runeAssignments: string[]; charmCapacity?: number; warnings: string[] }

export class ShoppingListService {
  private readonly analyzer = new CostBenefitAnalyzer();
  constructor(private tradeClient?: TradeApiClient, private statMapper?: StatMapper, private ninjaClient?: PoeNinjaClient,
    private dependencies: ShoppingDependencies = {}) {}

  async generateShoppingList(build: PoBBuild, buildName: string, league: string, budget: BudgetTier | number = 'medium', options: ShoppingOptions = {}): Promise<ShoppingList> {
    if (build.__xmlRoot !== 'PathOfBuilding2') throw new Error('Shopping requires a verified PathOfBuilding2 build.');
    if (typeof budget === 'string' && !['budget', 'medium', 'endgame'].includes(budget)) throw new Error('Unknown budget tier');
    options = { ...options, budget: options.budget ?? (typeof budget === 'number' ? budget : undefined),
      itemRequirements: normalizedKeys(options.itemRequirements), runeTargets: normalizedKeys(options.runeTargets) };
    nonnegative('budget', options.budget); nonnegative('maxPricePerItem', options.maxPricePerItem);
    const limit = options.limitPerSlot ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limitPerSlot must be from 1 to 20');
    const maxSearches = options.maxSearches ?? 12;
    if (!Number.isInteger(maxSearches) || maxSearches < 0 || maxSearches > 30) throw new Error('maxSearches must be from 0 to 30');
    const currency = normalizeCurrencyId(options.currency ?? 'chaos');
    if (!currency) throw new Error('Specify a budget currency');
    const { selection, slots, notes, characterRunes, allSlots } = this.selectedEquipment(build);
    const skillModel = extractPoe2SkillSets(build);
    const stats: Record<string, unknown> = options.stats ?? Object.fromEntries(many(build.Build?.PlayerStat).flatMap(row => {
      const n = finite(row.value); return n === undefined ? [] : [[row.stat, n]];
    }));
    const buildNeeds = this.buildNeeds(stats);
    const warnings = [...notes, 'Item modifiers and listing prices are candidate evidence. Build DPS, EHP and replacement gains require a native calculation.',
      'Quoted subtotal covers one distinct observed listing per priced entry. Joint availability, currency execution and the completed build are not guaranteed.'];
    if (typeof budget === 'string') warnings.push(`Budget tier '${budget}' is descriptive only; no prices or spending limits are inferred from it.`);
    if (!league?.trim()) warnings.push('An explicit league is required for market queries; search constraints remain available.');
    let rates = new Map<string, number>();
    if (this.ninjaClient && league?.trim()) {
      try { rates = withCurrencyAliases(await this.ninjaClient.getCurrencyExchangeMap(league)); }
      catch (e) { warnings.push(`Reference exchange rates unavailable: ${errorText(e)}. Same-currency listing prices remain usable.`); }
    }
    if (this.tradeClient && this.statMapper && league?.trim()) {
      try { await this.statMapper.loadFromTradeAPI(await this.tradeClient.getStats()); }
      catch (e) { warnings.push(`Trade stat metadata unavailable: ${errorText(e)}`); }
    }
    const selectedSlots = options.slots ? new Set(options.slots.map(normalizeSlot)) : undefined;
    const requestedSlots = new Set([...(selectedSlots ?? []), ...Object.keys(options.itemRequirements ?? {}), ...Object.keys(options.runeTargets ?? {})]);
    for (const slot of requestedSlots) {
      if (selectedSlots && !selectedSlots.has(slot)) throw new Error(`Constraints for ${slot} conflict with the requested slots selection`);
      if (!slots.some(s => s.slot === slot)) {
      // Explicit requests are retained even if the XML omits that slot.
        slots.push(allSlots.find(s => s.slot === slot) ?? { slot, dangling: false });
      }
    }
    const rows: ShoppingListItem[] = [], runes: ShoppingList['runes'] = [...characterRunes];
    const equipment = new Map<string, ParsedEquipment>();
    for (const slot of slots) {
      if (slot.raw) equipment.set(slot.slot, this.parseEquipment(slot));
    }
    for (const slot of Object.keys(options.runeTargets ?? {})) if (!equipment.has(slot)) throw new Error(`Cannot resolve rune target equipment in ${slot}`);
    const beltCapacity = equipment.get('Belt')?.charmCapacity;
    const measuredLimit = validationStat(stats, 'CharmLimit');
    const effectiveLimit = measuredLimit !== null && Number.isInteger(measuredLimit) && measuredLimit >= 0 ? measuredLimit : undefined;
    const charmCapacity = effectiveLimit ?? beltCapacity;
    const equippedCharms = slots.filter(s => /^Charm \d+$/.test(s.slot) && s.raw);
    const charms: ShoppingList['charms'] = { capacity: charmCapacity, beltCapacity,
      capacitySource: effectiveLimit !== undefined ? 'native-output' : beltCapacity !== undefined ? 'belt-header' : 'unknown', equipped: equippedCharms.length, warnings: [] };
    if (charmCapacity === undefined) charms.warnings.push('Charm capacity is missing from the selected belt evidence.');
    else if (equippedCharms.length > charmCapacity) charms.warnings.push(`Selected set has ${equippedCharms.length} charms but observed capacity is ${charmCapacity}; verify native charm slots.`);
    if (effectiveLimit === undefined && beltCapacity !== undefined) charms.warnings.push('Belt capacity alone does not include character modifiers; effective native CharmLimit is unavailable.');
    for (const slot of slots) {
      if (selectedSlots && !selectedSlots.has(slot.slot)) continue;
      const parsed = equipment.get(slot.slot);
      // Empty offhands, transformed limbs and extra rings are not automatically deficits.
      if (!parsed && !slot.dangling && !selectedSlots?.has(slot.slot) && !options.itemRequirements?.[slot.slot]) continue;
      const row = this.equipmentEntry(slot, parsed, buildNeeds, options);
      if (/^Weapon [12]( Swap)?$/.test(slot.slot) && slot.slot.endsWith(' Swap') !== (selection.weaponSet === 2)) {
        row.warnings.push('Explicitly requested inactive weapon slot; current native build stats describe the active weapon set.');
      }
      rows.push(row);
      if (parsed) {
        runes.push(parsed.runes);
        const targets = options.runeTargets?.[slot.slot];
        if (targets && parsed.runes.capacity !== undefined && targets.length > parsed.runes.capacity) throw new Error(`Rune targets exceed the observed socket capacity for ${slot.slot}`);
        for (const [index, name] of (targets ?? []).entries()) {
          if (!name?.trim() || name === 'None' || name === parsed.runeAssignments[index]) continue;
          const rune = this.emptyEntry(`rune:${slot.slot}:${index + 1}`, 'rune', `${slot.slot} Rune ${index + 1}`);
          rune.search = { name, category: 'currency.socketable' };
          rune.reason.push(`Requested socketable: ${name}.`);
          rune.warnings.push('Verify the rune effect for this equipment class, replacement rules and any native socket restrictions.');
          rows.push(rune);
        }
      }
    }
    const gems: ShoppingList['gems'] = [];
    if (options.includeGems !== false) await this.gemEntries(build, stats, options, rows, gems, warnings);
    let searchCount = 0, referenceCount = 0;
    for (const row of rows) {
      if (row.kind === 'gem' && row.gem?.requirementsMet === false) continue;
      if (row.warnings.some(w => w.startsWith('Missing item reference'))) continue;
      try { row.search.query = this.queryFor(row); }
      catch (e) { row.warnings.push(`Search constraints could not be resolved: ${errorText(e)}`); }
      if (row.search.query && this.tradeClient && league?.trim() && searchCount < maxSearches) {
        searchCount++;
        try { await this.searchEntry(row, league, currency, rates, options, limit, equipment.get(row.slot)); }
        catch (e) { row.warnings.push(`Listing search unavailable: ${errorText(e)}`); }
      } else if (row.search.query && this.tradeClient && searchCount >= maxSearches) {
        row.warnings.push('Bounded search limit reached; these concrete requirements have not been priced.');
      }
      if (row.search.name && this.ninjaClient?.getItemPrice && league?.trim() && referenceCount < maxSearches && (row.kind === 'rune' || row.currentItem?.rarity === 'UNIQUE')) {
        referenceCount++;
        try {
          const category = row.kind === 'rune' ? (/Soul Core/.test(row.search.name) ? 'SoulCores' : /Idol/.test(row.search.name) ? 'Idols' : 'Runes')
            : row.search.category?.startsWith('weapon.') ? 'UniqueWeapons' : row.search.category?.startsWith('accessory.') ? 'UniqueAccessories'
              : row.kind === 'charm' ? 'UniqueCharms' : 'UniqueArmours';
          const result = await this.ninjaClient.getItemPrice(league, row.search.name, { category,
            ...(row.kind !== 'rune' && row.currentItem?.baseType ? { baseType: row.currentItem.baseType } : {}) });
          if (result.status === 'priced' && result.price?.provenance.game === 'poe2' && result.price.provenance.league === league) row.referencePrice = result.price;
          else row.warnings.push(`Reference estimate is ${result.status}; no unique price was selected.`);
        } catch (e) { row.warnings.push(`Reference estimate unavailable: ${errorText(e)}`); }
      }
      if (!row.candidates.some(c => c.price)) row.warnings.push('Unpriced: no valid asking price was obtained for this entry.');
    }
    const priority = { critical: 0, high: 1, medium: 2, low: 3 };
    rows.sort((a, b) => priority[a.priority] - priority[b.priority]);
    let quotedSubtotal = 0, quotedItems = 0;
    const used = new Set<string>();
    for (const row of rows) {
      const chosen = row.candidates.find(c => c.priceInBudgetCurrency !== undefined && !used.has(c.listingId));
      if (!chosen) continue;
      used.add(chosen.listingId); quotedSubtotal += chosen.priceInBudgetCurrency!; quotedItems++;
    }
    return { buildName, league, source: { kind: options.source ?? 'file', note: options.sourceNote ?? 'Saved PoB2 XML; saved calculated stats may be stale.' },
      selection: { ...selection, skillSetId: skillModel.selected.id }, items: rows, buildNeeds, gems, runes, charms, warnings,
      summary: { totalItems: rows.length, criticalUpgrades: rows.filter(r => r.priority === 'critical').length,
        quotedItems, unpricedItems: rows.length - quotedItems, ...(quotedItems ? { quotedSubtotal } : {}), currency, requestedBudget: options.budget },
      priorities: { immediate: rows.filter(r => r.priority === 'critical').map(r => r.slot), shortTerm: rows.filter(r => r.priority === 'high').map(r => r.slot),
        longTerm: rows.filter(r => ['medium', 'low'].includes(r.priority)).map(r => r.slot) } };
  }

  private selectedEquipment(build: PoBBuild): { selection: { itemSetId?: string; weaponSet: 1 | 2 }; slots: Equipped[]; allSlots: Equipped[]; notes: string[]; characterRunes: ShoppingList['runes'] } {
    const items: any = build.Items ?? {}, sets = many<any>(items.ItemSet);
    if (new Set(sets.map(s => String(s.id))).size !== sets.length) throw new Error('Duplicate PoE2 item set IDs');
    const id = items.activeItemSet !== undefined ? String(items.activeItemSet) : sets.length === 1 ? String(sets[0].id) : undefined;
    const set = sets.find(s => String(s.id) === id);
    if (sets.length && !set) throw new Error(`Selected PoE2 item set ${id ?? '(missing)'} not found`);
    const container = set ?? items;
    const second = xmlBoolean(container.useSecondWeaponSet ?? items.useSecondWeaponSet, false);
    const rawItems = new Map<string, string>();
    for (const item of many<any>(items.Item)) {
      if (item.id === undefined || typeof item['#text'] !== 'string') continue;
      if (rawItems.has(String(item.id))) throw new Error('Duplicate item IDs in the build');
      rawItems.set(String(item.id), item['#text']);
    }
    const allSlots: Equipped[] = many<any>(container.Slot).filter(s => typeof s.name === 'string').map(s => {
      const slot = normalizeSlot(s.name), itemId = s.itemId === undefined ? undefined : String(s.itemId);
      const raw = itemId && itemId !== '0' ? rawItems.get(itemId) : !itemId && typeof s.Item === 'string' ? s.Item : undefined;
      return { slot, itemId, raw, dangling: !!itemId && itemId !== '0' && !raw, active: s.active === undefined ? undefined : xmlBoolean(s.active, false) };
    });
    const slots = allSlots.filter(s => !/^Weapon [12]( Swap)?$/.test(s.slot) || s.slot.endsWith(' Swap') === second);
    if (new Set(slots.map(s => s.slot)).size !== slots.length) throw new Error('Duplicate slot assignments in the selected item set');
    const characterRunes = many<any>(container.RuneSlot).filter(r => typeof r.slotName === 'string').map(r => ({ slot: r.slotName,
      occupied: typeof r.runeName === 'string' && r.runeName !== 'None' ? [r.runeName] : [],
      warnings: ['Selected character rune assignment; availability follows native character rules, independently of physical equipment sockets.'] }));
    return { selection: { itemSetId: id, weaponSet: second ? 2 : 1 }, slots, allSlots, characterRunes, notes: slots.length ? [] : ['No selected equipment slots were present; missing equipment remains unknown.'] };
  }

  private parseEquipment(slot: Equipped): ParsedEquipment {
    const raw = slot.raw!, lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const rarity = lines.find(s => s.startsWith('Rarity:'))?.slice(7).trim().toUpperCase() ?? 'UNKNOWN';
    const rarityIndex = lines.findIndex(s => s.startsWith('Rarity:'));
    const name = lines[rarityIndex + 1] ?? '(unnamed item)';
    const baseType = ['RARE', 'UNIQUE'].includes(rarity) ? lines[rarityIndex + 2] ?? '' : name;
    const warnings: string[] = [];
    let base: PobBase | undefined;
    try {
      if (!this.dependencies.baseLookup && resolvePobDataLocation().game !== 'poe2') throw new Error('Base catalog is not PoE2');
      base = (this.dependencies.baseLookup ?? getBase)(baseType) ?? undefined;
    } catch (e) { warnings.push(`Native base metadata unavailable: ${errorText(e)}`); }
    const mods = parseItemRawMods(raw);
    // PoB raw defense headers are not assumed to be final trade item properties.
    const evidence = this.analyzer.analyzeItem({ item: { identified: true, explicitMods: mods.map(m => m.line) }, listing: {} } as ItemListing);
    const baseline: NonNullable<UpgradeContext['currentItem']> = { name, slot: slot.slot, resistances: {} };
    const ambiguous = /\{variant[:}]|\{range[:}]|\(\d+[–-]\d+\)/.test(raw);
    if (/^Implicits:/m.test(raw) && !ambiguous) {
      if (!evidence.unparsedMods.some(m => /life/i.test(m))) baseline.life = evidence.stats.life;
      for (const r of resistanceTypes) if (!evidence.unparsedMods.some(m => /resistan/i.test(m))) baseline.resistances![r] = evidence.stats[`${r}Resist`];
    } else warnings.push('Raw modifiers include unresolved ranges/variants or missing mod boundaries; replacement stat baselines remain unknown.');
    const sockets = raw.match(/^Sockets:\s*([^\r\n]*)/m)?.[1].trim().split(/\s+/);
    const capacity = sockets?.every(s => s === 'S') ? sockets.length : undefined;
    const assignments = [...raw.matchAll(/^Rune:\s*([^\r\n]*)/gm)].map(m => m[1].trim());
    const occupied = assignments.filter(name => name && name !== 'None');
    const runeWarnings: string[] = [];
    if (capacity !== undefined && assignments.length !== capacity) runeWarnings.push('Rune assignment count differs from socket capacity; empty sockets are not fully known.');
    const charm = finite(raw.match(/^Charm Slots:\s*(\d+)/m)?.[1]);
    return { current: { id: slot.itemId, name, baseType, rarity, issues: [], active: slot.active }, baseline, base, warnings,
      runes: { slot: slot.slot, capacity, occupied, empty: capacity !== undefined && assignments.length === capacity ? capacity - occupied.length : undefined, warnings: runeWarnings }, runeAssignments: assignments, charmCapacity: charm };
  }

  private buildNeeds(stats: Record<string, unknown>): ShoppingList['buildNeeds'] {
    const resistanceGaps: ShoppingList['buildNeeds']['resistanceGaps'] = {};
    for (const r of resistanceTypes) {
      const gap = validationStat(stats, `Missing${title(r)}Resist`);
      if (gap !== null) resistanceGaps[r] = Math.max(0, gap);
    }
    const attributes: ShoppingList['buildNeeds']['attributes'] = {};
    for (const a of ['str', 'dex', 'int'] as const) {
      const have = validationStat(stats, title(a)), need = validationStat(stats, `Req${title(a)}`);
      if (have !== null && need !== null) attributes[a] = Math.max(0, need - have);
    }
    const spirit = validationStat(stats, 'SpiritUnreserved');
    return { resistanceGaps, attributes, ...(spirit === null ? {} : { spiritShortfall: Math.max(0, -spirit) }),
      ...(validationStat(stats, 'CombinedDPS') !== null ? { currentDPS: validationStat(stats, 'CombinedDPS')! }
        : validationStat(stats, 'TotalDPS') !== null ? { currentDPS: validationStat(stats, 'TotalDPS')! } : {}) };
  }

  private emptyEntry(id: string, kind: ShoppingListItem['kind'], slot: string): ShoppingListItem {
    return { id, kind, slot, priority: 'low', reason: [], warnings: [], requirements: {}, search: {}, candidates: [], price: { status: 'unpriced' }, estimatedImpact: {} };
  }

  private equipmentEntry(slot: Equipped, parsed: ParsedEquipment | undefined, needs: ShoppingList['buildNeeds'], options: ShoppingOptions): ShoppingListItem {
    const row = this.emptyEntry(`equipment:${slot.slot}`, /^Charm \d+$/.test(slot.slot) ? 'charm' : 'equipment', slot.slot);
    row.currentItem = parsed?.current;
    row.requirements = { ...options.itemRequirements?.[slot.slot] };
    row.warnings.push(...parsed?.warnings ?? []);
    if (slot.dangling) row.warnings.push(`Missing item reference ${slot.itemId} in selected slot ${slot.slot}; this is not a confirmed empty slot.`);
    else if (!parsed) row.reason.push('No item is referenced in this selected slot; confirm that this slot is available and intended for the build.');
    else row.reason.push(`Inspect replacements for selected item ${parsed.current.name} (item ID ${slot.itemId ?? 'inline'}).`);
    if (row.kind === 'charm') row.warnings.push(`Charm effect is conditional on its trigger, charges and duration; PoB activation is ${slot.active === undefined ? 'unknown' : slot.active ? 'enabled' : 'disabled'}.`);
    if (parsed?.runes.capacity) row.warnings.push(`Equipment has ${parsed.runes.capacity} rune sockets; preserve or re-evaluate its socketed effects separately from skill supports.`);
    if (options.priority !== 'dps' && !/^(Weapon|Charm|Flask)/.test(slot.slot)) {
      for (const r of resistanceTypes) if ((needs.resistanceGaps[r] ?? 0) > 0) {
        const key = `${r}Resist` as const, baseline = parsed?.baseline.resistances?.[r];
        const minimum = needs.resistanceGaps[r]! + (baseline ?? 0);
        row.requirements[key] = Math.max(row.requirements[key] ?? 0, minimum);
        row.priority = 'high';
        row.reason.push(`Measured ${r} resistance shortfall ${needs.resistanceGaps[r]}; search for at least ${minimum} on the candidate${baseline === undefined ? ' (current contribution unknown)' : `, replacing ${baseline} on the current item`}.`);
      }
    }
    if (parsed?.current.rarity === 'UNIQUE' && !row.requirements.itemName) {
      row.requirements.itemName = parsed.current.name;
      row.warnings.push('Search retains the selected unique identity; changing its special effects needs native evaluation.');
    }
    if (!row.requirements.itemCategory && parsed?.base) {
      const byType = new TradeQueryBuilder().withType(parsed.base.type.replace(/Handed/g, 'Hand')).build().query.filters?.type_filters?.filters?.category?.option;
      if (byType) row.requirements.itemCategory = byType;
    }
    row.search = { name: row.requirements.itemName, category: row.requirements.itemCategory };
    if (row.kind === 'charm' && !row.search.name && parsed) row.requirements.baseType = parsed.current.baseType;
    return row;
  }

  private async gemEntries(build: PoBBuild, stats: Record<string, unknown>, options: ShoppingOptions, rows: ShoppingListItem[], gems: ShoppingList['gems'], warnings: string[]) {
    const model = await (this.dependencies.skillGemService ?? new SkillGemService()).prepareBuild(build, options.gemOptions);
    warnings.push(...model.notes);
    for (const group of model.groups.filter(g => g.enabled)) for (const gem of group.gems.filter(g => g.enabled !== false)) {
      gems.push({ name: gem.name, gemId: gem.gemId, groupIndex: group.index, gemIndex: gem.index ?? 1, level: gem.level,
        naturalMaxLevel: gem.data?.naturalMaxLevel, support: gem.isSupport, source: group.source });
      if (!gem.data || gem.error) warnings.push(`${gem.name}: unresolved or invalid native gem metadata; no level or price is inferred.`);
      if (group.source || gem.error || gem.corrupted) continue;
      const cap = gem.data?.naturalMaxLevel;
      const targetLevel = cap !== undefined && gem.level !== undefined && gem.level < cap ? cap : undefined;
      const targetQuality = gem.data?.qualityLines?.length && gem.quality !== undefined && gem.quality < 20 ? 20 : undefined;
      if (targetLevel === undefined && targetQuality === undefined) continue;
      const row = this.emptyEntry(`gem:${model.selected.id}:${group.index}:${gem.index}`, 'gem', `Skill group ${group.index}, gem ${gem.index}`);
      const requirements = gem.data?.perLevel?.find(r => r.level === (targetLevel ?? gem.level));
      const level = finite(build.Build?.level);
      const checks: Array<boolean | undefined> = [requirements?.levelRequirement === undefined || level === undefined ? undefined : level >= requirements.levelRequirement];
      for (const [key, stat] of [['reqStr', 'Str'], ['reqDex', 'Dex'], ['reqInt', 'Int']] as const) {
        const need = requirements?.[key], have = validationStat(stats, stat);
        checks.push(need === undefined ? undefined : need === 0 ? true : have === null ? undefined : have >= need);
      }
      const met = checks.includes(false) ? false : checks.some(c => c === undefined) ? undefined : true;
      row.gem = { gemId: gem.data?.gemId ?? gem.gemId, groupIndex: group.index, gemIndex: gem.index ?? 1,
        currentLevel: gem.level, targetLevel, currentQuality: gem.quality, targetQuality, levelRequirement: requirements?.levelRequirement,
        requirementsMet: met, attributes: { str: requirements?.reqStr, dex: requirements?.reqDex, int: requirements?.reqInt }, metadataSource: gem.data?.source };
      row.search = { name: gem.name, category: gem.isSupport ? 'gem.supportgem' : gem.data?.tags.some(t => t.toLowerCase() === 'meta') ? 'gem.metagem' : 'gem.activegem' };
      row.reason.push(`${gem.name}: ${targetLevel === undefined ? '' : `level ${gem.level} → natural cap ${targetLevel}`}${targetQuality === undefined ? '' : ` quality ${gem.quality} → ${targetQuality}`}.`);
      if (met === false) row.warnings.push(`Target gem requirements are not met (character level ${requirements?.levelRequirement ?? 'unknown'}, attributes ${JSON.stringify(row.gem.attributes)}).`);
      if (met === undefined) row.warnings.push('Target character/attribute requirements are incomplete; confirm them in native PoB before replacing the gem.');
      row.warnings.push('Gem purchase is an alternative to progression or quality changes; no free price or build-DPS gain is assumed.');
      rows.push(row);
    }
  }

  private queryFor(row: ShoppingListItem): TradeQuery {
    const requirements = row.requirements;
    let builder: TradeQueryBuilder;
    if (row.kind === 'rune' || row.kind === 'gem') {
      builder = new TradeQueryBuilder().withCategory(row.search.category!).withType(row.search.name!);
      if (row.gem) {
        const level = row.gem.targetLevel ?? row.gem.currentLevel;
        builder.withGemLevel(level, level);
        if ((row.gem.targetQuality ?? row.gem.currentQuality) !== undefined) builder.withQuality(row.gem.targetQuality ?? row.gem.currentQuality);
      }
    } else {
      builder = TradeQueryBuilder.fromItemRequirements({ slot: row.slot, itemCategory: requirements.itemCategory });
      if (requirements.baseType) builder.withType(requirements.baseType);
      if (requirements.itemName) builder.withName(requirements.itemName);
      const numeric = ['minLife', 'minES', 'minArmour', 'minEvasion', 'minDPS', 'minPDPS', 'minEDPS', 'minSpirit', 'minWard', 'minRuneSockets', 'fireResist', 'coldResist', 'lightningResist', 'chaosResist'] as const;
      const supported = [...numeric, 'itemName', 'itemCategory', 'baseType', 'stats', 'links', 'sockets'];
      for (const key of Object.keys(requirements)) if (!supported.includes(key)) throw new Error(`Unknown item requirement ${key}`);
      for (const key of numeric) nonnegative(key, requirements[key]);
      const statFilters = [...requirements.stats ?? []];
      if (requirements.minLife !== undefined) statFilters.push({ id: this.statId('Life', 'pseudo.pseudo_total_life'), min: requirements.minLife });
      for (const r of resistanceTypes) if (requirements[`${r}Resist`] !== undefined) statFilters.push({ id: this.statId(`${title(r)}Resist`, `pseudo.pseudo_total_${r}_resistance`), min: requirements[`${r}Resist`] });
      if (statFilters.length) builder.withStats(statFilters);
      if (requirements.minES !== undefined || requirements.minArmour !== undefined || requirements.minEvasion !== undefined) builder.withDefenses(
        requirements.minArmour === undefined ? undefined : { min: requirements.minArmour },
        requirements.minEvasion === undefined ? undefined : { min: requirements.minEvasion }, requirements.minES === undefined ? undefined : { min: requirements.minES });
      if (requirements.minDPS !== undefined) builder.withDPS(requirements.minDPS);
      if (requirements.minPDPS !== undefined) builder.withPDPS(requirements.minPDPS);
      if (requirements.minEDPS !== undefined) builder.withEDPS(requirements.minEDPS);
      if (requirements.minRuneSockets !== undefined) builder.withRuneSockets(requirements.minRuneSockets);
      if (requirements.minSpirit !== undefined) applyItemSpiritRequirement(builder, requirements.minSpirit, this.statMapper);
      if (requirements.minWard !== undefined) builder.withWard(requirements.minWard);
      if (requirements.links !== undefined) builder.withLinks(requirements.links);
      if (requirements.sockets) builder.withSockets(requirements.sockets.r, requirements.sockets.g, requirements.sockets.b, requirements.sockets.w);
    }
    return builder.withOnlineStatus('available').withSort('price', 'asc').build();
  }

  private statId(name: string, id: string): string {
    const mapped = this.statMapper?.getTradeId(name);
    if (mapped) return mapped;
    if (this.statMapper?.getPobName(id)) return id;
    throw new Error(`Required verified trade stat mapping ${name} is unavailable`);
  }

  private async searchEntry(row: ShoppingListItem, league: string, currency: string, rates: Map<string, number>, options: ShoppingOptions,
    limit: number, equipped?: ParsedEquipment) {
    const maxPrice = options.maxPricePerItem === undefined ? options.budget : options.budget === undefined ? options.maxPricePerItem : Math.min(options.budget, options.maxPricePerItem);
    const { itemName, ...constraints } = row.requirements;
    const useEngine = maxPrice !== undefined && row.kind === 'equipment' && !itemName && this.statMapper;
    const checkedAt = new Date().toISOString();
    const query = row.search.query!;
    if (maxPrice !== undefined) {
      const from = getChaosRate(currency, rates), to = getChaosRate('exalted', rates);
      const converted = currency === 'exalted' ? maxPrice : from !== undefined && to !== undefined ? maxPrice * from / to : undefined;
      const equivalent = converted !== undefined && Number.isFinite(converted) ? converted : undefined;
      const price = new TradeQueryBuilder().withPriceRange(undefined, equivalent ?? maxPrice, equivalent === undefined ? currency : null).build().query.filters!.trade_filters;
      query.query.filters ??= {}; query.query.filters.trade_filters = price;
      if (equivalent === undefined) row.warnings.push(`Budget search is limited to ${currency}-denominated listings; other currencies may be missed.`);
    }
    if (useEngine) {
      const engine = this.dependencies.recommendationEngine ?? new ItemRecommendationEngine(this.tradeClient!, this.statMapper!, this.ninjaClient);
      const candidates = await engine.findUpgrades(row.slot, { currentItem: equipped?.baseline, buildNeeds: {}, itemRequirements: constraints,
        budget: { maxPricePerItem: maxPrice!, totalBudget: options.budget ?? maxPrice!, currency }, league, currencyRates: rates });
      row.candidates = candidates.slice(0, limit).map(rec => this.candidate(rec.listing, rec.searchId, league, checkedAt, currency, rates, rec.warnings));
      if (row.candidates[0]) row.search.url = row.candidates[0].url;
    } else {
      const search = await this.tradeClient!.searchItems(league, query);
      row.search.url = tradeSearchUrl(league, search.id, 'poe2');
      const ids = [...new Set(search.result ?? [])].slice(0, limit);
      const fetched: ItemListing[] = [];
      for (let offset = 0; offset < ids.length; offset += 10) fetched.push(...await this.tradeClient!.fetchItems(ids.slice(offset, offset + 10), search.id));
      row.candidates = fetched.filter(listing => !listing.item.league || listing.item.league === league).map(listing => this.candidate(listing, search.id, league, checkedAt, currency, rates))
        .filter(c => maxPrice === undefined || c.priceInBudgetCurrency !== undefined && c.priceInBudgetCurrency <= maxPrice);
    }
    const nativeMinimums = [['minSpirit', 'spirit'], ['minWard', 'ward'], ['minRuneSockets', 'runeSockets']] as const;
    const fetchedCount = row.candidates.length;
    row.candidates = row.candidates.filter(candidate => nativeMinimums.every(([requirement, stat]) => {
      const minimum = row.requirements[requirement], value = candidate.itemEvidence[stat];
      return minimum === undefined || value !== undefined && value >= minimum;
    }));
    if (row.candidates.length < fetchedCount) row.warnings.push('Some listings lacked evidence meeting the requested Spirit, Ward or rune socket minimum; they were excluded from candidates.');
    row.candidates.sort((a, b) => (a.priceInBudgetCurrency ?? Infinity) - (b.priceInBudgetCurrency ?? Infinity));
    const quoted = row.candidates.find(c => c.price);
    if (quoted?.price) row.price = { status: 'listed', ...quoted.price };
    row.warnings.push('Candidates are a bounded listing sample; reference currency rates are not executable exchange quotes.');
  }

  private candidate(listing: ItemListing, queryId: string, league: string, checkedAt: string, currency: string, rates: Map<string, number>, warnings: string[] = []): ShoppingCandidate {
    const analysis = this.analyzer.analyzeItem(listing, rates), price = getListingPrice(listing, rates);
    return { listingId: listing.id, name: listing.item.name || listing.item.typeLine, baseType: listing.item.baseType,
      ...(price.amount !== undefined && price.currency ? { price: { amount: price.amount, currency: price.currency } } : {}),
      priceInBudgetCurrency: priceInCurrency(price, currency, rates), url: tradeSearchUrl(league, queryId, 'poe2'),
      source: { league, queryId, checkedAt, indexed: listing.listing.indexed, kind: 'listing' }, itemEvidence: analysis.stats,
      mods: itemModifierLines(listing.item),
      warnings: [...warnings, ...analysis.metrics.warnings] };
  }
}
