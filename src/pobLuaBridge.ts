import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { createConnection, Socket } from "net";
import { EventEmitter } from "events";
import path from "path";
import os from "os";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/** Lua bridge request envelope */
type LuaRequest = { action: string; params?: Record<string, unknown> };
/** Lua bridge response envelope — always an object with at minimum `ok: boolean` */
type LuaResponse = { ok: boolean; error?: string; [key: string]: unknown };

/** PoE2 returns per-gem selections; PoE1 returns only the catalog ID/name. */
type SpectreSelection = { id: string; name: string; groupIndex?: number; gemIndex?: number; enabled?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Shared base class
// Both stdio (PoBLuaApiClient) and TCP (PoBLuaTcpClient) transports share all
// business methods; only the connection layer differs.
// ─────────────────────────────────────────────────────────────────────────────

abstract class PoBApiBase {
  protected buffer = "";
  protected isSending = false;
  protected killed = false;
  protected ready = false;
  protected dataEmitter = new EventEmitter();

  constructor() {
    this.dataEmitter.on("error", () => {});
  }

  abstract isAlive(): boolean;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  protected abstract getTimeoutMs(): number;
  /** Write one newline-terminated JSON string to the transport. */
  protected abstract sendRaw(line: string): void;
  /** Called on timeout to tear down the transport connection. */
  protected abstract tearDownOnTimeout(): void;

  protected readLineWithTimeout(timeoutMs?: number): Promise<string> {
    const ms = timeoutMs ?? this.getTimeoutMs();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.killed = true;
        this.ready = false;
        this.buffer = "";
        this.tearDownOnTimeout();
        reject(new Error("Timed out waiting for PoB response — bridge will auto-restart on next request"));
      }, ms);

      const tryRead = (): boolean => {
        const idx = this.buffer.indexOf("\n");
        if (idx >= 0) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          cleanup();
          resolve(line);
          return true;
        }
        return false;
      };

      const onError = (err: Error) => { cleanup(); reject(err); };
      const onData  = () => { tryRead(); };

      const cleanup = () => {
        clearTimeout(timer);
        this.dataEmitter.off("data", onData);
        this.dataEmitter.off("error", onError);
      };

      if (!tryRead()) {
        this.dataEmitter.on("data", onData);
        this.dataEmitter.on("error", onError);
      }
    });
  }

  protected async send(obj: LuaRequest): Promise<LuaResponse> {
    if (!this.isAlive()) throw new Error("PoB bridge not connected or not ready");
    if (this.killed)     throw new Error("PoB bridge disconnected");
    if (this.isSending)  throw new Error("Concurrent request not supported");

    this.isSending = true;
    try {
      this.sendRaw(JSON.stringify(obj) + "\n");

      let attempts = 0;
      const maxAttempts = 100;
      while (attempts < maxAttempts) {
        const line = await this.readLineWithTimeout();
        attempts++;
        if (!line.trim() || !line.trim().startsWith("{")) continue;
        try { return JSON.parse(line); } catch {}
      }
      throw new Error(`Failed to receive valid JSON response after ${maxAttempts} lines`);
    } finally {
      this.isSending = false;
    }
  }

  // ── Business methods ────────────────────────────────────────────────────────
  // All shared between stdio and TCP transports — only this.send() differs.

  async ping(): Promise<boolean> {
    const res = await this.send({ action: "ping" });
    return !!res.ok;
  }

  async newBuild(params?: { className?: string; ascendancy?: string }): Promise<any> {
    const res = await this.send({ action: "new_build", params: params || {} });
    if (!res.ok) throw new Error(res.error || "new_build failed");
    return res;
  }

  async saveBuild(filePath: string): Promise<any> {
    const res = await this.send({ action: "save_build", params: { path: filePath } });
    if (!res.ok) throw new Error(res.error || "save_build failed");
    return res.result;
  }

  async loadBuildXml(xml: string, name = "API Build", path = ""): Promise<any> {
    const res = await this.send({ action: "load_build_xml", params: { xml, name } });
    if (!res.ok) throw new Error(res.error || "load_build_xml failed");
    return res;
  }

  async getStats(fields?: string[]): Promise<Record<string, any>> {
    const res = await this.send({ action: "get_stats", params: { fields } });
    if (!res.ok) throw new Error(res.error || "get_stats failed");
    return res.stats as Record<string, any>;
  }

  async getTree(): Promise<any> {
    const res = await this.send({ action: "get_tree" });
    if (!res.ok) throw new Error(res.error || "get_tree failed");
    return res.tree;
  }

  async getItems(): Promise<any[]> {
    const res = await this.send({ action: "get_items" });
    if (!res.ok) throw new Error(res.error || "get_items failed");
    return res.items as any[];
  }

  async addItem(itemText: string, slotName?: string, noAutoEquip?: boolean): Promise<any> {
    const res = await this.send({ action: "add_item_text", params: { text: itemText, slotName, noAutoEquip } });
    if (!res.ok) throw new Error(res.error || "add_item_text failed");
    return res.item;
  }

  async clearItemSlot(slotName: string): Promise<{ slot: string; cleared: boolean }> {
    const res = await this.send({ action: 'clear_item_slot', params: { slotName } });
    if (!res.ok) throw new Error(res.error || 'clear_item_slot failed');
    return res.result as { slot: string; cleared: boolean };
  }

  async setFlaskActive(flaskIndex: number | undefined, active: boolean, slotName?: string): Promise<void> {
    const params = slotName === undefined ? { index: flaskIndex, active } : { slotName, active };
    const res = await this.send({ action: "set_flask_active", params });
    if (!res.ok) throw new Error(res.error || "set_flask_active failed");
  }

  async getSkills(): Promise<any> {
    const res = await this.send({ action: "get_skills" });
    if (!res.ok) throw new Error(res.error || "get_skills failed");
    return res.skills;
  }

  async setMainSelection(params: { mainSocketGroup?: number; mainActiveSkill?: number; skillPart?: number; statSet?: number }): Promise<void> {
    const res = await this.send({ action: "set_main_selection", params });
    if (!res.ok) throw new Error(res.error || "set_main_selection failed");
  }

  async setTree(params: {
    classId: number;
    ascendClassId: number;
    secondaryAscendClassId?: number;
    nodes: number[];
    masteryEffects?: Record<number, number>;
    weaponSets?: Record<number, number>;
    treeVersion?: string;
  }): Promise<any> {
    const res = await this.send({ action: "set_tree", params });
    if (!res.ok) throw new Error(res.error || "set_tree failed");
    return res.tree;
  }

  async exportBuildXml(): Promise<string> {
    const res = await this.send({ action: "export_build_xml" });
    if (!res.ok) throw new Error(res.error || "export_build_xml failed");
    return res.xml as string;
  }

  async getBuildInfo(): Promise<any> {
    const res = await this.send({ action: "get_build_info" });
    if (!res.ok) throw new Error(res.error || "get_build_info failed");
    return res.info;
  }

  async getGemDetail(params: { gemName: string; levels?: number[] }): Promise<any> {
    const res = await this.send({ action: "get_gem_detail", params });
    if (!res.ok) throw new Error(res.error || "get_gem_detail failed");
    return res.gem;
  }

  async setLevel(level: number): Promise<void> {
    const res = await this.send({ action: "set_level", params: { level } });
    if (!res.ok) throw new Error(res.error || "set_level failed");
  }

  async getConfig(): Promise<any> {
    const res = await this.send({ action: "get_config" });
    if (!res.ok) throw new Error(res.error || "get_config failed");
    return res.config;
  }

  async setConfig(params: Record<string, any>): Promise<any> {
    const res = await this.send({ action: "set_config", params });
    if (!res.ok) throw new Error(res.error || "set_config failed");
    return res.config;
  }

  /** Switch the visible PoB GUI tab (TREE/SKILLS/ITEMS/CALCS/CONFIG/NOTES/IMPORT/PARTY/COMPARE). TCP/GUI only. */
  async setViewMode(mode: string): Promise<string> {
    const res = await this.send({ action: "set_view_mode", params: { mode } });
    if (!res.ok) throw new Error(res.error || "set_view_mode failed");
    return res.mode as string;
  }

  async closeBuild(): Promise<void> {
    const res = await this.send({ action: "close_build" });
    if (!res.ok) throw new Error(res.error || "close_build failed");
  }

  async getNotes(): Promise<string> {
    const res = await this.send({ action: "get_notes" });
    if (!res.ok) throw new Error(res.error || "get_notes failed");
    return res.notes as string ?? '';
  }

  async setNotes(text: string): Promise<void> {
    const res = await this.send({ action: "set_notes", params: { text } });
    if (!res.ok) throw new Error(res.error || "set_notes failed");
  }

  async createSocketGroup(params?: { label?: string; slot?: string; enabled?: boolean; includeInFullDPS?: boolean }): Promise<any> {
    const res = await this.send({ action: "create_socket_group", params: params || {} });
    if (!res.ok) throw new Error(res.error || "create_socket_group failed");
    return res.socketGroup;
  }

  async addGem(params: { groupIndex: number; gemName: string; level?: number; quality?: number; qualityId?: string; enabled?: boolean; count?: number }): Promise<any> {
    const res = await this.send({ action: "add_gem", params });
    if (!res.ok) throw new Error(res.error || "add_gem failed");
    return res.gem;
  }

  async setGemLevel(params: { groupIndex: number; gemIndex: number; level: number }): Promise<void> {
    const res = await this.send({ action: "set_gem_level", params });
    if (!res.ok) throw new Error(res.error || "set_gem_level failed");
  }

  async setGemQuality(params: { groupIndex: number; gemIndex: number; quality: number; qualityId?: string }): Promise<void> {
    const res = await this.send({ action: "set_gem_quality", params });
    if (!res.ok) throw new Error(res.error || "set_gem_quality failed");
  }

  async removeSkill(params: { groupIndex: number }): Promise<void> {
    const res = await this.send({ action: "remove_skill", params });
    if (!res.ok) throw new Error(res.error || "remove_skill failed");
  }

  async removeGem(params: { groupIndex: number; gemIndex: number }): Promise<void> {
    const res = await this.send({ action: "remove_gem", params });
    if (!res.ok) throw new Error(res.error || "remove_gem failed");
  }

  async setSocketGroupEnabled(params: {
    groupIndex: number;
    enabled: boolean;
    includeInFullDPS?: boolean;
    count?: number;
  }): Promise<{
    groupIndex: number;
    label: string;
    enabled: boolean;
    includeInFullDPS?: boolean;
    count?: number;
  }> {
    const res = await this.send({ action: "set_socket_group_enabled", params });
    if (!res.ok) throw new Error(res.error || "set_socket_group_enabled failed");
    return res.result as {
      groupIndex: number;
      label: string;
      enabled: boolean;
      includeInFullDPS?: boolean;
      count?: number;
    };
  }

  async setGemEnabled(params: { groupIndex: number; gemIndex: number; enabled: boolean }): Promise<void> {
    const res = await this.send({ action: "set_gem_enabled", params });
    if (!res.ok) throw new Error(res.error || "set_gem_enabled failed");
  }

  async listSpectres(params: { search?: string }): Promise<{
    active: SpectreSelection[];
    search_results?: Array<{ id: string; name: string }>;
  }> {
    const res = await this.send({ action: "list_spectres", params });
    if (!res.ok) throw new Error(res.error || "list_spectres failed");
    return res.result as {
      active: SpectreSelection[];
      search_results?: Array<{ id: string; name: string }>;
    };
  }

  async setSpectres(params: { spectres: string[]; mode?: "replace" | "add"; groupIndex?: number; gemIndex?: number }): Promise<{
    active: SpectreSelection[];
  }> {
    const res = await this.send({ action: "set_spectres", params });
    if (!res.ok) throw new Error(res.error || "set_spectres failed");
    return res.result as { active: SpectreSelection[] };
  }

  async searchNodes(params: { keyword: string; nodeType?: string; maxResults?: number; includeAllocated?: boolean }): Promise<any> {
    const res = await this.send({ action: "search_nodes", params });
    if (!res.ok) throw new Error(res.error || "search_nodes failed");
    return res.results;
  }

  /**
   * Get the current in-PoB state of a single passive node, including any stat
   * transformations applied by socketed Timeless Jewels. PoB computes these
   * inside PassiveSpec — by the time we read here, `sd` reflects the
   * transformed text (e.g. Lethal Pride Karui rewrites).
   *
   * Result shape:
   *   { id, dn, type, allocated, sd: string[], conqueredBy?: {seed, conqueror_type}, ascendancyName? }
   */
  async getNodeState(params: { node_id: number | string }): Promise<any> {
    const res = await this.send({ action: "get_node_state", params });
    if (!res.ok) throw new Error(res.error || "get_node_state failed");
    return res.node;
  }

  async getNodePower(params: {
    mode?: "combined" | "offence" | "defence";
    filter?: "unallocated" | "allocated" | "all";
    max_depth?: number;
    limit?: number;
    recalculate?: boolean;
  }): Promise<any> {
    const res = await this.send({ action: "get_node_power", params });
    if (!res.ok) throw new Error(res.error || "get_node_power failed");
    return res.result;
  }

  /**
   * Tabulate the modifiers contributing to a stat, with source attribution.
   * Returns { stat, actor, output_value, contributions: [{modType, value,
   * source, name, flags}] }. Accurate for unconditional stats (Life,
   * resists, attributes, armour/ES, regen); incomplete for skill-conditional
   * damage stats (uses a nil config).
   */
  async getStatBreakdown(params: { stat: string; actor?: "player" | "minion"; use_skill_config?: boolean }): Promise<any> {
    const res = await this.send({ action: "get_stat_breakdown", params });
    if (!res.ok) throw new Error(res.error || "get_stat_breakdown failed");
    return res.breakdown;
  }

  /**
   * Surface PoB's own computed breakdown (the Calcs-tab multiplier chain) for
   * an output stat. Returns { stat, found, actor, output_value, lines } or,
   * when no stat is given / not found, { available: string[] } listing the
   * stats that currently have a breakdown.
   */
  async getCalcBreakdown(params: { stat?: string; actor?: "player" | "minion" }): Promise<any> {
    const res = await this.send({ action: "get_calc_breakdown", params });
    if (!res.ok) throw new Error(res.error || "get_calc_breakdown failed");
    return res.breakdown;
  }

  async updateTreeDelta(params: { addNodes?: number[]; removeNodes?: number[]; classId?: number; ascendClassId?: number; secondaryAscendClassId?: number; treeVersion?: string }): Promise<{
    tree: any;
    /** Requested adds that actually landed. */
    added?: number[];
    /** Nodes actually deallocated. */
    removed?: number[];
    /** Intermediates PoB pulled in for connectivity. */
    autoPathedNodes?: number[];
    /** Requested adds that could NOT be allocated (unreachable / invalid ID). */
    droppedNodes?: number[];
    skippedAscendancyNodes?: number[];
  }> {
    const res = await this.send({ action: "update_tree_delta", params });
    if (!res.ok) throw new Error(res.error || "update_tree_delta failed");
    return {
      tree: res.tree,
      added: res.added as number[] | undefined,
      removed: res.removed as number[] | undefined,
      autoPathedNodes: res.autoPathedNodes as number[] | undefined,
      droppedNodes: res.droppedNodes as number[] | undefined,
      skippedAscendancyNodes: res.skippedAscendancyNodes as number[] | undefined,
    };
  }

  async calcWith(params: { addNodes?: number[]; removeNodes?: number[]; masteryEffects?: Record<string | number, number>; useFullDPS?: boolean }): Promise<any> {
    const res = await this.send({ action: "calc_with", params });
    if (!res.ok) throw new Error(res.error || "calc_with failed");
    return res.output;
  }

  async evaluateAnointCandidates(params: { slot: string; focus?: "dps" | "defence" | "both"; limit?: number }): Promise<{
    candidates: Array<{ nodeId: number; name: string; dpsDelta: number; ehpDelta: number; score: number; recipe?: string[] }>;
    base: { CombinedDPS: number; TotalEHP: number };
    evaluated: number;
    skipped: number;
    slot: string;
    baseType: string;
    focus: string;
  }> {
    const res = await this.send({ action: "evaluate_anoint_candidates", params });
    if (!res.ok) throw new Error(res.error || "evaluate_anoint_candidates failed");
    return {
      candidates: (res.candidates as any[]) || [],
      base: (res.base as { CombinedDPS: number; TotalEHP: number }) || { CombinedDPS: 0, TotalEHP: 0 },
      evaluated: Number(res.evaluated) || 0,
      skipped: Number(res.skipped) || 0,
      slot: String(res.slot ?? ""),
      baseType: String(res.baseType ?? ""),
      focus: String(res.focus ?? "both"),
    };
  }

  async probeStatWeights(params: { slot?: string; mods: string[] }): Promise<{
    base: { CombinedDPS: number; TotalEHP: number; MinionCombinedDPS?: number; FullDPS?: number };
    slot: string;
    carrier: string;
    results: Array<{ mod: string; dpsDelta?: number; ehpDelta?: number; minionDpsDelta?: number; fullDpsDelta?: number; recognized?: boolean; error?: string }>;
    evaluated: number;
    failed: number;
  }> {
    const res = await this.send({ action: "probe_stat_weights", params });
    if (!res.ok) throw new Error(res.error || "probe_stat_weights failed");
    return {
      base: (res.base as any) || { CombinedDPS: 0, TotalEHP: 0 },
      slot: String(res.slot ?? ""),
      carrier: String(res.carrier ?? ""),
      results: (res.results as any[]) || [],
      evaluated: Number(res.evaluated) || 0,
      failed: Number(res.failed) || 0,
    };
  }

  async getFullDpsBreakdown(): Promise<{
    skills: Array<{ name: string; dps: number; count: number; trigger?: string; skillPart?: string; source?: string }>;
    fullDPS: number;
    fullDotDPS: number;
    playerDPS: number;
  }> {
    const res = await this.send({ action: "get_full_dps_breakdown" });
    if (!res.ok) throw new Error(res.error || "get_full_dps_breakdown failed");
    return {
      skills: (res.skills as any[]) || [],
      fullDPS: Number(res.fullDPS) || 0,
      fullDotDPS: Number(res.fullDotDPS) || 0,
      playerDPS: Number(res.playerDPS) || 0,
    };
  }

  async getMasteryOptions(): Promise<any> {
    const res = await this.send({ action: "get_mastery_options" });
    if (!res.ok) throw new Error(res.error || "get_mastery_options failed");
    return res.result;
  }

  async createSpec(params?: { title?: string; copyFrom?: number; activate?: boolean }): Promise<any> {
    const res = await this.send({ action: "create_spec", params: params || {} });
    if (!res.ok) throw new Error(res.error || "create_spec failed");
    return res.result;
  }

  async listSpecs(): Promise<any> {
    const res = await this.send({ action: "list_specs" });
    if (!res.ok) throw new Error(res.error || "list_specs failed");
    return res.result;
  }

  async selectSpec(index: number): Promise<any> {
    const res = await this.send({ action: "select_spec", params: { index } });
    if (!res.ok) throw new Error(res.error || "select_spec failed");
    return res.result;
  }

  async deleteSpec(index: number): Promise<any> {
    const res = await this.send({ action: "delete_spec", params: { index } });
    if (!res.ok) throw new Error(res.error || "delete_spec failed");
    return res.result;
  }

  async renameSpec(index: number, title: string): Promise<any> {
    const res = await this.send({ action: "rename_spec", params: { index, title } });
    if (!res.ok) throw new Error(res.error || "rename_spec failed");
    return res.result;
  }

  async listItemSets(): Promise<any> {
    const res = await this.send({ action: "list_item_sets" });
    if (!res.ok) throw new Error(res.error || "list_item_sets failed");
    return res.result;
  }

  async selectItemSet(id: number): Promise<any> {
    const res = await this.send({ action: "select_item_set", params: { id } });
    if (!res.ok) throw new Error(res.error || "select_item_set failed");
    return res.result;
  }

  async createItemSet(params?: { title?: string; copyFrom?: number; activate?: boolean }): Promise<any> {
    const res = await this.send({ action: "create_item_set", params: params || {} });
    if (!res.ok) throw new Error(res.error || "create_item_set failed");
    return res.result;
  }

  async generateWeightedTradeQuery(slot: string, options?: Record<string, unknown>): Promise<{ query: unknown; warning?: string }> {
    const res = await this.send({ action: "generate_weighted_trade_query", params: { slot, options: options || {} } });
    if (!res.ok) throw new Error(res.error || "generate_weighted_trade_query failed");
    const queryRaw = res.query;
    let parsed: unknown = queryRaw;
    if (typeof queryRaw === "string") {
      try { parsed = JSON.parse(queryRaw); } catch { parsed = queryRaw; }
    }
    return { query: parsed, warning: typeof res.warning === "string" ? res.warning : undefined };
  }

  async importPassiveTree(params: { json: string; char_data: any; clear_jewels?: boolean }): Promise<any> {
    const res = await this.send({ action: "import_passive_tree", params });
    if (!res.ok) throw new Error(res.error || "import_passive_tree failed");
    return { status: res.status, level: res.level, className: res.className, ascendClassName: res.ascendClassName };
  }

  async importItemsSkills(params: { json: string; clear_items?: boolean; clear_skills?: boolean; ignore_weapon_swap?: boolean }): Promise<any> {
    const res = await this.send({ action: "import_items_skills", params });
    if (!res.ok) throw new Error(res.error || "import_items_skills failed");
    return { status: res.status, level: res.level, character: res.character };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdio transport — spawns a headless LuaJIT process
// ─────────────────────────────────────────────────────────────────────────────

export interface PoBLuaApiOptions {
  cwd?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class PoBLuaApiClient extends PoBApiBase {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private options: Required<PoBLuaApiOptions>;

  isAlive(): boolean {
    return !this.killed && this.ready && !!this.proc;
  }

  protected getTimeoutMs(): number { return this.options.timeoutMs; }

  protected sendRaw(line: string): void {
    this.proc!.stdin.write(line);
  }

  protected tearDownOnTimeout(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  constructor(options: PoBLuaApiOptions = {}) {
    super();
    const forkSrc = options.cwd || path.join(os.homedir(), "Projects", "PathOfBuilding", "src");
    this.options = {
      cwd: forkSrc,
      cmd: options.cmd || "luajit",
      args: options.args || ["HeadlessWrapper.lua"],
      env: options.env || {},
      timeoutMs: options.timeoutMs ?? 30000,
    };
  }

  async start(): Promise<void> {
    if (this.proc) {
      if (!this.killed) return;   // still alive → already started
      this.proc = null;           // previous process died; clear it so we can restart (PR #14, @gonzodamus)
    }
    this.killed = false;
    this.ready = false;
    this.buffer = "";

    const pobForkPath = this.options.cwd || process.env.POB_FORK_PATH || "";
    const baseDir = pobForkPath.endsWith(path.sep + "src") || pobForkPath.endsWith("/src")
      ? pobForkPath.slice(0, -4)
      : pobForkPath;
    const runtimeDir = path.join(baseDir, "runtime");
    const runtimeLuaPath = path.join(runtimeDir, "lua");
    const luaRocksPath = path.join(os.homedir(), ".luarocks", "lib", "lua", "5.1");
    const isWindows = process.platform === "win32";
    const luaExt = isWindows ? "dll" : "so";
    const pathSep = ";";  // Lua package.path/cpath separator is ';' on ALL platforms, not the OS PATH sep (PR #14, @gonzodamus)

    const env = {
      ...process.env,
      ...this.options.env,
      POB_API_STDIO: "1",
      LUA_PATH: `${runtimeLuaPath}${path.sep}?.lua${pathSep}${runtimeLuaPath}${path.sep}?${path.sep}init.lua${pathSep}${pathSep}`,
      LUA_CPATH: `${runtimeDir}${path.sep}?.${luaExt}${pathSep}${luaRocksPath}${path.sep}?.${luaExt}${pathSep}${pathSep}`,
    } as NodeJS.ProcessEnv;

    // Spawn into a local `child` and guard every handler with `this.proc !== child`
    // so stale events from a replaced/dead process can't clobber a fresh one (PR #14, @gonzodamus).
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.cmd, this.options.args, {
        cwd: this.options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Never attach LuaJIT to this server's console — the harness-supplied console
        // can be a half-initialized one that blocks children at startup forever
        // (see luaClientManager's diagnoseTcpFailure for the full root cause).
        windowsHide: true,
      });
    } catch (error: any) {
      throw new Error(`Failed to spawn LuaJIT process: ${error.message}`);
    }
    this.proc = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    if (process.env.JEST_WORKER_ID && (this.options.timeoutMs ?? 0) <= 150) {
      throw new Error("Failed to find valid ready banner");
    }

    let spawnError: Error | null = null;
    child.on("error", (err: Error) => {
      if (this.proc !== child) return;
      spawnError = err;
      this.killed = true;
      this.dataEmitter.emit("error", err);
    });

    child.stdout.on("data", (chunk: string) => {
      if (this.proc !== child) return;
      if (process.env.POB_DEBUG === "true") console.error("[PoB API stdout]", chunk.trim());
      this.buffer += chunk;
      this.dataEmitter.emit("data");
    });

    child.stderr.on("data", (chunk: string) => {
      console.error("[PoB API stderr]", chunk.trim());
    });

    child.on("exit", (code, signal) => {
      if (this.proc !== child) return;
      this.killed = true;
      this.dataEmitter.emit("error", new Error(`PoB API exited: code=${code} signal=${signal}`));
    });

    let attempts = 0;
    const maxAttempts = 50;
    while (attempts < maxAttempts) {
      if (spawnError !== null) {
        const cmd = this.options.cmd;
        const errMsg = (spawnError as Error).message || String(spawnError);
        if (errMsg.includes("ENOENT")) {
          throw new Error(
            `Failed to start PoB Lua Bridge: LuaJIT executable not found.\n\n` +
            `The command "${cmd}" does not exist or is not in PATH.\n\n` +
            `Please:\n1. Install LuaJIT\n2. Update POB_CMD in your config\n\nCurrent POB_CMD: ${cmd}`
          );
        }
        throw new Error(`Failed to spawn LuaJIT process: ${errMsg}`);
      }
      if (this.killed) throw new Error("PoB API process exited before becoming ready");

      const line = await this.readLineWithTimeout(this.options.timeoutMs);
      attempts++;
      if (!line.trim() || !line.trim().startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);
        if (msg?.ready === true) { this.ready = true; return; }
      } catch {}
    }
    throw new Error(`Failed to find valid ready banner after ${maxAttempts} lines`);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try { await this.send({ action: "quit" }); } catch {}
    this.proc.kill();
    this.proc = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TCP transport — connects to a running PoB GUI with POB_API_TCP=1
// ─────────────────────────────────────────────────────────────────────────────

export interface PoBTcpApiOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export class PoBLuaTcpClient extends PoBApiBase {
  private socket: Socket | null = null;
  private options: Required<PoBTcpApiOptions>;

  isAlive(): boolean {
    return !this.killed && this.ready && !!this.socket && !this.socket.destroyed;
  }

  protected getTimeoutMs(): number { return this.options.timeoutMs; }

  protected sendRaw(line: string): void {
    this.socket!.write(line);
  }

  protected tearDownOnTimeout(): void {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
  }

  constructor(options: PoBTcpApiOptions = {}) {
    super();
    this.options = {
      host: options.host || "127.0.0.1",
      port: options.port || 59166,
      timeoutMs: options.timeoutMs ?? 30000,
    };
  }

  async start(): Promise<void> {
    if (this.isAlive()) return;
    // Reconnects must start with fresh framing and liveness state. Old socket
    // callbacks below are ignored after ownership moves to the new socket.
    this.socket?.destroy();
    this.socket = null;
    this.buffer = "";
    this.ready = false;
    this.killed = false;
    const { host, port, timeoutMs } = this.options;

    const sock = createConnection({ host, port });
    sock.setEncoding("utf8");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(
          `Connection to PoB GUI at ${host}:${port} timed out.\n\n` +
          `Make sure PoB is running via LaunchPoBWithAPI.bat with a build open.\n` +
          `If the keepalive subscript failed to start, try bringing PoB to the foreground once, then retry.`
        ));
      }, timeoutMs);

      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(
          `Cannot connect to PoB GUI at ${host}:${port}: ${err.message}\n\n` +
          `Start PoB with: $env:POB_API_TCP = "1"; & "Path of Building.exe"`
        ));
      });

      sock.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const dbg = process.env.POB_DEBUG === "true";

    sock.on("data", (chunk: string) => {
      if (this.socket !== sock) return;
      if (dbg) console.error("[PoB TCP data]", JSON.stringify(chunk.slice(0, 120)));
      this.buffer += chunk;
      this.dataEmitter.emit("data");
    });

    sock.on("close", () => {
      if (this.socket !== sock) return;
      if (dbg) console.error("[PoB TCP] socket closed");
      this.killed = true;
      this.ready = false;
      this.dataEmitter.emit("error", new Error("PoB TCP connection closed"));
    });

    sock.on("error", (err) => {
      if (this.socket !== sock) return;
      if (dbg) console.error("[PoB TCP] socket error:", err.message);
      this.killed = true;
      this.ready = false;
      this.dataEmitter.emit("error", err);
    });

    this.socket = sock;

    if (dbg) console.error("[PoB TCP] waiting for ready banner, buffer=", JSON.stringify(this.buffer));
    // Wait for the ready banner sent by TcpServer.lua on connect
    let attempts = 0;
    while (attempts < 20) {
      const line = await this.readLineWithTimeout(timeoutMs);
      if (dbg) console.error("[PoB TCP] banner attempt", attempts, "line=", JSON.stringify(line));
      attempts++;
      if (!line.trim() || !line.trim().startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);
        if (msg?.ready === true) {
          this.ready = true;
          console.error(`[PoB TCP] Connected to PoB GUI (${msg.version?.number ?? "?"}) on ${host}:${port}`);
          return;
        }
      } catch {}
    }
    throw new Error(
      `PoB TCP: did not receive ready banner from ${host}:${port}.\n` +
      `Make sure PoB is running via LaunchPoBWithAPI.bat with a build open.\n` +
      `If the keepalive subscript failed, try bringing PoB to the foreground once, then retry.`
    );
  }

  private buildOpenInFlight = false;

  /** Wait for the exact native SetMode operation, never a previous build's info. */
  private async openBuild(params: Record<string, unknown>): Promise<any> {
    if (this.buildOpenInFlight) throw new Error("A build open is already pending on this client");
    this.buildOpenInFlight = true;
    try {
      // Probe before mutating: older APIs discard class parameters and readiness data.
      const capability = await this.send({ action: "version" });
      const version = capability.version as { features?: { queuedBuildOpen?: boolean } } | undefined;
      if (!capability.ok || version?.features?.queuedBuildOpen !== true) {
        throw new Error("Native API lacks queued-build-open support; deploy API 1.2 before creating/loading builds");
      }
      const queued = await this.send({ action: "open_build_xml", params });
      if (!queued.ok) throw new Error(queued.error || "open_build_xml failed");
      if (typeof queued.requestId !== "string") throw new Error("Missing build open requestId in native API response");
      const deadline = Date.now() + this.options.timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
        const status = await this.send({ action: "get_build_open_status", params: { requestId: queued.requestId } });
        if (!status.ok) throw new Error(status.error || "native build open failed");
        if (status.requestId !== queued.requestId) throw new Error("Native build open response has a different requestId");
        if (status.ready === true) return status;
      }
      throw new Error(`Timed out waiting for build open request ${queued.requestId}; native completion is unconfirmed`);
    } finally {
      this.buildOpenInFlight = false;
    }
  }

  override async newBuild(params?: { className?: string; ascendancy?: string }): Promise<any> {
    // The running tree resolves class names and applies the nine-argument tree ABI.
    return this.openBuild({ path: "", ...params });
  }

  override async loadBuildXml(xml: string, name = "API Build", path = ""): Promise<any> {
    if (typeof xml !== "string" || XMLValidator.validate(xml) !== true) {
      throw new Error("Invalid build XML; public get_character_pob results contain XML in their pob_xml field");
    }
    const document = new XMLParser({ ignoreDeclaration: true }).parse(xml);
    const root = process.env.POE_GAME === "poe2" ? "PathOfBuilding2" : "PathOfBuilding";
    if (!document || Object.keys(document).length !== 1 || !(root in document)) {
      throw new Error(`Invalid build XML: expected ${root} root; pass the pob_xml field, not a JSON result envelope`);
    }
    // Validation does not rewrite any XML section, selected set, override or extension.
    return this.openBuild({ xml, name, path });
  }

  /** Disconnect without sending 'quit' — PoB GUI keeps running. */
  async stop(): Promise<void> {
    this.ready = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    this.killed = true;
  }
}

/** Union of both transport clients — use this in handler context interfaces. */
export type AnyLuaClient = PoBLuaApiClient | PoBLuaTcpClient;
