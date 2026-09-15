/** Trusted native callback for budget planning. No result objects are accepted from tool inputs. */
import type { ItemListing } from '../types/tradeTypes.js';
import type { NativeItemEvaluation, NativeItemEvaluationRequest, NativeItemReplacement } from '../types/nativeItemTypes.js';
import type { ShoppingCandidate } from './shoppingListService.js';
import type { BudgetNativeOutcome } from './budgetBuildService.js';
import { convertTradeItemForPob } from './tradeItemConversion.js';
import { itemModifierLines } from './costBenefitAnalyzer.js';

export interface BudgetItemCandidate {
  entryId: string; slot: string; candidateFingerprint: string; listing: ItemListing; quote: ShoppingCandidate;
}
export interface BudgetItemEvaluationRequest {
  snapshotId: string; expectedBuildName: string; expectedXml: string;
  itemSetId: string | number; skillSetId: string | number;
  candidates: BudgetItemCandidate[];
  combined?: boolean;
}
export interface BudgetItemEvaluationResult {
  outcomes: BudgetNativeOutcome[];
  failures: Array<{ entryId: string; listingId: string; reason: string }>;
  combined?: { entryIds: string[]; before: Record<string, number>; after: Record<string, number>;
    conditions: Record<string, unknown>; valid: boolean; warnings: string[]; checkedAt: string;
    preservation: NativeItemEvaluation['preservation'] };
}
export type BudgetItemEvaluator = (request: BudgetItemEvaluationRequest) => Promise<BudgetItemEvaluationResult>;
export interface NativeItemClient {
  evaluateItemReplacements(request: NativeItemEvaluationRequest): Promise<NativeItemEvaluation>;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const finiteOutputs = (value: Record<string, number> | undefined) => value && Object.keys(value).length > 0 &&
  Object.values(value).every(n => typeof n === 'number' && Number.isFinite(n));
const preserved = (value: NativeItemEvaluation['preservation'] | undefined) => value && value.xmlUnchanged === true &&
  value.statsUnchanged === true && value.selectionsUnchanged === true && value.undoUnchanged === true &&
  value.catalogUnchanged === true && value.treeUnchanged === true && value.cacheUnchanged === true;

function sameListing(candidate: BudgetItemCandidate): boolean {
  const { listing, quote } = candidate;
  return listing.id === quote.listingId && (!listing.item.league || listing.item.league === quote.source.league) &&
    (listing.item.name || listing.item.typeLine) === quote.name && listing.item.baseType === quote.baseType &&
    listing.listing.indexed === quote.source.indexed && listing.listing.price?.amount === quote.price?.amount &&
    listing.listing.price?.currency === quote.price?.currency && JSON.stringify(itemModifierLines(listing.item)) === JSON.stringify(quote.mods);
}

export function createBudgetItemEvaluator(client: NativeItemClient): BudgetItemEvaluator {
  return async request => {
    const result: BudgetItemEvaluationResult = { outcomes: [], failures: [] };
    if (!request.candidates.length) return result;
    if (request.candidates.length > 12) throw new Error('Native item evaluation is bounded to 12 candidates');
    const replacements: NativeItemReplacement[] = [];
    const sources: BudgetItemCandidate[] = [];
    const fail = (candidate: BudgetItemCandidate, reason: string) => result.failures.push({ entryId: candidate.entryId, listingId: candidate.quote.listingId, reason });
    for (const candidate of request.candidates) {
      if (!sameListing(candidate)) { fail(candidate, 'Full trade item no longer matches the budget quote'); continue; }
      const converted = convertTradeItemForPob(candidate.listing.item);
      if (!converted.complete || !converted.text) { fail(candidate, `Incomplete native item conversion: ${converted.errors.join('; ')}`); continue; }
      replacements.push({ slotName: candidate.slot, text: converted.text, expected: converted.expected,
        candidateId: converted.identity, entryId: candidate.entryId, listingId: candidate.quote.listingId });
      sources.push(candidate);
    }
    // A combined scenario must include every requested replacement, never a silent subset.
    if (!replacements.length || request.combined && result.failures.length) return result;
    const scenarios = request.combined ? [{ id: 'budget-combined', replacements }]
      : replacements.map((replacement, index) => ({ id: `budget-${index}`, replacements: [replacement] }));
    let native: NativeItemEvaluation;
    try {
      native = await client.evaluateItemReplacements({ expectedXml: request.expectedXml, expectedBuildName: request.expectedBuildName,
        snapshotId: request.snapshotId, itemSetId: request.itemSetId, skillSetId: request.skillSetId, scenarios });
      if (native.snapshotId !== request.snapshotId || !preserved(native.preservation) || !finiteOutputs(native.baseline) ||
        !Array.isArray(native.comparisons) || native.comparisons.length !== scenarios.length) {
        throw new Error('Native item result has a different snapshot, malformed outputs, or unverified preservation');
      }
    } catch (error) { for (const source of sources) fail(source, errorText(error)); return result; }
    const checkedAt = new Date().toISOString();
    for (const [index, scenario] of scenarios.entries()) {
      const rows = native.comparisons.filter(row => row.id === scenario.id);
      const row = rows.length === 1 ? rows[0] : undefined;
      const expectedInputs = scenario.replacements;
      const inputsMatch = row && Array.isArray(row.inputs) && row.inputs.length === expectedInputs.length && expectedInputs.every((expected, i) => {
        const input = row.inputs[i];
        return input?.candidateId === expected.candidateId && input.slotName === expected.slotName && input.text === expected.text &&
          input.entryId === expected.entryId && input.listingId === expected.listingId;
      });
      if (!inputsMatch || !finiteOutputs(row?.output)) {
        const reason = row?.error ?? 'Native result is missing calculated outputs or has different candidate item text/identity';
        for (const source of request.combined ? sources : [sources[index]]) fail(source, reason);
        continue;
      }
      if (request.combined) {
        result.combined = { entryIds: sources.map(source => source.entryId), before: native.baseline, after: row!.output!,
          valid: row!.valid === true, warnings: row!.warnings ?? [],
          conditions: { ...native.conditions, nativeSkills: row!.skills, baselineSkills: native.baselineSkills },
          checkedAt, preservation: native.preservation };
      } else {
        const source = sources[index];
        result.outcomes.push({ snapshotId: request.snapshotId, entryId: source.entryId, listingId: source.quote.listingId,
          candidateFingerprint: source.candidateFingerprint, engine: 'PoB2', checkedAt, valid: row!.valid === true,
          before: native.baseline, after: row!.output!, rollback: native.preservation,
          conditions: { ...native.conditions, warnings: row!.warnings ?? [], tradeItemIdentity: replacements[index].candidateId,
            implicitRemovals: row!.implicitRemovals ?? [], nativeSkills: row!.skills, baselineSkills: native.baselineSkills,
            listingCheckedAt: source.quote.source.checkedAt, listingIndexed: source.quote.source.indexed } });
      }
    }
    return result;
  };
}
