/** Read-only budget adaptations of an existing PoE2 build. Never creates or saves a build. */
import { createHash } from 'crypto';
import type { PoBBuild } from '../types.js';
import { asArray, finiteNumber, xmlBoolean, type SkillGem, type SkillGroup } from '../skillLinkOptimizer.js';
import { normalizeCurrencyId } from './costBenefitAnalyzer.js';
import { validationStat } from './passiveBudget.js';
import { readPoe2BuildEvidence, type EvidenceContext, type PoE2BuildEvidence } from './poe2BuildEvidence.js';
import { SkillGemService, type GemReadOptions } from './skillGemService.js';
import { ShoppingListService, type ShoppingDependencies, type ShoppingList, type ShoppingListItem,
  type ShoppingCandidate, type ShoppingOptions, type ShoppingRequirements } from './shoppingListService.js';
import type { TradeApiClient } from './tradeClient.js';
import type { StatMapper } from './statMapper.js';
import type { PoeNinjaClient } from './poeNinjaClient.js';

export interface BudgetBuildOptions {
  budgetTier?: string;
  /** Additional purchases for this loadout; existing equipment is retained, not appraised. */
  budget?: number;
  currency?: string;
  league?: string;
  slots?: string[];
  itemRequirements?: Record<string, ShoppingRequirements>;
  runeTargets?: Record<string, string[]>;
  includeGems?: boolean;
  priority?: ShoppingOptions['priority'];
  maxPricePerItem?: number;
  limitPerSlot?: number;
  maxSearches?: number;
}

/** Trusted calculator integration evidence, not public tool arguments or item-stat estimates.
 * Each result describes ONE replacement against the exact snapshot. Results are never added.
 */
export interface BudgetNativeOutcome {
  snapshotId: string;
  entryId: string;
  listingId: string;
  /** From the proposed entry. Bind results to its item evidence and target requirements. */
  candidateFingerprint: string;
  engine: 'PoB2';
  checkedAt: string;
  valid: boolean;
  before: Record<string, number>;
  after: Record<string, number>;
  conditions: Record<string, unknown>;
  rollback: { xmlUnchanged: boolean; statsUnchanged: boolean; selectionsUnchanged: boolean; undoUnchanged: boolean };
}
export interface BudgetBuildDependencies {
  tradeClient?: TradeApiClient;
  statMapper?: StatMapper;
  ninjaClient?: PoeNinjaClient;
  skillGemService?: Pick<SkillGemService, 'prepareBuild'>;
  shoppingDependencies?: ShoppingDependencies;
  /** Already calculated by the native adapter; budget planning itself does not mutate PoB. */
  budgetNativeOutcomes?: readonly BudgetNativeOutcome[];
}
export interface BudgetBuildContext extends EvidenceContext, BudgetBuildDependencies {}
type BudgetGem = Omit<SkillGem, 'data'> & { naturalMaxLevel?: number; metadataSource?: string };
export interface BudgetEquipment {
  slot: string;
  itemId?: string;
  name?: string;
  raw?: string;
  state: 'present' | 'empty' | 'unresolved';
  activeWeaponSet: boolean;
  enabled?: boolean;
}
export interface BudgetEntry {
  id: string;
  slot: string;
  kind: ShoppingListItem['kind'];
  priority: ShoppingListItem['priority'];
  decision: 'propose' | 'defer';
  reason: string;
  candidate?: ShoppingCandidate;
  candidateFingerprint?: string;
  native?: { checkedAt: string; conditions: Record<string, unknown>;
    deltas: Record<string, { before: number; after: number; absolute: number; percent?: number }> };
}
export interface BudgetBuildPlan {
  mode: 'read-only-proposal';
  buildName: string;
  snapshot: { id: string; source: PoE2BuildEvidence['source']; note: string;
    character: { className?: string; ascendancy?: string; level?: number }; stats: Record<string, number> };
  budget: { tier: string; scope: 'additional-purchases'; limit?: number; currency?: string;
    quotedSpend?: number; remaining?: number; proposed: number; deferred: number };
  loadout: { selection: ShoppingList['selection']; equipment: BudgetEquipment[];
    groups: Array<Omit<SkillGroup, 'gems'> & { gems: BudgetGem[] }>; mainGroupIndex?: number;
    runes: ShoppingList['runes']; charms: ShoppingList['charms'] };
  shopping: ShoppingList;
  entries: BudgetEntry[];
  warnings: string[];
}

