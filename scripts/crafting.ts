import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { blizzardGet } from "../src/blizzard-api/client.js";
import {
  backupConfig,
  createBackup,
  listBackups,
  restoreBackup,
  verifyBackupFile,
  type BackupResult,
} from "../src/crafting/backup.js";
import { craftingDbPath, openCraftingDb } from "../src/crafting/db.js";
import { fetchItemName, searchItemsByName, type StaticGet } from "../src/crafting/itemLookup.js";
import { fetchCommodityDump } from "../src/crafting/blizzardMarket.js";
import { evaluateChain, formatChain } from "../src/crafting/chain.js";
import { getCheapestCost } from "../src/crafting/cheapest.js";
import { chainYieldSensitivity, formatSensitivity } from "../src/crafting/uncertainty.js";
import { formatTrend, snapshotPrices, trendFor, watchedItemIds, TREND_WINDOW_DAYS } from "../src/crafting/history.js";
import { fractionToNumber } from "../src/crafting/fraction.js";
import { formatGold } from "../src/crafting/money.js";
import { formatProcure, procure } from "../src/crafting/procure.js";
import { decide, formatVerdict } from "../src/crafting/verdict.js";
import { DEFAULT_EXECUTIONS } from "../src/crafting/craftingReport.js";
import { describeItem, getItemName, listItems, resolveItem, setItemName } from "../src/crafting/items.js";
import { clearPolicy, getPolicies, POLICIES, setPolicy } from "../src/crafting/policy.js";
import { loadPrices } from "../src/crafting/prices.js";
import { computeEconomics } from "../src/crafting/profit.js";
import { analyzeSourcing } from "../src/crafting/sourcing.js";
import {
  addOperation,
  findOperationId,
  listOperations,
  OPERATION_KINDS,
  removeOperation,
  resolveOperation,
  type OperationKind,
} from "../src/crafting/operations.js";
import { formatOperation, parseFixedOutputSpec, parseInputSpec } from "../src/crafting/operationsCli.js";
import { addOperationRun, listOperationRuns, removeOperationRun } from "../src/crafting/runs.js";
import {
  addProspectingBatch,
  getObservedYields,
  listProspectingBatches,
  removeProspectingBatch,
} from "../src/crafting/prospecting.js";
import { formatYields, parseCount, parseOutputSpec } from "../src/crafting/prospectingCli.js";
import { todayIso, ValidationError } from "../src/crafting/validate.js";

