/**
 * Runs the addon's Lua tests (tests/addon/*.test.lua) - `npm run test:addon`.
 *
 * Each file gets a fresh Lua engine (wasmoon, a dev-only dependency) and a
 * global `addonSource(name)` that returns the source of
 * addon/WowAHTracker/<name>, so a test loads the REAL addon file against its own
 * stubbed WoW API. A test reports through print(): any line starting with
 * "FAIL" or an uncaught error fails the run; the last line is "N passed, M failed".
 *
 * Caveat: wasmoon is Lua 5.4, the game is Lua 5.1. The addon code avoids
 * anything that differs between them (no integer division, goto, bit ops), but
 * these tests prove logic, not that the game accepts every API name - in-game
 * testing is still the last word (CLAUDE.md "Obligatoriskt sista steg").
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LuaFactory } from "wasmoon";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "addon");
const addonDir = path.join(root, "addon", "WowAHTracker");

async function runFile(file: string): Promise<{ ok: boolean; lines: string[] }> {
  const lua = await new LuaFactory().createEngine();
  const lines: string[] = [];
  try {
    lua.global.set("addonSource", (name: string) => {
      if (!/^[\w.-]+\.lua$/.test(name)) throw new Error(`addonSource: bad file name ${name}`);
      return readFileSync(path.join(addonDir, name), "utf8");
    });
    lua.global.set("print", (...parts: unknown[]) => lines.push(parts.map(String).join("\t")));
    await lua.doString(readFileSync(path.join(testDir, file), "utf8"));
  } catch (err) {
    lines.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lua.global.close();
  }
  const summary = lines[lines.length - 1] ?? "";
  const ok = !lines.some((l) => l.startsWith("FAIL") || l.startsWith("ERROR")) && /^\d+ passed, 0 failed$/.test(summary);
  return { ok, lines };
}

async function main() {
  const files = readdirSync(testDir).filter((f) => f.endsWith(".test.lua")).sort();
  if (files.length === 0) throw new Error(`no *.test.lua files in ${testDir}`);
  let failedFiles = 0;
  for (const file of files) {
    const { ok, lines } = await runFile(file);
    if (!ok) failedFiles++;
    console.log(`${ok ? "ok  " : "FAIL"} ${file}: ${lines[lines.length - 1] ?? "(no output)"}`);
    for (const l of lines.slice(0, -1)) console.log(`     ${l}`);
  }
  console.log(`${files.length - failedFiles}/${files.length} addon test file(s) passed`);
  if (failedFiles > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
