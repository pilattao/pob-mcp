import type { BuildService } from "../services/buildService.js";
import type { TreeService } from "../services/treeService.js";
import type { TreeAnalysisResult, TreeComparison, PassiveTreeNode, AllocationChange, PassiveTreeData } from "../types.js";
import type { AnyLuaClient } from "../pobLuaBridge.js";
import { handleGetBuildIssues } from "./buildGoalsHandlers.js";
import { planPoe2Tree, formatPoe2TreePlan, type Poe2TreeOptions } from '../services/poe2TreeOptimization.js';
import { readPoe2NodePower } from '../services/poe2TreeMeasurements.js';

export interface TreeHandlerContext {
  buildService: BuildService;
  treeService: TreeService;
  getLuaClient?: () => AnyLuaClient | null;
  ensureLuaClient?: () => Promise<void>;
}

export interface PassiveUpgradesContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export async function handleCompareTrees(
  context: TreeHandlerContext,
  build1Name: string,
  build2Name: string
) {
  try {
    const build1 = await context.buildService.readBuild(build1Name);
    const build2 = await context.buildService.readBuild(build2Name);

    const analysis1 = await context.treeService.analyzePassiveTree(build1);
    const analysis2 = await context.treeService.analyzePassiveTree(build2);

    if (!analysis1 || !analysis2) {
      throw new Error('One or both builds lack passive tree data');
    }

    // Calculate differences
    const nodes1Ids = new Set(analysis1.allocatedNodes.map(n => String(n.skill)));
    const nodes2Ids = new Set(analysis2.allocatedNodes.map(n => String(n.skill)));

    const uniqueToBuild1 = analysis1.allocatedNodes.filter(n => !nodes2Ids.has(String(n.skill)));
    const uniqueToBuild2 = analysis2.allocatedNodes.filter(n => !nodes1Ids.has(String(n.skill)));
    const sharedNodes = analysis1.allocatedNodes.filter(n => nodes2Ids.has(String(n.skill)));

    const pointDifference = analysis1.totalPoints - analysis2.totalPoints;

    let archetypeDifference = '';
    if (analysis1.archetype !== analysis2.archetype) {
      archetypeDifference = `Build 1: ${analysis1.archetype} vs Build 2: ${analysis2.archetype}`;
    } else {
      archetypeDifference = `Both builds: ${analysis1.archetype}`;
    }

    const comparison: TreeComparison = {
      build1: { name: build1Name, analysis: analysis1 },
      build2: { name: build2Name, analysis: analysis2 },
      differences: {
        uniqueToBuild1,
        uniqueToBuild2,
        sharedNodes,
        pointDifference,
        archetypeDifference
      }
    };

    const output = formatTreeComparison(comparison);

    return {
      content: [
        {
          type: "text" as const,
          text: output,
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compare trees: ${errorMsg}`);
  }
}


export async function handleGetNearbyNodes(
  context: TreeHandlerContext,
  buildName: string | undefined,
  maxDistance?: number,
  filter?: string
) {
  try {
    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    // Try file-based path first
    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch {
        // Fall through to Lua fallback
      }
    }

    // Lua bridge fallback when no file or file read failed
    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No allocated nodes found. Provide a build_name or load a build with lua_load_build first.",
        }],
      };
    }

    const allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    const distance = maxDistance || 3;

    // Find nearby nodes using TreeService
    const nearbyNodes = context.treeService.findNearbyNodes(
      allocatedNodes,
      treeData,
      distance,
      filter
    );

    if (nearbyNodes.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No notable or keystone nodes found within ${distance} nodes of your current tree.\n\nTry increasing max_distance or removing the filter.`,
          },
        ],
      };
    }

    const textLines: string[] = [
      `=== Nearby Nodes (within ${distance} nodes) ===`,
      '',
      `Build: ${buildName}`,
      `Found ${nearbyNodes.length} nodes`,
      '',
    ];

    // Group by distance
    const byDistance = new Map<number, typeof nearbyNodes>();
    for (const node of nearbyNodes) {
      const existing = byDistance.get(node.distance) || [];
      existing.push(node);
      byDistance.set(node.distance, existing);
    }

    for (const [dist, nodes] of Array.from(byDistance.entries()).sort((a, b) => a[0] - b[0])) {
      textLines.push(`**Distance ${dist}** (${nodes.length} nodes):`);
      for (const { node, nodeId } of nodes.slice(0, 10)) {
        let line = `- ${node.name || 'Unnamed'} [${nodeId}]`;
        if (node.isKeystone) line += ' (KEYSTONE)';
        textLines.push(line);
        if (node.stats && node.stats.length > 0) {
          textLines.push(`  ${node.stats.slice(0, 2).join('; ')}`);
        }
      }
      if (nodes.length > 10) {
        textLines.push(`  ... and ${nodes.length - 10} more`);
      }
      textLines.push('');
    }

    return {
      content: [
        {
          type: "text" as const,
          text: textLines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${errorMsg}`,
        },
      ],
    };
  }
}

export async function handleFindPath(
  context: TreeHandlerContext,
  buildName: string | undefined,
  targetNodeId: string,
  showAlternatives?: boolean,
  fromNodeId?: string
) {
  try {
    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    // Try file-based path first
    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        const spec = context.buildService.getActiveSpec(build);
        if (!spec) {
          throw new Error("Build has no passive tree data");
        }
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch (fileErr) {
        // Fall through to Lua fallback
        if (buildName) throw fileErr; // Re-throw if explicitly requested
      }
    }

    // Lua bridge fallback when no file or file read failed
    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No allocated nodes found. Provide a build_name or load a build with lua_load_build first.",
        }],
      };
    }

    let allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    // Check if target node exists
    const targetNode = treeData.nodes.get(targetNodeId);
    if (!targetNode) {
      throw new Error(`Node ${targetNodeId} not found in tree data`);
    }

    // Check if target is already allocated
    if (allocatedNodes.has(targetNodeId)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Node ${targetNodeId} (${targetNode.name || "Unknown"}) is already allocated in this build.`,
          },
        ],
      };
    }

    // If from_node_id is provided, route from that specific node instead of
    // the build frontier — enables any-node-to-any-node routing.
    if (fromNodeId) {
      if (!treeData.nodes.has(fromNodeId)) {
        throw new Error(`from_node_id ${fromNodeId} not found in tree data`);
      }
      allocatedNodes = new Set([fromNodeId]);
      treeVersion = treeVersion; // keep for header
    }

    // Find shortest path(s) using TreeService
    const paths = context.treeService.findShortestPaths(
      allocatedNodes,
      targetNodeId,
      treeData,
      showAlternatives ? 3 : 1
    );

    if (paths.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No path found to node ${targetNodeId} (${targetNode.name || "Unknown"}).\n\nThis node may be unreachable from your current tree (e.g., different class starting area or ascendancy nodes).`,
          },
        ],
      };
    }

    // Format output
    const routeDesc = fromNodeId
      ? `from node ${fromNodeId} to ${targetNode.name || targetNodeId}`
      : `to ${targetNode.name || "Node " + targetNodeId}`;
    const textLines: string[] = [
      `=== Path ${routeDesc} ===`,
      '',
    ];
    if (fromNodeId) {
      const fromNode = treeData.nodes.get(fromNodeId);
      textLines.push(`From: ${fromNode?.name || "Unknown"} [${fromNodeId}]`);
    } else {
      textLines.push(`Build: ${buildName}`);
    }
    textLines.push(`Target: ${targetNode.name || "Unknown"} [${targetNodeId}]`);
    if (targetNode.isKeystone) textLines.push('Type: KEYSTONE');
    else if (targetNode.isNotable) textLines.push('Type: Notable');
    textLines.push('');

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const pathLabel = paths.length > 1 ? `Path ${i + 1} (Alternative ${i === 0 ? "- Shortest" : i})` : "Shortest Path";

      const keystones = path.nodes.filter(id => treeData.nodes.get(id)?.isKeystone).length;
      const notables  = path.nodes.filter(id => { const n = treeData.nodes.get(id); return n?.isNotable && !n?.isKeystone; }).length;
      const travel    = path.nodes.length - keystones - notables;

      textLines.push(`**${pathLabel}**`);
      textLines.push(`Total Cost: ${path.cost} passive points`);
      textLines.push(`Nodes to Allocate: ${path.nodes.length}  (${keystones > 0 ? keystones + ' keystone, ' : ''}${notables} notable, ${travel} travel)`, '');

      textLines.push('Allocation Order:');
      for (let j = 0; j < path.nodes.length; j++) {
        const nodeId = path.nodes[j];
        const node = treeData.nodes.get(nodeId);
        if (!node) continue;

        const isTarget = nodeId === targetNodeId;
        const prefix = isTarget ? "→ TARGET: " : `  ${j + 1}. `;

        textLines.push(`${prefix}${node.name || "Travel Node"} [${nodeId}]`);

        if (node.stats && node.stats.length > 0) {
          for (const stat of node.stats) {
            textLines.push(`      ${stat}`);
          }
        } else if (!isTarget) {
          textLines.push('      (Travel node - no stats)');
        }

        if (j < path.nodes.length - 1) textLines.push('');
      }

      if (i < paths.length - 1) textLines.push('', '='.repeat(50), '');
    }

    textLines.push('', '**Next Steps:**');
    textLines.push('Use lua_set_tree to allocate these nodes and recalculate stats.');

    return {
      content: [
        {
          type: "text" as const,
          text: textLines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${errorMsg}`,
        },
      ],
    };
  }
}


