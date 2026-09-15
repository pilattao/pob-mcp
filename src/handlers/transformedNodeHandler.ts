/**
 * Handler for the get_tree_node_with_timeless_jewels MCP tool.
 *
 * Returns a single node's stats as PoB currently has them — which means with
 * Timeless Jewel transformations applied if the node is in a jewel's radius.
 * Uses the `get_node_state` Lua action, which reads the post-transformation
 * `node.sd` from PoB's PassiveSpec.
 *
 * This is the Phase-2 piece for jewel awareness: where find_jewel_affected_nodes
 * tells you WHICH nodes are transformed, this tool tells you WHAT they
 * transform into — without needing tooltip pastes, game-data extraction, or a
 * stat-template renderer. PoB has already done the work; we just expose it.
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import { getPobNode } from "../services/pobTreeDataLoader.js";

export interface TransformedNodeHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

/**
 * Detect "PoB TCP not available" style failures so we can fall back to
 * static base-data instead of erroring. Covers ECONNREFUSED, timeouts,
 * missing-client states, and the bridge's own "no client" errors.
 */
function isTcpUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("cannot connect") ||
    msg.includes("not initialized") ||
    msg.includes("not connected") ||
    msg.includes("not running") ||
    msg.includes("timeout") ||
    msg.includes("etimedout")
  );
}

/**
 * Format a base-data-only response when PoB TCP isn't available. Returns
 * the node's intrinsic stats from PoB's tree.lua (or GGG's data.json
 * fallback), with a loud note that jewel transformations have NOT been
 * applied. Caller should treat this as a graceful degradation, not as a
 * complete answer.
 */
function renderBaseFallback(nodeId: string, reason: string) {
  if (process.env.POE_GAME === 'poe2') {
    return {isError:true,content:[{type:'text',text:`Native PoE2 node state is unavailable: ${reason}. No current tree version or transformation state was established.`}]};
  }
  const baseNode = getPobNode(nodeId);
  if (!baseNode) {
    return {
      content: [
        {
          type: "text",
          text: `Node ${nodeId} not found in base tree data (TCP also unavailable: ${reason}).`,
        },
      ],
    };
  }
  const lines: string[] = [];
  const typeLabel = baseNode.isKeystone
    ? "Keystone"
    : baseNode.isJewelSocket
      ? "Jewel Socket"
      : baseNode.isMastery
        ? "Mastery"
        : baseNode.isNotable
          ? "Notable"
          : "Travel";
  lines.push(`=== Node ${nodeId}: ${baseNode.name ?? "?"} (${typeLabel}) ===`);
  lines.push(`Source: PoB tree.lua / GGG data.json (BASE DATA — TCP unavailable)`);
  if (baseNode.ascendancyName) lines.push(`Ascendancy: ${baseNode.ascendancyName}`);
  lines.push("");
  lines.push("Base stats (jewel transformations NOT applied — see warning below):");
  if (baseNode.stats && baseNode.stats.length > 0) {
    for (const s of baseNode.stats) lines.push(`  - ${s}`);
  } else {
    lines.push("  (none)");
  }
  lines.push("");
  lines.push("⚠ DEGRADED MODE — PoB TCP API is unavailable, so we can't read the");
  lines.push("post-Timeless-Jewel-transformation node state. The stats above are");
  lines.push("the base (untransformed) values from PoB's tree.lua.");
  lines.push("");
  lines.push(`  Reason: ${reason}`);
  lines.push("  To get real transformed stats: launch PoB via LaunchPoBWithAPI.bat,");
  lines.push("  then re-run this tool.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

interface NodeStateResult {
  id: number;
  dn?: string;
  type?: string;
  allocated?: boolean;
  sd?: string[];
  conqueredBy?: { seed?: number; conqueror_type?: string };
  ascendancyName?: string;
}

export async function handleGetTreeNodeWithTimelessJewels(
  context: TransformedNodeHandlerContext,
  nodeId: string
) {
  if (!nodeId) {
    return {
      content: [{ type: "text", text: "Error: node_id is required." }],
      isError: true,
    };
  }
  // Try to bring up the Lua client. If PoB isn't running (or anything in the
  // TCP path fails), gracefully fall back to base data with a degraded-mode
  // notice instead of erroring out.
  try {
    await context.ensureLuaClient();
  } catch (err) {
    if (isTcpUnavailableError(err)) {
      return renderBaseFallback(nodeId, err instanceof Error ? err.message : String(err));
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error initializing PoB Lua client: ${msg}` }],
      isError: true,
    };
  }
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    return renderBaseFallback(nodeId, "PoB Lua client not initialized");
  }

  let node: NodeStateResult;
  try {
    node = (await luaClient.getNodeState({ node_id: nodeId })) as NodeStateResult;
  } catch (err) {
    if (isTcpUnavailableError(err)) {
      return renderBaseFallback(nodeId, err instanceof Error ? err.message : String(err));
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading node state: ${msg}` }],
      isError: true,
    };
  }

  if (!node) {
    return {
      content: [{ type: "text", text: `Node ${nodeId} not found.` }],
    };
  }

  const lines: string[] = [];
  const dn = node.dn ?? "?";
  const typeLabel = node.type ? node.type.charAt(0).toUpperCase() + node.type.slice(1) : "?";
  lines.push(`=== Node ${node.id}: ${dn} (${typeLabel}) ===`);
  if (node.ascendancyName) lines.push(`Ascendancy: ${node.ascendancyName}`);
  lines.push(`Allocated: ${node.allocated ? "yes" : "no"}`);

  if (node.conqueredBy) {
    lines.push(`Conquest metadata: ${node.conqueredBy.conqueror_type ?? 'type unknown'}` +
      (node.conqueredBy.seed !== undefined ? ` (seed ${node.conqueredBy.seed})` : ''));
  }

  lines.push("");
  lines.push("Stats (as PoB currently renders them):");
  if (node.sd && node.sd.length > 0) {
    for (const line of node.sd) lines.push(`  - ${line}`);
  } else {
    lines.push("  (none)");
  }

  if (!node.conqueredBy) {
    lines.push("");
    lines.push(
      "Transformation status is unknown: no conquest metadata was returned. " +
        "The displayed native stats may include item effects; absence of metadata does not establish base-data equality."
    );
  } else {
    lines.push("");
    lines.push(
      "Source: the current native PassiveSpec descriptions. Conquest metadata alone does not establish complete seed-dependent transformation support."
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