const USAGE = `WoW Crafting Optimizer - local data CLI (data-private/crafting.sqlite, never committed)

  npm run crafting -- item add <id> "<name>"
  npm run crafting -- item list
  npm run crafting -- item find "<text>"          search Blizzard for item ids (needs .env credentials)
  npm run crafting -- item fetch <id> [<id> ...]  register names straight from Blizzard

  npm run crafting -- prospect add --ore <id|name> --count <ore consumed> \\
        --gem <id|name>:<qty> [--gem ...] [--date YYYY-MM-DD] [--patch <tag>] [--note "<text>"]
  npm run crafting -- prospect list [--ore <id|name>]
  npm run crafting -- prospect remove <batch id>
  npm run crafting -- prospect yields --ore <id|name> [--patch <tag>] [--from <date>] [--to <date>] [--per <ore>]

  npm run crafting -- op add --kind ${OPERATION_KINDS.join("|")} --name "<name>" --input <item>:<qty> [--input ...] \\
        ( --output <item>:<n>[/<d>] [--output ...]  |  --from-prospecting <ore> [--patch <tag>]  |  --from-runs [--patch <tag>] ) \\
        [--source "<text>"]
  npm run crafting -- op list
  npm run crafting -- op show <id|name>
  npm run crafting -- op remove <id>          (refused while the operation has logged runs)

  npm run crafting -- run add --op <id|name> --count <times performed> --got <item>:<qty> [--got ...] \\
        [--date YYYY-MM-DD] [--patch <tag>] [--note "<text>"]
  npm run crafting -- run list [--op <id|name>]
  npm run crafting -- run remove <run id>

  npm run crafting -- policy set <${POLICIES.join("|")}> <item> [<item> ...]
  npm run crafting -- policy list
  npm run crafting -- policy clear <item> [<item> ...]
  npm run crafting -- worth <item> [--units N]           "is it worth crafting?" yes/no by how much, what would flip it, and - only
                                                         if yes - the same question for each input ("and how?"). Default 100 units.
  npm run crafting -- cheapest <item> [--units N] [--executions N]   cheapest way to end up with N of it (default 100): buy it or
                                                         make it, and every input bought or made the same way, all the way down.
                                                         --executions sizes prospecting-type routes (default 600), shown for information
  npm run crafting -- chain [--ore N] [--root <op>]      buy N of the root operation's input (default 3000), run it, then
                                                         every other operation on what you hold: what does it cost vs buying the result?

  npm run crafting -- prices snapshot                 fetch and record the current prices of every item the operations use or
                                                         make (what the hourly scheduled task runs; see Snapshot-Prices.ps1)
  npm run crafting -- prices trend [<item>]           is the price cheap, typical or dear next to the last 7 days? (default: every
                                                         watched item; needs ~a day of hourly snapshots before it says more than "collecting")

  npm run crafting -- backup create                   snapshot + verify (also runs automatically after every change)
  npm run crafting -- backup list
  npm run crafting -- backup verify [<name|path>]     default: the newest backup
  npm run crafting -- backup restore <name|path> --yes   replace the live DB (the old one is kept aside)

Backups: data-private/backups/, each in its own timestamped file. Everything from the last 24 hours
is kept (so a backup made right after a mistake never overwrites the good one), then the newest per
day for 30 days. Set CRAFTING_BACKUP_EXTRA_DIR in
.env to also copy each backup to another drive or a cloud-synced folder (a same-disk copy can't
survive losing the disk).

A policy says what an item is worth to you when it comes out of an operation as a by-product:
need = you use it in your own crafts (worth what buying that many would cost), sell = worth the
lowest price minus the AH cut, ignore = worth nothing. No policy = unknown (never guessed).

A batch is a COMPLETE record: list every output item you got. Anything you leave
out counts as 0 for that batch's ore, which lowers its yield.
--count is the total ore consumed (e.g. 100000), not the number of casts.
--output is EXPECTED units per execution (1/5 = a 1-in-5 proc); --from-prospecting instead
derives the outputs from your recorded batches of that ore (which must be an --input); --from-runs derives
them from runs of THIS operation that you log with "run add" (unknown until you have logged some - a run is a
complete record, so list every item you got, with 0 for a result you did not get).
--date defaults to today. Names must be registered with "item add"; an ambiguous
name (same name, several ids) is refused - use the id.`;

/** Every operation (with what it yields, as far as is known) and current prices for everything involved plus `target`. */
async function loadWorld(db: DatabaseSync, target: number) {
  const operations = listOperations(db).map((o) => resolveOperation(db, o.operationId));
  const ids = new Set<number>([target]);
  for (const op of operations) {
    for (const i of op.inputs) ids.add(i.itemId);
    for (const o of op.outputs) ids.add(o.itemId);
  }
  return { operations, prices: await loadPrices(db, fetchCommodityDump, ids) };
}

// Blizzard static-namespace GET via the sync pipeline's OAuth client (only touched by item find/fetch).
const staticGet: StaticGet = (path, params) => blizzardGet(path, { namespace: "static", params });