const tiers = ['league-start', 'low', 'budget', 'medium', 'endgame', 'high'];
const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
const outputFields = ['Life', 'EnergyShield', 'Armour', 'Evasion', 'TotalDPS', 'CombinedDPS', 'FullDPS',
  'TotalEHP', 'AverageDamage', 'Speed', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'FireResistMax', 'ColdResistMax', 'LightningResistMax', 'ChaosResistMax', 'MissingFireResist',
  'MissingColdResist', 'MissingLightningResist', 'MissingChaosResist', 'Str', 'Dex', 'Int',
  'ReqStr', 'ReqDex', 'ReqInt', 'LifeUnreserved', 'ManaUnreserved', 'SpiritUnreserved', 'CharmLimit'];
const knownOutputs = (stats: Record<string, unknown>) => Object.fromEntries(outputFields.flatMap(key => {
  const value = validationStat(stats, key); return value === null ? [] : [[key, value]];
}));
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const timestamp = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Account using the decimal representations of the observed numeric quotes. Binary subtraction
// otherwise rejects 0.1 + 0.2 against a 0.3 allowance. No assumed currency precision is imposed.
function decimal(value: number): { units: bigint; exponent: number } {
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  return { units: BigInt(integer + fraction), exponent: Number(exponent) - fraction.length };
}

