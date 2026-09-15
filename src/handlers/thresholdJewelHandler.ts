/** Attribute-threshold reporting with exact native context and explicit game limits. */
import { evaluateBuildThresholds } from '../services/thresholdJewelService.js';
import { readJewelBuildContext, jewelHandlerError, jewelNodeLabel, type RadiusEffectJewelHandlerContext } from './radiusEffectJewelHandler.js';

export type ThresholdJewelHandlerContext = RadiusEffectJewelHandlerContext;

export async function handleEvaluateThresholdJewels(context: ThresholdJewelHandlerContext) {
  try {
    const state = await readJewelBuildContext(context);
    const result = evaluateBuildThresholds(state.jewels, state.allocatedNodes, state.treeContext);
    const lines = ['=== Threshold Jewel Evaluation ===', state.header,
      `Scanned ${result.jewelsScanned} jewel(s); ${result.jewelsWithThresholds} carry attribute-threshold syntax.`];
    if (state.poe2) {
      lines.push('PoE2 attribute-threshold evaluation is unavailable: legacy parser patterns do not establish a supported PoE2 item or its effective attribute total.');
      if (!result.jewelsWithThresholds) lines.push('No such threshold syntax was found in the supplied jewels.');
    } else {
      for (const evaluation of result.evaluations) {
        lines.push('', `• ${evaluation.jewelName} @ ${jewelNodeLabel(evaluation.socketNodeId, state)} [radius ${evaluation.radius}]`);
        for (const e of [...evaluation.triggered, ...evaluation.notTriggered]) lines.push(
          `  ${e.triggered ? 'Met' : 'Not met'}: ${e.threshold.attribute} ${e.attributeInRadius}/${e.threshold.requiredAmount}; margin ${e.margin}`,
          `  ${e.threshold.rawMod}`, `  Basis: ${e.basis ?? 'unavailable'}`);
      }
      if (!result.jewelsWithThresholds) lines.push('No attribute-threshold syntax found.');
      lines.push('Legacy With-at-least thresholds include eligible unallocated nodes. Totals use printed base attributes; other jewel transformations and overrides require native evaluation.');
    }
    await state.verifyUnchanged();
    return { isError: false, content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (error) { return jewelHandlerError(error); }
}