export async function handlePlanTreePaths(
  context: TreeHandlerContext,
  buildName: string | undefined,
  targetNodeIds: string[],
) {
  try {
    if (!targetNodeIds || targetNodeIds.length === 0) {
      return { content: [{ type: "text" as const, text: "No target node IDs provided." }] };
    }

    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch (fileErr) {
        if (buildName) throw fileErr;
      }
    }

    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No allocated nodes found. Load a build first." }],
      };
    }

    const allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    // Find path to each target; collect per-target results
    const perTarget: Array<{
      nodeId: string;
      name: string;
      pathNodes: string[];
      cost: number;
      alreadyAllocated: boolean;
      notFound: boolean;
    }> = [];

    for (const nodeId of targetNodeIds) {
      const node = treeData.nodes.get(nodeId);
      if (!node) {
        perTarget.push({ nodeId, name: "NOT FOUND", pathNodes: [], cost: 0, alreadyAllocated: false, notFound: true });
        continue;
      }
      if (allocatedNodes.has(nodeId)) {
        perTarget.push({ nodeId, name: node.name || nodeId, pathNodes: [], cost: 0, alreadyAllocated: true, notFound: false });
        continue;
      }
      const paths = context.treeService.findShortestPaths(allocatedNodes, nodeId, treeData, 1);
      if (paths.length === 0) {
        perTarget.push({ nodeId, name: node.name || nodeId, pathNodes: [], cost: 0, alreadyAllocated: false, notFound: true });
      } else {
        perTarget.push({ nodeId, name: node.name || nodeId, pathNodes: paths[0].nodes, cost: paths[0].cost, alreadyAllocated: false, notFound: false });
      }
    }

    // Union all path nodes — deduplication is automatic via Set
    const unionNodes = new Set<string>();
    for (const t of perTarget) {
      for (const n of t.pathNodes) unionNodes.add(n);
    }

    // Track which nodes appear in multiple paths (shared)
    const nodePathCount = new Map<string, number>();
    for (const t of perTarget) {
      for (const n of t.pathNodes) nodePathCount.set(n, (nodePathCount.get(n) ?? 0) + 1);
    }
    const sharedNodes = [...nodePathCount.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    const totalIndividual = perTarget.reduce((s, t) => s + t.cost, 0);
    const totalMerged = unionNodes.size;
    const saved = totalIndividual - totalMerged;

    const lines: string[] = [
      `=== Plan: ${targetNodeIds.length} target node(s) ===`,
      '',
    ];

    // Per-target breakdown
    lines.push('**Per-target paths:**');
    for (let i = 0; i < perTarget.length; i++) {
      const t = perTarget[i];
      if (t.notFound) {
        lines.push(`  ${i + 1}. ⚠️  ${t.nodeId} — not found in tree data`);
      } else if (t.alreadyAllocated) {
        lines.push(`  ${i + 1}. ✓  ${t.name} [${t.nodeId}] — already allocated`);
      } else {
        const node = treeData.nodes.get(t.nodeId);
        const typeTag = node?.isKeystone ? 'KEYSTONE' : node?.isNotable ? 'notable' : 'travel';
        const sharedCount = t.pathNodes.filter(n => sharedNodes.includes(n) && n !== t.nodeId).length;
        const sharedNote = sharedCount > 0 ? ` (${sharedCount} node(s) shared with other paths)` : '';
        lines.push(`  ${i + 1}. ${t.name} [${t.nodeId}] (${typeTag}) — ${t.cost} node(s)${sharedNote}`);
        // Show compact path
        const pathStr = t.pathNodes
          .map(n => {
            const nd = treeData.nodes.get(n);
            const label = nd?.isNotable || nd?.isKeystone ? `**${nd.name || n}**` : n;
            return label;
          })
          .join(' → ');
        lines.push(`     ${pathStr}`);
      }
    }
    lines.push('');

    // Shared nodes summary
    if (sharedNodes.length > 0) {
      lines.push(`**Shared path nodes (${sharedNodes.length}):** ${sharedNodes.join(', ')}`);
      lines.push('');
    }

    // Cost summary
    lines.push('**Cost summary:**');
    lines.push(`  Sum of individual paths: ${totalIndividual} nodes`);
    lines.push(`  After merging shared prefixes: ${totalMerged} nodes`);
    if (saved > 0) {
      lines.push(`  Points saved by merging: ${saved}`);
    }
    lines.push('');

    // Notable stats summary
    const notableIds = [...unionNodes].filter(n => {
      const nd = treeData.nodes.get(n);
      return nd?.isNotable || nd?.isKeystone;
    });
    if (notableIds.length > 0) {
      lines.push('**Notables/keystones included:**');
      for (const nid of notableIds) {
        const nd = treeData.nodes.get(nid);
        if (!nd) continue;
        const tag = nd.isKeystone ? 'KEYSTONE' : 'Notable';
        lines.push(`  - ${nd.name || nid} [${nid}] (${tag})`);
        if (nd.stats) {
          for (const s of nd.stats) lines.push(`      ${s}`);
        }
      }
      lines.push('');
    }

    // Combined node list for lua_set_tree
    const nodeList = [...unionNodes];
    lines.push('**Combined node list (add these to your lua_set_tree call):**');
    lines.push(JSON.stringify(nodeList));

    return { content: [{ type: "text" as const, text: lines.join('\n') }] };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: `Error: ${errorMsg}` }] };
  }
}

