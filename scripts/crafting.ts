import { parseArgs } from "node:util";
import { openCraftingDb } from "../src/crafting/db.js";
import { describeItem, listItems, resolveItem, setItemName } from "../src/crafting/items.js";
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

  npm run crafting -- prospect add --ore <id|name> --count <ore consumed> \\
        --gem <id|name>:<qty> [--gem ...] [--date YYYY-MM-DD] [--patch <tag>] [--note "<text>"]
  npm run crafting -- prospect list [--ore <id|name>]
  npm run crafting -- prospect remove <batch id>
  npm run crafting -- prospect yields --ore <id|name> [--patch <tag>] [--from <date>] [--to <date>] [--per <ore>]

A batch is a COMPLETE record: list every output item you got. Anything you leave
out counts as 0 for that batch's ore, which lowers its yield.
--count is the total ore consumed (e.g. 100000), not the number of casts.
--date defaults to today. Names must be registered with "item add"; an ambiguous
name (same name, several ids) is refused - use the id.`;

function main(): void {
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

main();