// Commands that change the stored data. Each one is followed by an automatic backup: that is the
// moment new, irreplaceable observations exist.
const WRITE_COMMANDS = new Set(["item add", "item fetch", "op add", "op remove", "prospect add", "prospect remove", "policy set", "policy clear", "run add", "run remove"]);

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function printBackup(r: BackupResult): void {
  const counts = Object.entries(r.rowCounts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
  console.log(`Backup: ${r.path} (${kb(r.bytes)}; ${counts || "empty"})`);
  for (const p of r.copiedTo) console.log(`  also copied to ${p}`);
  if (r.pruned.length > 0) console.log(`  removed ${r.pruned.length} old backup(s)`);
  for (const w of r.warnings) console.warn(`  Warning: ${w}`);
}

/** Never fails the command: the change itself is already saved. */
function autoBackup(db: DatabaseSync): void {
  try {
    printBackup(createBackup(db, backupConfig()));
  } catch (err) {
    console.warn(`Warning: your change was saved, but the automatic backup FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A backup given by file name (looked up in the backup folder), by path, or omitted = the newest one. */
function resolveBackupPath(arg: string | undefined): string {
  const config = backupConfig();
  if (!arg) {
    const newest = listBackups(config.dir)[0];
    if (!newest) throw new ValidationError(`no backups found in ${config.dir}`);
    return newest.path;
  }
  if (existsSync(arg)) return arg;
  const inDir = `${config.dir}/${arg}`;
  if (existsSync(inDir)) return inDir;
  throw new ValidationError(`backup not found: ${arg}`);
}

/** The backup commands that must NOT hold the database open (restore replaces the file itself). */
function runBackupCommand(action: string | undefined, rest: string[], yes: boolean): boolean {
  const config = backupConfig();
  if (action === "list") {
    for (const [label, dir] of [["Backups in", config.dir], ["Extra copies in", config.extraDir]] as const) {
      if (!dir) continue;
      const files = listBackups(dir);
      console.log(`${label} ${dir}: ${files.length === 0 ? "none" : ""}`);
      for (const f of files) console.log(`  ${f.name}  ${kb(f.bytes).padStart(9)}  ${f.modified.toLocaleString("sv-SE")}`);
    }
    return true;
  }
  if (action === "verify") {
    const path = resolveBackupPath(rest[0]);
    const v = verifyBackupFile(path);
    console.log(`${v.ok ? "OK" : "FAILED"}: ${path}`);
    if (v.ok) console.log(`  schema v${v.userVersion}; ${Object.entries(v.rowCounts).map(([t, n]) => `${t} ${n}`).join(", ")}`);
    for (const p of v.problems) console.error(`  ${p}`);
    if (!v.ok) process.exitCode = 1;
    return true;
  }
  if (action === "restore") {
    const path = resolveBackupPath(rest[0]);
    const target = craftingDbPath();
    if (!yes) {
      console.log(`Would replace ${target} with ${path}.`);
      console.log("The current database is copied aside first. Close anything using it, then run again with --yes.");
      process.exitCode = 1;
      return true;
    }
    const r = restoreBackup(path, target);
    console.log(`Restored ${r.target} from ${r.restoredFrom}.`);
    if (r.safetyCopy) console.log(`The database that was replaced is kept as ${r.safetyCopy}.`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      ore: { type: "string" },
      count: { type: "string" },
      gem: { type: "string", multiple: true },
      date: { type: "string" },
      patch: { type: "string" },
      note: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      per: { type: "string" },
      kind: { type: "string" },
      name: { type: "string" },
      input: { type: "string", multiple: true },
      output: { type: "string", multiple: true },
      "from-prospecting": { type: "string" },
      source: { type: "string" },
      executions: { type: "string" },
      units: { type: "string" },
      op: { type: "string" },
      root: { type: "string" },
      got: { type: "string", multiple: true },
      "from-runs": { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [group, action, ...rest] = positionals;
  if (values.help || !group) {
    console.log(USAGE);
    return;
  }

  if (group === "backup" && action !== "create") {
    try {
      if (runBackupCommand(action, rest, values.yes ?? false)) return;
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const db = openCraftingDb();
  try {
    if (group === "item" && action === "add") {
      const [idRaw, ...nameParts] = rest;
      if (!idRaw || nameParts.length === 0) throw new ValidationError('usage: item add <id> "<name>"');
      const itemId = resolveItem(db, idRaw);
      setItemName(db, itemId, nameParts.join(" "));
      console.log(`Registered ${describeItem(db, itemId)}`);
    } else if (group === "item" && action === "list") {
      for (const i of listItems(db)) console.log(`${String(i.itemId).padStart(8)}  ${i.name}`);
    } else if (group === "item" && action === "find") {
      const text = rest.join(" ");
      if (!text) throw new ValidationError('usage: item find "<text>"');
      const { hits, truncated } = await searchItemsByName(staticGet, text);
      for (const h of hits) {
        console.log(`${String(h.itemId).padStart(8)}  ${h.name}  [${h.itemClass} / ${h.itemSubclass}, level ${h.level}]`);
      }
      if (hits.length === 0) console.log(`No item name contains all of: ${text}`);
      if (truncated) console.log("(Search hit the result limit - results may be incomplete; try a more specific word.)");
    } else if (group === "item" && action === "fetch") {
      if (rest.length === 0) throw new ValidationError("usage: item fetch <id> [<id> ...]");
      for (const raw of rest) {
        const itemId = resolveItem(db, raw);
        setItemName(db, itemId, await fetchItemName(staticGet, itemId));
        console.log(`Registered ${describeItem(db, itemId)}`);
      }
    } else if (group === "op" && action === "add") {
      if (!values.kind || !values.name || !values.input?.length) {
        throw new ValidationError("op add needs --kind, --name and at least one --input");
      }
      const fromOre = values["from-prospecting"];
      const id = addOperation(db, {
        kind: values.kind as OperationKind,
        name: values.name,
        source: values.source,
        inputs: values.input.map((spec) => parseInputSpec(db, spec)),
        outputs: values.output?.map((spec) => parseFixedOutputSpec(db, spec)),
        fromProspecting: fromOre ? { oreItemId: resolveItem(db, fromOre), patch: values.patch } : undefined,
        fromRuns: values["from-runs"] ? { patch: values.patch } : undefined,
      });
      console.log(`Recorded operation #${id}`);
    } else if (group === "op" && action === "list") {
      for (const o of listOperations(db)) console.log(`#${o.operationId}  [${o.kind}]  ${o.name}`);
    } else if (group === "op" && action === "show") {
      const key = rest.join(" ");
      const id = findOperationId(db, /^\d+$/.test(key) ? Number(key) : key);
      if (id === null) throw new ValidationError(`no operation "${key}"`);
      console.log(formatOperation(db, resolveOperation(db, id)));
    } else if (group === "op" && action === "remove") {
      const id = parseCount("operation id", rest[0] ?? "");
      console.log(removeOperation(db, id) ? `Removed operation #${id}` : `No operation #${id}`);
    } else if (group === "prospect" && action === "add") {
      if (!values.ore || !values.count || !values.gem?.length) {
        throw new ValidationError("prospect add needs --ore, --count and at least one --gem");
      }
      const batchId = addProspectingBatch(db, {
        oreItemId: resolveItem(db, values.ore),
        oreCount: parseCount("--count", values.count),
        outputs: values.gem.map((spec) => parseOutputSpec(db, spec)),
        performedOn: values.date ?? todayIso(),
        patch: values.patch,
        note: values.note,
      });
      console.log(`Recorded batch #${batchId}`);
    } else if (group === "prospect" && action === "list") {
      const oreItemId = values.ore ? resolveItem(db, values.ore) : undefined;
      for (const b of listProspectingBatches(db, { oreItemId })) {
        const outs = b.outputs.map((o) => `${describeItem(db, o.itemId)} x${o.quantity}`).join(", ");
        const tags = [b.patch && `patch ${b.patch}`, b.note].filter(Boolean).join("; ");
        console.log(
          `#${b.batchId}  ${b.performedOn}  ${describeItem(db, b.oreItemId)} x${b.oreCount.toLocaleString("en-US")}  ->  ${outs}${tags ? `  [${tags}]` : ""}`,
        );
      }
    } else if (group === "prospect" && action === "remove") {
      const id = parseCount("batch id", rest[0] ?? "");
      console.log(removeProspectingBatch(db, id) ? `Removed batch #${id}` : `No batch #${id}`);
    } else if (group === "prospect" && action === "yields") {
      if (!values.ore) throw new ValidationError("prospect yields needs --ore");
      const observed = getObservedYields(db, resolveItem(db, values.ore), {
        patch: values.patch,
        from: values.from,
        to: values.to,
      });
      console.log(formatYields(db, observed, values.per ? parseCount("--per", values.per) : 100));
    } else if (group === "run" && action === "add") {
      if (!values.op || !values.count || !values.got?.length) {
        throw new ValidationError("run add needs --op, --count and at least one --got");
      }
      const operationId = findOperationId(db, /^\d+$/.test(values.op) ? Number(values.op) : values.op);
      if (operationId === null) throw new ValidationError(`no operation "${values.op}"`);
      const runId = addOperationRun(db, {
        operationId,
        executions: parseCount("--count", values.count),
        outputs: values.got.map((spec) => parseOutputSpec(db, spec, "--got")),
        performedOn: values.date ?? todayIso(),
        patch: values.patch,
        note: values.note,
      });
      console.log(`Recorded run #${runId}`);
    } else if (group === "run" && action === "list") {
      let operationId: number | undefined;
      if (values.op) {
        const found = findOperationId(db, /^\d+$/.test(values.op) ? Number(values.op) : values.op);
        if (found === null) throw new ValidationError(`no operation "${values.op}"`);
        operationId = found;
      }
      for (const r of listOperationRuns(db, { operationId })) {
        const outs = r.outputs.map((o) => `${describeItem(db, o.itemId)} x${o.quantity}`).join(", ");
        const tags = [r.patch && `patch ${r.patch}`, r.note].filter(Boolean).join("; ");
        const opName = listOperations(db).find((o) => o.operationId === r.operationId)?.name ?? `op ${r.operationId}`;
        console.log(`#${r.runId}  ${r.performedOn}  ${opName} x${r.executions.toLocaleString("en-US")}  ->  ${outs}${tags ? `  [${tags}]` : ""}`);
      }
    } else if (group === "run" && action === "remove") {
      const id = parseCount("run id", rest[0] ?? "");
      console.log(removeOperationRun(db, id) ? `Removed run #${id}` : `No run #${id}`);
    } else if (group === "policy" && action === "set") {
      const [policy, ...items] = rest;
      if (!policy || items.length === 0) throw new ValidationError(`usage: policy set <${POLICIES.join("|")}> <item> [<item> ...]`);
      for (const raw of items) {
        const itemId = resolveItem(db, raw);
        setPolicy(db, itemId, policy);
        console.log(`${describeItem(db, itemId)}: ${policy}`);
      }
    } else if (group === "policy" && action === "clear") {
      if (rest.length === 0) throw new ValidationError("usage: policy clear <item> [<item> ...]");
      for (const raw of rest) {
        const itemId = resolveItem(db, raw);
        console.log(clearPolicy(db, itemId) ? `${describeItem(db, itemId)}: policy cleared (unknown)` : `${describeItem(db, itemId)}: had no policy`);
      }
    } else if (group === "policy" && action === "list") {
      const policies = [...getPolicies(db)].sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]);
      if (policies.length === 0) console.log("No policies set.");
      for (const [itemId, policy] of policies) console.log(`${policy.padEnd(7)} ${describeItem(db, itemId)}`);
    } else if (group === "chain") {
      const all = listOperations(db).map((o) => resolveOperation(db, o.operationId));
      let rootId: number | null;
      if (values.root) rootId = findOperationId(db, /^\d+$/.test(values.root) ? Number(values.root) : values.root);
      else rootId = all.find((o) => o.kind === "prospect" && o.outputs.length > 0)?.operationId ?? null;
      if (rootId === null) throw new ValidationError("no root operation: give --root <op>, or record prospecting batches first");
      const root = all.find((o) => o.operationId === rootId)!;
      if (root.inputs.length !== 1) throw new ValidationError(`${root.name} has ${root.inputs.length} inputs; chain --ore needs a root with exactly one`);
      const perExecution = root.inputs[0].quantity;
      const inputUnits = values.ore ? parseCount("--ore", values.ore) : 3000;
      if (inputUnits % perExecution !== 0) throw new ValidationError(`--ore ${inputUnits} is not a multiple of ${perExecution} (what ${root.name} uses per execution)`);
      const others = all.filter((o) => o.operationId !== rootId).sort((a, b) => a.operationId - b.operationId);
      const ids = new Set<number>();
      for (const op of all) {
        for (const i of op.inputs) ids.add(i.itemId);
        for (const o of op.outputs) ids.add(o.itemId);
      }
      const prices = await loadPrices(db, fetchCommodityDump, ids);
      const nameOf = (id: number) => getItemName(db, id) ?? String(id);
      console.log(`Prices: ${prices.source}${prices.observedNewest ? ` (Blizzard dump ${prices.observedNewest})` : ""}. Buying ${inputUnits.toLocaleString("en-US")} x ${nameOf(root.inputs[0].itemId)} = ${inputUnits / perExecution} executions of ${root.name}.`);
      if (prices.error) console.warn(`  ${prices.error}`);
      console.log("");
      const chainArgs = { root, rootExecutions: inputUnits / perExecution, others, books: prices.books, policies: getPolicies(db), nameOf };
      const evaluated = evaluateChain(chainArgs);
      console.log(formatChain(evaluated, nameOf));
      console.log("");
      console.log(formatSensitivity(chainYieldSensitivity(chainArgs), evaluated.saving, nameOf, formatGold).join("\n"));
    } else if (group === "worth") {
      const target = resolveItem(db, [action, ...rest].filter(Boolean).join(" "));
      const wantedUnits = values.units ? parseCount("--units", values.units) : 100;
      const { operations, prices } = await loadWorld(db, target);
      const nameOf = (id: number) => getItemName(db, id) ?? String(id);
      const source = prices.source === "live" ? `live (Blizzard dump ${prices.observedNewest})` : `${prices.source}${prices.observedOldest ? ` (dump ${prices.observedOldest})` : ""}`;
      console.log(`Prices: ${source}.`);
      if (prices.error) console.warn(`  ${prices.error}`);
      console.log("");
      const root = procure({ itemId: target, quantity: wantedUnits, operations, books: prices.books }).root;
      console.log(formatVerdict(decide(root, operations), nameOf));
    } else if (group === "cheapest") {
      const target = resolveItem(db, [action, ...rest].filter(Boolean).join(" "));
      const executions = values.executions ? parseCount("--executions", values.executions) : DEFAULT_EXECUTIONS;
      const { operations, prices } = await loadWorld(db, target);
      const ids = new Set<number>([target]);
      for (const op of operations) {
        for (const i of op.inputs) ids.add(i.itemId);
        for (const o of op.outputs) ids.add(o.itemId);
      }
      const policies = getPolicies(db, ids);
      const wantedUnits = values.units ? parseCount("--units", values.units) : 100;
      const nameOf = (id: number) => getItemName(db, id) ?? String(id);
      const source = prices.source === "live" ? `live (Blizzard dump ${prices.observedNewest})` : `${prices.source}${prices.observedOldest ? ` (dump ${prices.observedOldest})` : ""}`;
      console.log(`Prices: ${source}.`);
      if (prices.error) console.warn(`  ${prices.error}`);
      console.log("");
      // The answer: every input of every way of making the item is itself sourced the cheapest way (buy it or make
      // it), all the way down - so a transmute automatically uses a smelt's cost for its inputs when that is cheaper.
      console.log(`Cheapest way to end up with ${wantedUnits.toLocaleString("en-US")} x ${nameOf(target)}, sourcing every input the cheapest way too:`);
      console.log(formatProcure(procure({ itemId: target, quantity: wantedUnits, operations, books: prices.books }), nameOf));
      // Multi-output routes (prospecting) have no per-item price until you say what the by-products are worth: information only.
      const analyses = operations.map((op) => analyzeSourcing(computeEconomics(op, prices.books, { executions }), prices.books, policies));
      const joint = getCheapestCost({ itemId: target, analyses, books: prices.books, nameOf }).routes.filter((r) => r.joint);
      if (joint.length > 0) {
        console.log("");
        console.log(`Joint-product routes (information only, sized for ${executions} executions; "chain" is the honest whole-chain comparison):`);
        for (const r of joint) {
          const own = r.unitCost === null ? "unknown" : r.unitCost <= 0 ? "free (the by-products more than cover the inputs)" : `${formatGold(r.unitCost)} each`;
          const buy = r.buyUnitCost === null ? "unknown" : `${formatGold(r.buyUnitCost)} each`;
          console.log(`  ${r.strategy} via ${r.via}: ${own}, against ${buy} to buy the same ${fractionToNumber(r.units).toLocaleString("en-US", { maximumFractionDigits: 1 })} units`);
        }
      }
    } else if (group === "prices" && action === "snapshot") {
      const r = await snapshotPrices(db, fetchCommodityDump);
      if (r.source !== "live") {
        console.error(`Price snapshot FAILED: ${r.error ?? "no prices were fetched"}`);
        process.exitCode = 1;
      } else {
        console.log(`Recorded ${r.items} watched item(s) from the Blizzard dump of ${r.observedAt}. History: ${r.historyRows} row(s); full ladders pruned: ${r.laddersPruned}.`);
        if (r.error) console.warn(`  ${r.error}`);
      }
    } else if (group === "prices" && action === "trend") {
      const now = new Date();
      const ids = rest.length > 0 ? [resolveItem(db, rest.join(" "))] : [...watchedItemIds(db)].sort((a, b) => a - b);
      const name = (id: number) => getItemName(db, id) ?? String(id);
      for (const id of ids) console.log(formatTrend(name(id), trendFor(db, id, now), formatGold));
      console.log(`(going price = where the first ~5 units are reached; window ${TREND_WINDOW_DAYS} days)`);
    } else if (group === "backup" && action === "create") {
      printBackup(createBackup(db, backupConfig()));
    } else {
      console.error(USAGE);
      process.exitCode = 1;
    }
    if (WRITE_COMMANDS.has(`${group} ${action}`)) autoBackup(db);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }
}

await main();