export async function handleGetPassiveUpgrades(
  context: PassiveUpgradesContext,
  focus: 'dps' | 'defence' | 'both' = 'both',
  maxResults: number = 10,
  options?: Poe2TreeOptions
) {
  if (process.env.POE_GAME === 'poe2') {
    if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > 100) throw new Error('max_results must be an integer from 0 to 100');
    const data = await planPoe2Tree(context, undefined, focus, maxResults === 0 ? 0 : options?.points_available, maxResults !== 0, 1, {}, options);
    return {content:[{type:'text' as const,text:formatPoe2TreePlan(data,maxResults)}],structuredContent:data};
  }
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');

  // Step 1: get current base stats and issues to determine search keywords
  const { issues, stats: baseStats } = await handleGetBuildIssues(context);

  const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 1;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 1;

  // Step 2: map focus + issues to search keywords
  // Use broad keywords that cover attack, spell, and generic damage scaling.
  // Avoid "critical" alone — at 100% crit it adds nothing.
  const keywords: string[] = [];

  if (focus === 'dps' || focus === 'both') {
    keywords.push('damage', 'attack speed', 'accuracy', 'physical');
  }

  if (focus === 'defence' || focus === 'both') {
    keywords.push('life', 'energy shield');
    const hasResistIssue = issues.some(i => i.category === 'resistance' && (i.severity === 'error' || i.severity === 'warning'));
    if (hasResistIssue) {
      keywords.push('resistance');
    }
  }

  // Step 3: search for notable candidates
  const seen = new Set<string>();
  const candidates: any[] = [];

  for (const keyword of keywords.slice(0, 5)) {
    try {
      const results = await luaClient.searchNodes({
        keyword,
        nodeType: 'notable',
        maxResults: 12,
        includeAllocated: false,
      });
      if (results && results.nodes) {
        for (const node of results.nodes) {
          const id = String(node.id);
          if (!seen.has(id)) {
            seen.add(id);
            candidates.push(node);
          }
        }
      }
    } catch { /* skip failed searches */ }
  }

  if (candidates.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: `=== Passive Upgrades (focus: ${focus}) ===\n\nNo unallocated notable candidates found. Make sure a build is loaded.\n`,
      }],
    };
  }

  // Step 4: simulate each candidate with calcWith
  interface ScoredNode {
    node: any;
    dpsDelta: number;
    ehpDelta: number;
    score: number;
  }

  const scored: ScoredNode[] = [];

  for (const node of candidates) {
    try {
      const out = await luaClient.calcWith({ addNodes: [node.id] });
      if (!out) continue;

      // calcWith returns raw Lua output; minion stats are nested under out.Minion
      // (unlike getStats() which remaps them to MinionTotalDPS etc.)
      const outDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) ||
                     (out.Minion?.CombinedDPS as number) || (out.Minion?.TotalDPS as number) || baseDPS;
      const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;

      const dpsDelta = outDPS - baseDPS;
      const ehpDelta = outEHP - baseEHP;

      // Relative score weighted by focus
      let score: number;
      if (focus === 'dps') {
        score = dpsDelta / baseDPS;
      } else if (focus === 'defence') {
        score = ehpDelta / baseEHP;
      } else {
        score = (dpsDelta / baseDPS) + (ehpDelta / baseEHP);
      }

      scored.push({ node, dpsDelta, ehpDelta, score });
    } catch { /* skip nodes that fail calcWith */ }
  }

  // Step 5: sort and return top N
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  const textLines: string[] = [
    `=== Passive Upgrades (focus: ${focus}) ===`,
    '',
    `Base DPS: ${Math.round(baseDPS).toLocaleString()}  |  Base EHP: ${Math.round(baseEHP).toLocaleString()}`,
    `Evaluated ${candidates.length} candidate notables, showing top ${top.length}:`,
    '',
  ];

  for (let i = 0; i < top.length; i++) {
    const { node, dpsDelta, ehpDelta, score } = top[i];
    textLines.push(`${i + 1}. **${node.name}** [${node.id}]`);
    let scoreLine = `   Score: ${score.toFixed(4)}`;
    if (dpsDelta !== 0) scoreLine += `  |  DPS Δ: ${dpsDelta > 0 ? '+' : ''}${Math.round(dpsDelta).toLocaleString()}`;
    if (ehpDelta !== 0) scoreLine += `  |  EHP Δ: ${ehpDelta > 0 ? '+' : ''}${Math.round(ehpDelta).toLocaleString()}`;
    textLines.push(scoreLine);
    if (node.stats && node.stats.length > 0) {
      for (const stat of (node.stats as string[]).slice(0, 2)) {
        textLines.push(`   - ${stat}`);
      }
    }
    textLines.push('');
  }

  if (top.length === 0) {
    textLines.push('No results after simulation. Try a different focus or ensure a build is loaded.');
  } else {
    textLines.push('', '💡 Use lua_set_tree to allocate the top node and recalculate stats.');
  }

  return {
    content: [{ type: 'text' as const, text: textLines.join('\n') }],
  };
}

