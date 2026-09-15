import { createHash } from 'crypto';
import type { ItemListing } from '../types/tradeTypes.js';
import type { NativeItemEvaluation, NativeItemEvaluationRequest } from '../types/nativeItemTypes.js';
import type { EvidenceContext } from './poe2BuildEvidence.js';
import { readPoe2BuildEvidence } from './poe2BuildEvidence.js';
import { nativeBuildMatches } from './nativeBuildIdentity.js';
import { convertTradeItemForPob } from './tradeItemConversion.js';

function selectedSet(container: any, active: string, setName: string): string | number {
  if (container?.[active]!==undefined) return container[active];
  const sets=Array.isArray(container?.[setName])?container[setName]:container?.[setName]?[container[setName]]:[];
  if (sets.length===1 && sets[0].id!==undefined) return sets[0].id;
  throw new Error(`The selected ${setName} is unknown`);
}
const finiteOutputs=(value: unknown): value is Record<string,number>=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length>0 && Object.values(value).every(n=>typeof n==='number' && Number.isFinite(n));

/** Evaluates observed listings; public callers cannot supply a purported native result. */
export async function compareNativeTradeItems(context: EvidenceContext, items: ItemListing[], slot: string, buildName?: string) {
  if (typeof slot!=='string' || !slot.trim()) throw new Error('Native comparison requires the exact equipment slot');
  const evidence=await readPoe2BuildEvidence(context,buildName);
  const client=context.getLuaClient?.();
  if (evidence.source!=='live' || !client) throw new Error('Native comparison requires the matching loaded PoB2 build');
  const expectedXml=await client.exportBuildXml();
  if (JSON.stringify(context.buildService.parseBuildContent(expectedXml))!==JSON.stringify(evidence.build)) throw new Error('Build changed before item comparison; retry');
  const info=await client.getBuildInfo();
  if (typeof info.name!=='string' || !info.name) throw new Error('Native build identity unavailable');
  if (!nativeBuildMatches(buildName,info,context.buildService)) throw new Error('Requested native build changed before item comparison');
  const snapshotId=createHash('sha256').update(expectedXml).digest('hex');
  const failures: Array<{listingId:string;reason:string}>=[];
  const scenarios: NativeItemEvaluationRequest['scenarios']=[];
  for (const listing of items) {
    const converted=convertTradeItemForPob(listing.item);
    if (!converted.complete || !converted.text) {failures.push({listingId:listing.id,reason:converted.errors.join('; ')});continue;}
    scenarios.push({id:`listing:${listing.id}`,replacements:[{slotName:slot,text:converted.text,expected:converted.expected,candidateId:converted.identity,entryId:`listing:${listing.id}`,listingId:listing.id}]});
  }
  if (!scenarios.length) return {status:'unavailable',failures,note:'No listing had sufficient native item-conversion evidence.'};
  const request: NativeItemEvaluationRequest={expectedBuildName:info.name,expectedXml,snapshotId,
    itemSetId:selectedSet(evidence.build.Items,'activeItemSet','ItemSet'),skillSetId:selectedSet(evidence.build.Skills,'activeSkillSet','SkillSet'),scenarios};
  const result: NativeItemEvaluation=await client.evaluateItemReplacements(request);
  const p=result.preservation;
  if (result.snapshotId!==snapshotId || !p || p.xmlUnchanged!==true || p.statsUnchanged!==true || p.selectionsUnchanged!==true || p.undoUnchanged!==true || !finiteOutputs(result.baseline)) throw new Error('Native comparison returned a different snapshot or unverified preservation');
  if (!Array.isArray(result.comparisons) || result.comparisons.length!==scenarios.length) throw new Error('Native item comparison is incomplete');
  for (const scenario of scenarios) {
    const matches=result.comparisons.filter(r=>r.id===scenario.id),row=matches[0],expected=scenario.replacements[0];
    if (matches.length!==1) throw new Error('Native comparison scenario identity mismatch');
    if (row.error && row.valid===false) {failures.push({listingId:expected.listingId,reason:row.error});continue;}
    const actual=row.inputs?.[0];
    if (row.inputs?.length!==1 || actual?.text!==expected.text || actual.slotName!==slot || actual.candidateId!==expected.candidateId || actual.listingId!==expected.listingId || !finiteOutputs(row.output)) throw new Error('Native comparison output does not match the requested item');
  }
  const after=await client.exportBuildXml();
  if (after!==expectedXml) throw new Error('Native item comparison changed the exported build');
  return {status:failures.length || result.comparisons.some(r=>!r.valid)?'partial':'calculated',...result,failures,
    note:'Each listing replaces the specified slot independently under the recorded conditions. Results do not measure a combined purchase or actual combat uptime.'};
}
