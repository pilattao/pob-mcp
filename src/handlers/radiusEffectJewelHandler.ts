/** Read-only jewel scans against the current native tree and item selection. */
import type { AnyLuaClient } from '../pobLuaBridge.js';
import { getPobTreeData, getLoadedSource } from '../services/pobTreeDataLoader.js';
import { findRadiusEffectJewels } from '../services/radiusEffectJewelService.js';

export interface RadiusEffectJewelHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export function jewelHandlerError(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: `Jewel analysis unavailable: ${error instanceof Error ? error.message : String(error)}` }] };
}

/** Keep Radius and the selected variant's mods; never combine alternate rings/leaders. */
export function jewelModLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const selected = new Set(lines.flatMap(line => /^Selected (?:Alt )?Variant(?: (?:Two|Three|Four|Five))?:\s*(\d+)$/i.exec(line)?.[1] ?? []));
  return lines.flatMap(line => {
    const variant = /\{variant:([\d, ]+)\}/i.exec(line);
    if (variant) {
      if (!selected.size) throw new Error('Selected jewel variant is unavailable; radius and leader cannot be inferred.');
      if (!variant[1].split(',').some(id => selected.has(id.trim()))) return [];
    }
    const cleaned = line.replace(/^(?:\{[^}]+\})+/, '').replace(/\s*\[(?:crafted|fractured)\]\s*$/i, '').trim();
    if (/^(?:Rarity|Implicits|Item Level|LevelReq|Quality|Sockets|Selected .*Variant.*|Variant|Has .*Variant.*|Unique ID|Crafted|Source):/i.test(cleaned) || /^-+$/.test(cleaned)) return [];
    return [cleaned];
  });
}

