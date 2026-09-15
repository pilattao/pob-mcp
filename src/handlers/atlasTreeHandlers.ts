/** Atlas lookup/search/graph-distance tools. Allocation state is not read. */
import { getAtlasTreeData, type AtlasNode, type AtlasTreeData, type AtlasVariant } from '../services/atlasTreeDataLoader.js';

type AtlasResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
function response(text: string, isError = false): AtlasResponse {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
function failure(error: unknown): AtlasResponse {
  return response(`Error loading atlas data: ${error instanceof Error ? error.message : String(error)}`, true);
}
function metadata(tree: AtlasTreeData, variant: AtlasVariant): string[] {
  return [
    `Game: ${tree.game === 'poe2' ? 'PoE2' : 'PoE1'} | export version: ${tree.version ?? 'unknown'} | variant: ${variant}`,
    `Source: ${tree.provenance.source}`,
    `Retrieved: ${tree.provenance.retrievedAt} | SHA-256: ${tree.provenance.sha256}`,
  ];
}
function classify(node: AtlasNode): string {
  if (node.isDisplayOnly) return 'display-only';
  if (node.isKeystone) return 'keystone';
  if (node.isJewelSocket) return 'jewel';
  if (node.isMastery) return 'mastery';
  if (node.isAtlasWormhole) return 'wormhole';
  if (node.isNotable) return 'notable';
  if (node.ascendancyName) return 'ascendancy';
  return 'normal';
}
function label(node: AtlasNode): string {
  return node.isAtlasRoot ? 'Root' : classify(node);
}

export async function handleGetAtlasNode(nodeId: string, variant: AtlasVariant = 'default', rawJson = false): Promise<AtlasResponse> {
  if (!nodeId) return response('Error: node_id is required.', true);
  try {
    const tree = await getAtlasTreeData(variant);
    const node = tree.nodes[nodeId];
    if (!node || nodeId === 'root') return response([...metadata(tree, variant), `Atlas node ${nodeId} not found.`].join('\n'), true);
    if (rawJson) return response(JSON.stringify({ game: tree.game, version: tree.version, variant,
      provenance: tree.provenance, capabilities: tree.capabilities, sourceGaps: tree.sourceGaps,
      coverage: tree.coverage, roots: tree.roots, node }, null, 2));
    const lines = [`=== Atlas Node ${nodeId}: ${node.name ?? '?'} (${label(node)}) ===`, ...metadata(tree, variant)];
    if (node.subtree) lines.push(`Subtree: ${node.subtree}`);
    if (node.isDisplayOnly) lines.push('Display-only decoration; excluded from search and travel paths.');
    if (node.hasUnresolvedOptions) lines.push('Selector: option effects and the selected choice are not supplied by this export.');
    lines.push('', 'Stats:', ...(node.stats?.length ? node.stats.map(s => `  - ${s}`) : ['  (none)']));
    lines.push('', `Position: group=${node.group} orbit=${node.orbit} orbitIndex=${node.orbitIndex}`,
      `Connections: in=[${(node.in ?? []).join(', ')}] out=[${(node.out ?? []).join(', ')}]`);
    if (node.flavourText?.length) lines.push(`Flavour: ${node.flavourText.join(' ')}`);
    if (tree.game === 'poe2') lines.push('', tree.sourceGaps[0]);
    return response(lines.join('\n'));
  } catch (error) { return failure(error); }
}

export async function handleSearchAtlasNodes(query: string, nodeType?: string, limit = 30, variant: AtlasVariant = 'default'): Promise<AtlasResponse> {
  if (!query?.trim()) return response('Error: query is required.', true);
  if (!Number.isSafeInteger(limit) || limit <= 0) return response('Error: limit must be a positive integer.', true);
  const typeFilter = nodeType?.toLowerCase() || 'any';
  if (!['any', 'keystone', 'notable', 'jewel', 'mastery', 'wormhole', 'ascendancy', 'normal'].includes(typeFilter)) {
    return response(`Error: unsupported atlas node type '${nodeType}'.`, true);
  }
  try {
    const tree = await getAtlasTreeData(variant);
    const lowerQuery = query.trim().toLowerCase();
    const matches = Object.entries(tree.nodes).filter(([id, node]) => id !== 'root' && !node.isDisplayOnly &&
      (typeFilter === 'any' || classify(node) === typeFilter) &&
      ((node.name ?? '').toLowerCase().includes(lowerQuery) || (node.stats ?? []).some(s => s.toLowerCase().includes(lowerQuery))));
    const shown = matches.slice(0, limit);
    const lines = ['=== Atlas Tree Search ===', ...metadata(tree, variant),
      `Query: "${query}" | type: ${typeFilter}`,
      `Found ${matches.length} matching node${matches.length === 1 ? '' : 's'}; showing ${shown.length}.`];
    for (const [id, node] of shown) {
      lines.push('', `**${node.name ?? '?'}** [${label(node).toUpperCase()}] (node ${id})${node.subtree ? ` — ${node.subtree}` : ''}`);
      for (const stat of node.stats ?? []) lines.push(`  - ${stat}`);
      if (node.hasUnresolvedOptions) lines.push('  Selector options are not supplied by this export.');
    }
    return response(lines.join('\n'));
  } catch (error) { return failure(error); }
}

export async function handleFindAtlasPathToNode(targetNodeId: string, fromNodeId: string, variant: AtlasVariant = 'default'): Promise<AtlasResponse> {
  if (!targetNodeId) return response('Error: target_node_id is required.', true);
  if (!fromNodeId) return response('Error: from_node_id is required; no live atlas allocation state is available.', true);
  try {
    const tree = await getAtlasTreeData(variant);
    const source = tree.nodes[fromNodeId];
    const target = tree.nodes[targetNodeId];
    if (!source || !target || fromNodeId === 'root' || targetNodeId === 'root') {
      return response(`Source or target node not found in ${tree.game} atlas (${tree.version ?? 'unversioned'}).`, true);
    }
    if (source.isDisplayOnly || target.isDisplayOnly) return response('Display-only atlas decorations cannot be path endpoints.', true);
    // Connections represent undirected geometry. Their spline values are arc
    // geometry, not edge weights. Separate roots never form a connecting hub.
    const previous = new Map<string, string | null>([[fromNodeId, null]]);
    const queue = [fromNodeId];
    for (let head = 0; head < queue.length && !previous.has(targetNodeId); head++) {
      const id = queue[head];
      const node = tree.nodes[id];
      for (const next of new Set([...(node.in ?? []), ...(node.out ?? [])])) {
        if (next === 'root' || previous.has(next) || !tree.nodes[next] || tree.nodes[next].isDisplayOnly) continue;
        previous.set(next, id);
        queue.push(next);
      }
    }
    const lines = [`=== Atlas Path: ${fromNodeId} → ${targetNodeId} ===`, ...metadata(tree, variant)];
    if (!previous.has(targetNodeId)) {
      lines.push('No path found between these nodes in the published graph. Separate subtrees and missing source connections are not bridged.');
    } else {
      const path: string[] = [];
      for (let id: string | null = targetNodeId; id !== null; id = previous.get(id)!) path.push(id);
      path.reverse();
      lines.push(`Graph distance: ${path.length - 1} edge${path.length === 2 ? '' : 's'}.`, `Nodes in path: ${path.length}`, '');
      for (const [i, id] of path.entries()) {
        const node = tree.nodes[id];
        lines.push(`  ${i === 0 ? 'FROM' : i === path.length - 1 ? 'TARGET' : 'via'}: ${id} — ${node.name ?? '?'} [${label(node)}]${node.subtree ? ` (${node.subtree})` : ''}`);
        if (node.hasUnresolvedOptions) lines.push('    Selector effects are unresolved.');
      }
    }
    lines.push('', ...tree.sourceGaps);
    return response(lines.join('\n'));
  } catch (error) { return failure(error); }
}