function validateOptions(options: BudgetBuildOptions): void {
  if (!tiers.includes(options.budgetTier ?? 'league-start')) throw new Error(`Unknown budget tier: ${options.budgetTier}`);
  for (const key of ['budget', 'maxPricePerItem'] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${key} must be a finite non-negative number`);
    }
  }
  if (options.currency !== undefined && (typeof options.currency !== 'string' || !options.currency.trim())) throw new Error('Currency must be non-empty');
  if (options.budget !== undefined && !options.currency) throw new Error('A numeric budget requires an explicit currency');
  if (options.league !== undefined && typeof options.league !== 'string') throw new Error('League must be a string');
}

/** Include both weapon specialisations in the retained loadout, even when only one is searched. */
function equipment(build: PoBBuild, selection: ShoppingList['selection']): BudgetEquipment[] {
  const items: any = build.Items ?? {};
  const container = asArray<any>(items.ItemSet).find(s => String(s.id) === selection.itemSetId) ?? items;
  const itemText = new Map(asArray<any>(items.Item).map(i => [String(i.id), i['#text']]));
  return asArray<any>(container.Slot).filter(s => typeof s.name === 'string').map(slot => {
    const itemId = slot.itemId === undefined ? undefined : String(slot.itemId);
    const raw = itemId ? itemId === '0' ? undefined : itemText.get(itemId) : slot.Item;
    const text = typeof raw === 'string' && raw.trim() ? raw : undefined;
    const lines = text?.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const rarityLine = lines?.findIndex(s => s.startsWith('Rarity:'));
    const name = lines && rarityLine !== undefined && rarityLine >= 0 ? lines[rarityLine + 1] : undefined;
    const nameOfSlot = slot.name.trim().replace(/^(Weapon|Ring)(\d)/, '$1 $2');
    return { slot: nameOfSlot, itemId, name, raw: text,
      state: text ? 'present' : itemId && itemId !== '0' ? 'unresolved' : 'empty',
      activeWeaponSet: !/^Weapon [12]( Swap)?$/.test(nameOfSlot) || nameOfSlot.endsWith(' Swap') === (selection.weaponSet === 2),
      enabled: slot.active === undefined ? undefined : xmlBoolean(slot.active, false) };
  });
}

function comparablePrice(candidate: ShoppingCandidate, league: string, currency?: string): number | undefined {
  if (!currency || !league || candidate.source.kind !== 'listing' || candidate.source.league !== league ||
    !candidate.listingId?.trim() || !candidate.source.queryId?.trim() || !timestamp(candidate.source.checkedAt) ||
    !candidate.price || !positive(candidate.price.amount) || !candidate.price.currency?.trim()) return undefined;
  if (normalizeCurrencyId(candidate.price.currency) === currency) return candidate.price.amount;
  // Conversion is supplied by ShoppingListService only after obtaining known currency rates.
  return positive(candidate.priceInBudgetCurrency) ? candidate.priceInBudgetCurrency : undefined;
}

function candidateFingerprint(row: ShoppingListItem, candidate: ShoppingCandidate): string {
  return createHash('sha256').update(JSON.stringify({ listingId: candidate.listingId, league: candidate.source.league,
    indexed: candidate.source.indexed, name: candidate.name, baseType: candidate.baseType,
    mods: candidate.mods, itemEvidence: candidate.itemEvidence, requirements: row.requirements, gem: row.gem })).digest('hex');
}

export class BudgetBuildService {
  constructor(private readonly dependencies: BudgetBuildDependencies = {}) {}

  async createPlan(evidence: PoE2BuildEvidence, buildName: string, options: BudgetBuildOptions = {}, gemOptions: GemReadOptions = {}): Promise<BudgetBuildPlan> {
    validateOptions(options);
    if (evidence.build.__xmlRoot !== 'PathOfBuilding2') throw new Error('Budget planning requires PathOfBuilding2 XML');
    if ((this.dependencies.tradeClient && this.dependencies.tradeClient.game !== 'poe2') ||
      (this.dependencies.ninjaClient && this.dependencies.ninjaClient.game !== 'poe2')) {
      throw new Error('Budget planning requires verified PoE2 market clients');
    }
    // Keep the cached BuildService DTO and the caller's evidence untouched.
    const build = structuredClone(evidence.build);
    const stats = knownOutputs(evidence.stats);
    const snapshotId = createHash('sha256').update(JSON.stringify({ build, stats, source: evidence.source })).digest('hex');
    const tier = options.budgetTier ?? 'league-start';
    const currency = options.currency === undefined ? undefined : normalizeCurrencyId(options.currency);
    const league = options.league?.trim() ?? '';
    const service = this.dependencies.skillGemService ?? this.dependencies.shoppingDependencies?.skillGemService ?? new SkillGemService();
    const model = await service.prepareBuild(build, gemOptions);
    const shopping = await new ShoppingListService(this.dependencies.tradeClient, this.dependencies.statMapper, this.dependencies.ninjaClient, {
      ...this.dependencies.shoppingDependencies, skillGemService: { prepareBuild: async () => model },
    }).generateShoppingList(build, buildName, league, ['endgame', 'high'].includes(tier) ? 'endgame' : tier === 'medium' ? 'medium' : 'budget', {
      ...options, currency, stats: evidence.stats, source: evidence.source, sourceNote: evidence.note, gemOptions,
    });
    const groups = model.groups.map(group => ({ ...group, gems: group.gems.map(({ data, ...gem }) => ({
      ...gem, naturalMaxLevel: data?.naturalMaxLevel, metadataSource: data?.source,
    })) }));
    const warnings = [...model.notes, ...shopping.warnings,
      'Existing items, gems, passives and configuration are retained. Their replacement or resale value is unknown; this is an additional-purchase budget, not a total build valuation.',
      'Allocation follows shopping priority then the lowest comparable asking price per entry. The bounded sample does not establish a global optimum.',
      'Proposed replacements require a combined native calculation before use. Individual replacement outcomes cannot be summed into a completed-build result.'];
    if (options.budget === undefined) warnings.push('Provide a numeric budget and currency to allocate purchases. Budget tiers do not imply a spending limit.');
    if (!this.dependencies.tradeClient) warnings.push('Market client is not connected; exact requirements and retained loadout are available, but no live listings were fetched.');
    if (this.dependencies.budgetNativeOutcomes?.some(outcome => outcome.snapshotId !== snapshotId)) {
      warnings.push('Native results from different build snapshots were excluded.');
    }
    const used = new Set<string>();
    const entries: BudgetEntry[] = [];
    const prices = new Map(shopping.items.map(row => [row.id, row.candidates
      .map(candidate => ({ candidate, price: comparablePrice(candidate, league, currency) }))
      .filter((q): q is { candidate: ShoppingCandidate; price: number } => q.price !== undefined)
      .sort((a, b) => a.price - b.price || a.candidate.listingId.localeCompare(b.candidate.listingId))]));
    const moneyExponent = Math.min(0, decimal(options.budget ?? 0).exponent,
      ...[...prices.values()].flatMap(rows => rows.map(row => decimal(row.price).exponent)));
    const units = (value: number) => {
      const parts = decimal(value); return parts.units * 10n ** BigInt(parts.exponent - moneyExponent);
    };
    const value = (amount: bigint) => Number(`${amount}e${moneyExponent}`);
    const allowance = units(options.budget ?? 0);
    let spent = 0n;
    for (const row of [...shopping.items].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])) {
      const entry: BudgetEntry = { id: row.id, slot: row.slot, kind: row.kind, priority: row.priority,
        decision: 'defer', reason: 'No comparable priced listing is available; retain the current loadout.' };
      const quoted = prices.get(row.id)!;
      if (options.budget === undefined) entry.reason = 'No numeric spending limit supplied; retain the current loadout and review the listing alternatives.';
      else if (row.gem && row.gem.requirementsMet !== true) entry.reason = row.gem.requirementsMet === false
        ? 'Target gem requirements are not met; retain the current gem.' : 'Target gem requirements are incomplete; retain the current gem until verified.';
      else {
        for (const quote of quoted) {
          if (used.has(quote.candidate.listingId)) continue;
          if (units(quote.price) > allowance - spent || (options.maxPricePerItem !== undefined && quote.price > options.maxPricePerItem)) continue;
          const outcomes = this.dependencies.budgetNativeOutcomes?.filter(outcome => outcome.snapshotId === snapshotId &&
            outcome.entryId === row.id && outcome.listingId === quote.candidate.listingId) ?? [];
          const fingerprint = candidateFingerprint(row, quote.candidate);
          let native: BudgetEntry['native'];
          if (outcomes.length) {
            const outcome = outcomes.length === 1 ? outcomes[0] : undefined;
            const verified = outcome && outcome.engine === 'PoB2' && timestamp(outcome.checkedAt) &&
              outcome.rollback?.xmlUnchanged === true && outcome.rollback.statsUnchanged === true &&
              outcome.rollback.selectionsUnchanged === true && outcome.rollback.undoUnchanged === true;
            if (!verified) { row.warnings.push(`Native evidence for ${quote.candidate.listingId} is ambiguous or rollback is unverified.`); continue; }
            if (outcome.candidateFingerprint !== fingerprint) { row.warnings.push(`Native item/target evidence for ${quote.candidate.listingId} is stale.`); continue; }
            if (outcome.valid !== true) { row.warnings.push(`Native calculation rejected candidate ${quote.candidate.listingId}.`); continue; }
            const keys = Object.keys(outcome.before ?? {});
            if (!keys.length || keys.some(key => stats[key] === undefined || outcome.before[key] !== stats[key] ||
              !Number.isFinite(outcome.after?.[key]) || !Number.isFinite(outcome.after[key] - outcome.before[key]))) {
              row.warnings.push(`Native baseline for ${quote.candidate.listingId} does not match the observed outputs.`); continue;
            }
            native = { checkedAt: outcome.checkedAt, conditions: outcome.conditions, deltas: Object.fromEntries(keys.map(key => {
              const before = outcome.before[key], after = outcome.after[key], absolute = after - before;
              const percent = before === 0 ? undefined : absolute / before * 100;
              return [key, { before, after, absolute, ...(percent !== undefined && Number.isFinite(percent) ? { percent } : {}) }];
            })) };
          }
          used.add(quote.candidate.listingId); spent += units(quote.price);
          entry.decision = 'propose'; entry.candidate = { ...quote.candidate, priceInBudgetCurrency: quote.price }; entry.native = native;
          entry.candidateFingerprint = fingerprint;
          entry.reason = native ? 'Observed listing fits the remaining allowance; individual native outcome is attached.'
            : 'Observed listing fits the remaining allowance; replacement effects remain unverified.';
          break;
        }
        if (!entry.candidate && quoted.length) entry.reason = 'No distinct eligible listing fits the remaining allowance; retain the current loadout and review warnings.';
      }
      entries.push(entry);
    }
    const main = groups.find(group => group.isMainSkill);
    if (!main) warnings.push('The saved/native evidence does not identify a main skill group; no first-group fallback was selected.');
    const proposed = entries.filter(row => row.decision === 'propose').length;
    return { mode: 'read-only-proposal', buildName,
      snapshot: { id: snapshotId, source: evidence.source, note: evidence.note,
        character: { className: build.Build?.className, ascendancy: build.Build?.ascendClassName, level: finiteNumber(build.Build?.level) }, stats },
      budget: { tier, scope: 'additional-purchases', limit: options.budget, currency,
        ...(options.budget !== undefined ? { quotedSpend: value(spent), remaining: value(allowance - spent) } : {}), proposed, deferred: entries.length - proposed },
      loadout: { selection: shopping.selection, equipment: equipment(build, shopping.selection), groups,
        mainGroupIndex: main?.index, runes: shopping.runes, charms: shopping.charms }, shopping, entries, warnings };
  }
}

/** Connect via the shared evidence helper, preserving its no-load/no-reload selection rules. */
export async function createBudgetBuildPlan(context: BudgetBuildContext, buildName?: string, options: BudgetBuildOptions = {}): Promise<BudgetBuildPlan> {
  validateOptions(options);
  if (buildName !== undefined && (typeof buildName !== 'string' || !buildName.trim())) throw new Error('build_name must be non-empty when supplied');
  const evidence = await readPoe2BuildEvidence(context, buildName);
  const client = context.getLuaClient?.();
  const displayName = buildName ?? (evidence.source === 'live' && client ? (await client.getBuildInfo()).name : undefined) ?? 'Current PoB2 build';
  const gemOptions: GemReadOptions = evidence.source === 'live' && client
    ? { client, source: 'live', liveSkills: await client.getSkills() } : { source: 'file' };
  const plan = await new BudgetBuildService(context).createPlan(evidence, displayName, options, gemOptions);
  if (evidence.source === 'live' && client) {
    const after = context.buildService.parseBuildContent(await client.exportBuildXml());
    if (JSON.stringify(after) !== JSON.stringify(evidence.build)) throw new Error('Native build changed during budget planning; retry the read');
  }
  return plan;
}

export function formatBudgetBuildPlan(plan: BudgetBuildPlan): string {
  const { budget, loadout, snapshot } = plan;
  const lines = [`=== PoE2 Budget Build Plan: ${plan.buildName} ===`, snapshot.note,
    `Class: ${snapshot.character.className ?? 'unknown'}; ascendancy: ${snapshot.character.ascendancy ?? 'unknown'}; level: ${snapshot.character.level ?? 'unknown'}`,
    `Item set: ${loadout.selection.itemSetId ?? 'unknown'}; weapon set: ${loadout.selection.weaponSet}; skill set: ${loadout.selection.skillSetId}`,
    `Tier: ${budget.tier} (descriptive); league: ${plan.shopping.league || 'not specified'}`,
    budget.limit === undefined ? 'Spending limit: not specified. Supply a numeric budget and currency to allocate purchases.'
      : `Additional-purchase allowance: ${budget.limit} ${budget.currency}; quoted proposed spend: ${budget.quotedSpend} ${budget.currency}; remaining: ${budget.remaining} ${budget.currency}`,
    `Proposed entries: ${budget.proposed}; deferred entries: ${budget.deferred}. Full build cost: unknown.`,
    '', '## Retained equipment'];
  for (const item of loadout.equipment) lines.push(`- ${item.slot}: ${item.name ?? item.state} (item ID ${item.itemId ?? 'inline'})${item.activeWeaponSet ? '' : ' [inactive weapon set]'}${item.enabled === false ? ' [inactive]' : ''}`);
  lines.push('', '## Retained skill groups');
  for (const group of loadout.groups) {
    lines.push(`Group ${group.index}${group.isMainSkill ? ' [main]' : ''}${group.enabled ? '' : ' [disabled]'}${group.source ? `; source ${group.source}` : ''}: ${group.label ?? ''}`,
      `  Active selection: ${group.mainActiveSkill ?? 'unknown'}; calculation selection: ${group.mainActiveSkillCalcs ?? 'unknown'}`);
    for (const gem of group.gems) lines.push(`  - ${gem.name} (${gem.gemId ?? gem.skillId ?? 'unresolved ID'}): level ${gem.level ?? 'unknown'}, quality ${gem.quality ?? 'unknown'}; ${gem.isSupport === true ? 'support' : gem.isSupport === false ? 'active' : 'role unresolved'}${gem.enabled === false ? ' [disabled]' : ''}${gem.error ? `; ${gem.error}` : ''}`);
  }
  lines.push('', `## ${snapshot.source === 'live' ? 'Native baseline outputs' : 'Saved baseline outputs (may be stale)'}`);
  lines.push(Object.keys(snapshot.stats).length ? JSON.stringify(snapshot.stats) : 'No calculated outputs available.');
  lines.push('', '## Purchase allocation');
  for (const entry of plan.entries) {
    const row = plan.shopping.items.find(item => item.id === entry.id)!;
    lines.push(`- ${entry.slot} [${entry.priority}, ${entry.decision}]: ${entry.reason}`, ...row.reason.map(reason => `  ${reason}`));
    if (entry.candidate) lines.push(`  Selected listing ${entry.candidate.listingId}: ${entry.candidate.name}; asking ${entry.candidate.price!.amount} ${entry.candidate.price!.currency}; budget charge ${entry.candidate.priceInBudgetCurrency} ${budget.currency}${normalizeCurrencyId(entry.candidate.price!.currency) === budget.currency ? '' : ' (reference currency conversion)'}`);
    for (const candidate of row.candidates) lines.push(`  Listing ${candidate.listingId}: ${candidate.name}, ${candidate.price ? `${candidate.price.amount} ${candidate.price.currency}` : 'unpriced'}; ${candidate.url}`,
      `  Listing evidence: ${candidate.source.league}; query ${candidate.source.queryId}; checked ${candidate.source.checkedAt}${candidate.source.indexed ? `; indexed ${candidate.source.indexed}` : ''}`, ...candidate.warnings.map(warning => `  ${warning}`));
    if (entry.native) lines.push(`  Native individual replacement, checked ${entry.native.checkedAt}: ${JSON.stringify(entry.native.deltas)}`,
      `  Calculation conditions: ${JSON.stringify(entry.native.conditions)}`);
    if (row.gem) lines.push(`  Gem target and requirements: ${JSON.stringify(row.gem)}`);
    if (row.search.query) lines.push(`  Search constraints: ${JSON.stringify(row.search.query)}`);
    lines.push(...row.warnings.map(warning => `  ${warning}`));
  }
  if (loadout.runes.length) lines.push('', '## Rune evidence', ...loadout.runes.flatMap(rune => [
    `${rune.slot}: ${rune.occupied.join(', ') || 'none observed'}; capacity ${rune.capacity ?? 'unknown'}; empty ${rune.empty ?? 'unknown'}`, ...rune.warnings]));
  lines.push(`Charm capacity: ${loadout.charms.capacity ?? 'unknown'} (${loadout.charms.capacitySource}); equipped: ${loadout.charms.equipped}`, ...loadout.charms.warnings,
    '', ...plan.warnings, 'No build file or native runtime state was changed.');
  return lines.join('\n');
}