interface ScoredEffect {
  stat: string;
  dpsDelta: number;
  ehpDelta: number;
}

export async function handleSuggestMasteries(context: PassiveUpgradesContext) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const data = await luaClient.getMasteryOptions();
  // Lua returns: { masteries: [{ nodeId, name, options: [{ effectId, stats: string[], selected: bool }] }] }
  const allMasteries: any[] = data?.masteries ?? [];

  // Only show masteries that have a selected effect (i.e. the node is allocated and an effect chosen)
  const masteries = allMasteries.filter((m: any) =>
    (m.options ?? []).some((o: any) => o.selected)
  );

  if (masteries.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '=== Mastery Suggestions ===\n\nNo allocated mastery effects found in the current build.\n' }],
    };
  }

  // Get base stats for scoring
  const baseStats = await luaClient.getStats(['TotalDPS', 'CombinedDPS', 'MinionTotalDPS', 'TotalEHP', 'Life']);
  const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 1;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 1;

  // Current mastery effect map: { nodeId: effectId } from selected options
  const currentMasteryEffects: Record<number, number> = {};
  for (const m of allMasteries) {
    const selected = (m.options ?? []).find((o: any) => o.selected);
    if (selected) currentMasteryEffects[m.nodeId] = selected.effectId;
  }

  const outputLines: string[] = ['=== Mastery Node Suggestions ===', ''];

  for (const mastery of masteries) {
    const options: any[] = mastery.options ?? [];
    const currentOption = options.find((o: any) => o.selected);
    const currentStat = currentOption?.stats?.join(' / ') ?? String(currentOption?.effectId ?? '?');

    outputLines.push(`**${mastery.name ?? 'Mastery'}** (node ${mastery.nodeId})`);
    outputLines.push(`  Current: ${currentStat}`);

    // Simulate each alternative effect choice
    const scored: ScoredEffect[] = [];
    for (const effect of options) {
      try {
        const newMasteryEffects = { ...currentMasteryEffects, [mastery.nodeId]: effect.effectId };
        const out = await luaClient.calcWith({ masteryEffects: newMasteryEffects });
        if (!out) continue;
        const outDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) ||
                       (out.Minion?.CombinedDPS as number) || (out.Minion?.TotalDPS as number) || baseDPS;
        const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;
        const statStr = effect.stats?.join(' / ') ?? String(effect.effectId);
        scored.push({ stat: statStr, dpsDelta: outDPS - baseDPS, ehpDelta: outEHP - baseEHP });
      } catch { /* skip effects that fail simulation */ }
    }

    scored.sort((a, b) =>
      ((b.dpsDelta / baseDPS) + (b.ehpDelta / baseEHP)) -
      ((a.dpsDelta / baseDPS) + (a.ehpDelta / baseEHP))
    );
    if (scored.length === 0) {
      outputLines.push('  (simulation unavailable for this mastery)');
    }
    for (const s of scored.slice(0, 3)) {
      const dpsStr = s.dpsDelta !== 0 ? ` | DPS ${s.dpsDelta > 0 ? '+' : ''}${Math.round(s.dpsDelta)}` : '';
      const ehpStr = s.ehpDelta !== 0 ? ` | EHP ${s.ehpDelta > 0 ? '+' : ''}${Math.round(s.ehpDelta)}` : '';
      const marker = s.stat === currentStat ? ' ← current' : '';
      outputLines.push(`  - ${s.stat}${dpsStr}${ehpStr}${marker}`);
    }
    outputLines.push('');
  }

  return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
}

