/** Timeless identification, geometric candidates, and bounded native-state evidence. */
import { findAffectedNodes } from '../services/timelessJewelService.js';
import { readJewelBuildContext, jewelHandlerError, jewelNodeLabel, type RadiusEffectJewelHandlerContext } from './radiusEffectJewelHandler.js';

export type TimelessJewelHandlerContext = RadiusEffectJewelHandlerContext;

export async function handleFindJewelAffectedNodes(context: TimelessJewelHandlerContext) {
  try {
    const state = await readJewelBuildContext(context);
    const result = findAffectedNodes(state.jewels, state.allocatedNodes, state.treeContext);
    const lines = ['=== Timeless Jewel Awareness ===', state.header];
    if (!result.timelessJewels.length && !result.unresolvedJewels.length) lines.push('No recognized Timeless jewels found in the supplied equipped jewels.');
    for (const jewel of result.timelessJewels) {
      lines.push('', `• ${jewel.jewel.jewelType}: seed ${jewel.jewel.seed}, leader ${jewel.jewel.historicCharacter}`,
        `  Socket: ${jewelNodeLabel(jewel.socketNodeId, state)}; radius ${jewel.jewel.radius} (${jewel.jewel.radiusClass})`,
        `  Socket allocated: ${jewel.active ? 'yes' : 'no; effect inactive'}`,
        `  Allocated geometric candidates (${jewel.affectedAllocated.length}): ${jewel.affectedAllocated.map(id => jewelNodeLabel(id, state)).join(', ') || '(none)'}`,
        `  Unallocated geometric candidates: ${jewel.affectedUnallocated.length}`);
    }
    for (const unknown of result.unresolvedJewels) lines.push(`Unavailable: ${unknown.jewelName} @ ${unknown.socketNodeId}: ${unknown.reason}`);
    lines.push(...result.notes);

    const ids = Object.keys(result.byNode).sort((a,b) => Number(a) - Number(b));
    const limit = 30;
    if (ids.length) lines.push('', `=== Current native node state (${Math.min(ids.length, limit)}/${ids.length} allocated candidates requested) ===`);
    for (const id of ids.slice(0, limit)) {
      try {
        if (typeof state.client.getNodeState !== 'function') throw new Error('get_node_state is unavailable');
        const node = await state.client.getNodeState({ node_id: id });
        if (!node || String(node.id) !== id) throw new Error('native node identity does not match');
        lines.push(`• ${id}: ${node.dn ?? '(native name unavailable)'}`);
        if (node.conqueredBy) {
          const marker = node.conqueredBy;
          lines.push(`  Native conquest metadata: seed ${marker.seed ?? 'unknown'}, type ${marker.conqueror_type ?? 'unknown'}`);
          const matches = result.byNode[id].affectingJewels.some(j => j.jewel.seed === Number(marker.seed) && j.jewel.conquerorType === marker.conqueror_type);
          lines.push(`  Parsed jewel match: ${matches ? 'yes' : 'not established'}`);
        } else lines.push('  Native conquest metadata not reported; transformation status remains unknown.');
        if (Array.isArray(node.sd) && node.sd.every((s: unknown) => typeof s === 'string')) {
          lines.push('  Current native stat descriptions:', ...(node.sd.length ? node.sd.map((s: string) => `    ${s}`) : ['    (none reported)']));
        } else lines.push('  Current native stat descriptions are unavailable.');
      } catch (error) { lines.push(`• ${id}: native state unavailable (${error instanceof Error ? error.message : String(error)})`); }
    }
    if (ids.length > limit) lines.push(`${ids.length - limit} additional candidates were not read; their native state remains unknown.`);
    lines.push('', 'Native state is what this PoB instance currently reports. Conquest metadata does not prove that every seed-dependent transformation is implemented or correct in-game. No independent transformation calculation is performed.');
    await state.verifyUnchanged();
    return { isError: false, content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (error) { return jewelHandlerError(error); }
}
