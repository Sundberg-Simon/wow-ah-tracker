import { parseArgs } from "node:util";
import { blizzardGet } from "../src/blizzard-api/client.js";
import { openCraftingDb } from "../src/crafting/db.js";
import { fetchItemName, searchItemsByName, type StaticGet } from "../src/crafting/itemLookup.js";
import { describeItem, listItems, resolveItem, setItemName } from "../src/crafting/items.js";
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
        ( --output <item>:<n>[/<d>] [--output ...]  |  --from-prospecting <ore> [--patch <tag>] ) [--source "<text>"]
  npm run crafting -- op list
  npm run crafting -- op show <id|name>
  npm run crafting -- op remove <id>

A batch is a COMPLETE record: list every output item you got. Anything you leave
out counts as 0 for that batch's ore, which lowers its yield.
--count is the total ore consumed (e.g. 100000), not the number of casts.
--output is EXPECTED units per execution (1/5 = a 1-in-5 proc); --from-prospecting instead
derives the outputs from your recorded batches of that ore (which must be an --input).
--date defaults to today. Names must be registered with "item add"; an ambiguous
name (same name, several ids) is refused - use the id.`;

// Blizzard static-namespace GET via the sync pipeline's OAuth client (only touched by item find/fetch).
const staticGet: StaticGet = (path, params) => blizzardGet(path, { namespace: "static", params });

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
      help: { type: "boolean", short: "h" },
    },
  });
  const [group, action, ...rest] = positionals;
  if (values.help || !group) {
    console.log(USAGE);
    return;
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
    } else {
      console.error(USAGE);
      process.exitCode = 1;
    }
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