/** Shared only by the three jewel handlers. All calls below are reads. */
export async function readJewelBuildContext(context: RadiusEffectJewelHandlerContext) {
  await context.ensureLuaClient();
  const client = context.getLuaClient();
  if (!client) throw new Error('PoB Lua client is not initialized.');
  const readInfo = async () => {
    try { return typeof client.getBuildInfo === 'function' ? await client.getBuildInfo() : null; }
    catch { return null; }
  };
  const info = await readInfo();
  const nativeTree = await client.getTree();
  const items = await client.getItems();
  if (!nativeTree || !Array.isArray(nativeTree.nodes)) throw new Error('Native tree allocation is unavailable.');
  if (!Array.isArray(items)) throw new Error('Native equipped-item data is unavailable.');
  const treeVersion = nativeTree.treeVersion ?? info?.treeVersion;
  if (typeof treeVersion !== 'string' || !/^(?:0|3)_\d+$/.test(treeVersion)) throw new Error('Exact active tree version is unavailable; latest-tree fallback is disabled.');
  const game = treeVersion.startsWith('0_') ? 'poe2' : 'poe1';
  const checkInfo = (current: any) => {
    if ((current?.treeVersion && current.treeVersion !== treeVersion) || (current?.game && current.game !== game) ||
      (process.env.POE_GAME && process.env.POE_GAME !== game)) throw new Error('Conflicting native tree version or PoE1/PoE2 game context.');
  };
  checkInfo(info);
  const nodeIds: string[] = nativeTree.nodes.map((id: unknown) => {
    if (!/^\d+$/.test(String(id))) throw new Error('Invalid native passive node ID.');
    return String(id);
  });
  const weaponSets = nativeTree.weaponSets ?? {};
  const modes = Object.values(weaponSets);
  if (modes.some(mode => ![0,1,2].includes(Number(mode)))) throw new Error('Invalid native weapon-set allocation.');
  let activeSet: any = null;
  const needsWeaponSet = modes.some(mode => Number(mode) > 0);
  if (needsWeaponSet) {
    const result = await client.listItemSets();
    activeSet = result?.itemSets?.find((set: any) => set.active === true);
    if (typeof activeSet?.useSecondWeaponSet !== 'boolean') throw new Error('Active weapon set is unavailable; allocations cannot be combined for this scan.');
  }
  const weaponSet = activeSet?.useSecondWeaponSet ? 2 : 1;
  const allocatedNodes = new Set(nodeIds.filter(id => !Number(weaponSets[id]) || Number(weaponSets[id]) === weaponSet));
  const jewels = items.flatMap(item => {
    const socket = /^Jewel\s+(\d+)$/.exec(item?.slot ?? '');
    if (!socket || Number(item.id) === 0) return [];
    if (!Number.isInteger(Number(item.id)) || Number(item.id) < 1 || typeof item.name !== 'string' || typeof item.raw !== 'string') throw new Error(`Jewel data is unavailable for socket ${socket[1]}.`);
    return [{ socketNodeId: socket[1], jewelName: item.name, mods: jewelModLines(item.raw) }];
  });
  const tree = getPobTreeData(treeVersion);
  if (getLoadedSource() !== 'pob-tree-lua') throw new Error('An unversioned fallback cannot establish the current jewel tree.');
  const treeFingerprint = (t: any) => JSON.stringify({ version: t?.treeVersion ?? treeVersion, nodes: [...(t?.nodes ?? [])].map(String).sort(),
    modes: Object.entries(t?.weaponSets ?? {}).sort(([a],[b]) => a.localeCompare(b)) });
  const itemFingerprint = (rows: any[]) => JSON.stringify(rows.map(i => [i.slot, i.id, i.name, i.raw]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
  const originalTree = treeFingerprint(nativeTree), originalItems = itemFingerprint(items);
  const verifyUnchanged = async () => {
    const afterInfo = await readInfo(); checkInfo(afterInfo);
    const afterTree = await client.getTree(), afterItems = await client.getItems();
    if ((info?.name && afterInfo?.name && info.name !== afterInfo.name) || originalTree !== treeFingerprint(afterTree) ||
      !Array.isArray(afterItems) || originalItems !== itemFingerprint(afterItems)) throw new Error('Native build selection changed during the jewel scan; retry against the current state.');
    if (needsWeaponSet) {
      const afterSets = await client.listItemSets();
      const after = afterSets?.itemSets?.find((set: any) => set.active === true);
      if (after?.id !== activeSet.id || after?.useSecondWeaponSet !== activeSet.useSecondWeaponSet) throw new Error('Active weapon set changed during the jewel scan.');
    }
  };
  return { client, jewels, allocatedNodes, treeContext: { treeVersion, tree }, poe2: game === 'poe2', verifyUnchanged,
    header: `Game: ${game}; active tree: ${treeVersion}; allocation scope: ${needsWeaponSet ? `weapon set ${weaponSet}` : 'no weapon-specific allocations'}` };
}

export function jewelNodeLabel(id: string, state: Awaited<ReturnType<typeof readJewelBuildContext>>): string {
  const name = state.treeContext.tree.nodes[id]?.name;
  return name ? `${id} (${name})` : `${id} (static name unavailable)`;
}

export async function handleListRadiusEffectJewels(context: RadiusEffectJewelHandlerContext) {
  try {
    const state = await readJewelBuildContext(context);
    const result = findRadiusEffectJewels(state.jewels, state.allocatedNodes, state.treeContext);
    const lines = ['=== Radius-Effect Jewel Scan ===', state.header,
      `Scanned ${result.jewelsScanned} jewel(s); ${result.jewelsWithRadiusEffects} have supported radius effects.`];
    if (!result.jewels.length) lines.push('No generic radius effects found in the supplied equipped jewels. Timeless conquest and attribute thresholds are separate queries.');
    for (const jewel of result.jewels) {
      lines.push('', `• ${jewel.jewelName} @ ${jewelNodeLabel(jewel.socketNodeId, state)}`,
        `  Radius: ${jewel.innerRadius ? `${jewel.innerRadius}–${jewel.radius} (ring, both boundaries inclusive)` : `${jewel.radius}`} tree units`);
      for (const mod of jewel.radiusMods) lines.push(`  [${mod.category}] ${mod.line}`);
      lines.push(`  Eligible allocated targets (${jewel.affectedAllocated.length}): ${jewel.affectedAllocated.map(id => jewelNodeLabel(id, state)).join(', ') || '(none)'}`);
      if (jewel.innerRadius || jewel.eligibleUnallocated?.length) lines.push(`  Eligible unallocated nodes (${jewel.eligibleUnallocated?.length ?? 0}): ${jewel.eligibleUnallocated?.map(id => jewelNodeLabel(id, state)).join(', ') || '(none)'}`);
      lines.push(...(jewel.notes ?? []));
    }
    lines.push('', state.poe2 ? 'PoE2 scope includes Time-Lost node-type rules and selected Controlled Metamorphosis rings. Unknown target rules or variants are reported as unavailable.' : 'Legacy radius effects are text and geometry reports.',
      'Counts describe node eligibility. This scan does not calculate the numeric effect or establish native jewel-limit handling.');
    await state.verifyUnchanged();
    return { isError: false, content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (error) { return jewelHandlerError(error); }
}