// Helper function
function formatTreeComparison(comparison: TreeComparison): string {
  const lines: string[] = [
    '=== Passive Tree Comparison ===',
    '',
    `Build 1: ${comparison.build1.name}`,
    `Build 2: ${comparison.build2.name}`,
    '',
    '=== Point Allocation ===',
    `Build 1: ${comparison.build1.analysis.totalPoints} points`,
    `Build 2: ${comparison.build2.analysis.totalPoints} points`,
    `Difference: ${Math.abs(comparison.differences.pointDifference)} points ` +
      (comparison.differences.pointDifference > 0 ? '(Build 1 has more)' : '(Build 2 has more)'),
    '',
    '=== Archetype Comparison ===',
    comparison.differences.archetypeDifference,
    '',
    '=== Keystones Comparison ===',
    `Build 1 Keystones: ${comparison.build1.analysis.keystones.map(k => k.name).join(', ') || 'None'}`,
    `Build 2 Keystones: ${comparison.build2.analysis.keystones.map(k => k.name).join(', ') || 'None'}`,
  ];

  // Unique keystones
  const uniqueKeystones1 = comparison.differences.uniqueToBuild1.filter(n => n.isKeystone);
  const uniqueKeystones2 = comparison.differences.uniqueToBuild2.filter(n => n.isKeystone);

  if (uniqueKeystones1.length > 0) {
    lines.push('\nUnique to Build 1:');
    for (const ks of uniqueKeystones1) {
      lines.push(`- ${ks.name}`);
    }
  }

  if (uniqueKeystones2.length > 0) {
    lines.push('\nUnique to Build 2:');
    for (const ks of uniqueKeystones2) {
      lines.push(`- ${ks.name}`);
    }
  }

  // Notables comparison
  lines.push(
    '',
    '=== Notable Passives Comparison ===',
    `Build 1: ${comparison.build1.analysis.notables.length} notables`,
    `Build 2: ${comparison.build2.analysis.notables.length} notables`
  );

  const uniqueNotables1 = comparison.differences.uniqueToBuild1.filter(n => n.isNotable);
  const uniqueNotables2 = comparison.differences.uniqueToBuild2.filter(n => n.isNotable);

  if (uniqueNotables1.length > 0) {
    lines.push('\nTop 5 Unique Notables to Build 1:');
    for (const notable of uniqueNotables1.slice(0, 5)) {
      lines.push(`- ${notable.name || 'Unnamed'}`);
    }
  }

  if (uniqueNotables2.length > 0) {
    lines.push('\nTop 5 Unique Notables to Build 2:');
    for (const notable of uniqueNotables2.slice(0, 5)) {
      lines.push(`- ${notable.name || 'Unnamed'}`);
    }
  }

  // Pathing efficiency
  lines.push(
    '',
    '=== Pathing Efficiency ===',
    `Build 1: ${comparison.build1.analysis.pathingEfficiency}`,
    `Build 2: ${comparison.build2.analysis.pathingEfficiency}`,
    '',
    '=== Shared Nodes ===',
    `${comparison.differences.sharedNodes.length} nodes are allocated in both builds`
  );

  return lines.join('\n');
}

