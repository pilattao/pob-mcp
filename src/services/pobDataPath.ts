/** Shared data-root selection for the base, item-mod and craft loaders. */
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import luaparse from "luaparse";

export interface PobDataLocation {
  dataDir: string;
  game: "poe1" | "poe2";
}

function searchUpwardForSuite(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pob-mcp", "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveSuiteRoot(): string {
  if (process.env.POE_MCP_SUITE_ROOT) return process.env.POE_MCP_SUITE_ROOT;
  const entry = process.argv[1];
  return (entry && searchUpwardForSuite(dirname(entry))) ||
    searchUpwardForSuite(process.cwd()) || process.cwd();
}

/**
 * POB_INSTALL_DIR selects either a packaged install (Data/) or a source
 * checkout (src/Data/). It takes precedence over the legacy suite override.
 * Choose ONE root for all files; a missing file must never be borrowed from
 * another installation or layout. Packaged Data wins if both layouts exist.
 *
 * PoE2 mode requires GameVersions.lua to identify PoB2, including when using
 * the default suite checkout. A PoE1 or unverifiable checkout is an error,
 * never a fallback. With no POE_GAME, native game metadata selects the format;
 * older PoE1 data-only fixtures remain supported without game metadata.
 */
export function resolvePobDataLocation(): PobDataLocation {
  const root = resolve(process.env.POB_INSTALL_DIR || process.env.POE_MCP_SUITE_POB_DIR ||
    join(resolveSuiteRoot(), "PathOfBuilding"));
  const dataDir = [join(root, "Data"), join(root, "src", "Data")]
    .find(candidate => existsSync(candidate) && statSync(candidate).isDirectory());
  if (!dataDir) {
    throw new Error(`PoB data directory not found in ${root}. Set POB_INSTALL_DIR to a PoB install or source checkout; no other installation will be used.`);
  }

  const gameFile = join(dirname(dataDir), "GameVersions.lua");
  let detectedGame: PobDataLocation["game"] | undefined;
  if (existsSync(gameFile)) {
    // Parse the assignment without executing Lua or matching commented text.
    const ast = luaparse.parse(readFileSync(gameFile, "utf-8"), {
      comments: false, encodingMode: "x-user-defined",
    });
    for (const stmt of ast.body) {
      if (stmt.type !== "AssignmentStatement") continue;
      stmt.variables.forEach((variable, index) => {
        const value = stmt.init[index];
        if (variable.type !== "Identifier" || variable.name !== "liveTargetVersion" ||
          value?.type !== "StringLiteral") return;
        if (/^0_\d+$/.test(value.value ?? "")) detectedGame = "poe2";
        else if (/^3_\d+$/.test(value.value ?? "")) detectedGame = "poe1";
      });
    }
  }

  if (process.env.POE_GAME === "poe2" && detectedGame !== "poe2") {
    throw new Error(`Cannot verify PoE2 data in ${dataDir} using ${gameFile}. PoE1 fallback is disabled; set POB_INSTALL_DIR to a PoB2 install or source checkout.`);
  }
  if (process.env.POE_GAME === "poe1" && detectedGame === "poe2") {
    throw new Error(`POE_GAME=poe1 conflicts with PoE2 data in ${dataDir}. Set POB_INSTALL_DIR to the intended game.`);
  }
  return { dataDir, game: detectedGame ?? "poe1" };
}