export async function handleGetNodePower(
  context: TreeHandlerContext,
  mode?: string,
  filter?: string,
  maxDepth?: number,
  limit?: number,
  recalculate?: boolean,
) {
  if (process.env.POE_GAME === 'poe2') return readPoe2NodePower(context, mode, filter, maxDepth, limit, recalculate);
  const luaClient = context.getLuaClient?.();
  if (!luaClient) {
    return {
      content: [{ type: "text" as const, text: "No live PoB connection. Launch PoB via LaunchPoBWithAPI.bat and connect first." }],
    };
  }

  const params: Record<string, any> = {};
  if (mode) params.mode = mode;
  if (filter) params.filter = filter;
  if (maxDepth !== undefined) params.max_depth = maxDepth;
  if (limit !== undefined) params.limit = limit;
  if (recalculate !== undefined) params.recalculate = recalculate;

  const data = await (luaClient as any).getNodePower(params);

  if (!data.has_data) {
    const pending = data.recalc_pending;
    const lines = ["=== Node Power ===", ""];
    if (pending) {
      lines.push(
        "Recalculation in progress — PoB is computing node power in the background.",
        "Call this tool again in a few seconds to see results.",
      );
    } else {
      lines.push(
        "No power data available. Either:",
        "  1. Enable 'Show Node Power' in PoB's Tree tab, or",
        "  2. Call this tool with recalculate=true to trigger computation.",
      );
    }
    lines.push("", `Filter: ${data.filter}  |  Mode: ${data.mode}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }

  const effectiveMode = data.mode as string;
  const effectiveFilter = data.filter as string;
  const nodes = data.nodes as any[];
  const powerMax = data.power_max as { offence: number; defence: number };

  const modeLabel = effectiveMode === "offence" ? "Offence" : effectiveMode === "defence" ? "Defence" : "Combined";
  const filterLabel = effectiveFilter === "unallocated" ? "Unallocated" : effectiveFilter === "allocated" ? "Allocated" : "All";
  const depthLabel = maxDepth !== undefined ? ` | Max depth: ${maxDepth}` : "";

  const lines: string[] = [
    "=== Node Power Rankings ===",
    "",
    `Sort: ${modeLabel}  |  Filter: ${filterLabel}${depthLabel}  |  Showing: ${nodes.length} of ${data.total}`,
    `Power max — Offence: ${powerMax.offence.toFixed(4)}  Defence: ${powerMax.defence.toFixed(4)}`,
    "",
  ];

  // Column header
  lines.push(
    `${"Rank".padEnd(5)} ${"Node".padEnd(34)} ${"Type".padEnd(12)} ${"Off".padStart(8)} ${"Def".padStart(8)} ${"Comb".padStart(8)}${maxDepth !== undefined ? "  Depth" : ""}`,
    `${"----".padEnd(5)} ${"----".padEnd(34)} ${"----".padEnd(12)} ${"---".padStart(8)} ${"---".padStart(8)} ${"----".padStart(8)}${maxDepth !== undefined ? "  -----" : ""}`,
  );

  nodes.forEach((node: any, i: number) => {
    const rank = String(i + 1).padEnd(5);
    const name = (node.name as string).slice(0, 34).padEnd(34);
    const type = (node.type as string).slice(0, 12).padEnd(12);
    const off = (node.offence as number).toFixed(4).padStart(8);
    const def = (node.defence as number).toFixed(4).padStart(8);
    const comb = (node.combined as number).toFixed(4).padStart(8);
    const depth = node.depth !== null && node.depth !== undefined ? `  ${String(node.depth).padStart(5)}` : "";
    lines.push(`${rank} ${name} ${type} ${off} ${def} ${comb}${maxDepth !== undefined ? depth : ""}`);
  });

  if (data.recalc_pending) {
    lines.push("", "(Recalculation still in progress — call again for more complete results.)");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
