import type { DatabaseSync } from "node:sqlite";
import { describeItem, resolveItem } from "./items.js";
import { fractionToNumber } from "./fraction.js";
import { expectedOutputs, type BatchOutput, type ObservedYields } from "./prospecting.js";
import { ValidationError } from "./validate.js";

/** Whole number typed by a human; commas/underscores/spaces as thousands separators are fine ("100,000"). */
export function parseCount(label: string, raw: string): number {
  const cleaned = raw.replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(cleaned)) throw new ValidationError(`${label} must be a whole number, got "${raw}"`);
  return Number(cleaned);
}

/** "<item id or name>:<quantity>", split on the LAST colon so names may contain one. */
export function parseOutputSpec(db: DatabaseSync, spec: string, flag = "--gem"): BatchOutput {
  const cut = spec.lastIndexOf(":");
  if (cut <= 0) throw new ValidationError(`${flag} "${spec}" must look like <item id or name>:<quantity>`);
  return {
    itemId: resolveItem(db, spec.slice(0, cut)),
    quantity: parseCount(`quantity in ${flag} "${spec}"`, spec.slice(cut + 1)),
  };
}

/** Human-readable yield table with the sample size up front, so no rate is shown without its evidence. */
export function formatYields(db: DatabaseSync, observed: ObservedYields, perOre: number): string {
  const { sample } = observed;
  const scope = [
    observed.filter.patch ? `patch ${observed.filter.patch}` : "all patches",
    observed.filter.from || observed.filter.to
      ? `${observed.filter.from ?? "..."} to ${observed.filter.to ?? "..."}`
      : "all dates",
  ].join(", ");
  const lines = [`Ore: ${describeItem(db, observed.oreItemId)}  (${scope})`];

  if (sample.batchCount === 0) {
    lines.push("No matching batches - nothing to compute a yield from.");
    return lines.join("\n");
  }

  lines.push(
    `Sample: ${sample.oreCount.toLocaleString("en-US")} ore in ${sample.batchCount} batch(es), ` +
      `${sample.firstDate} .. ${sample.lastDate}`,
  );
  const expected = new Map(expectedOutputs(observed, perOre).map((e) => [e.itemId, e.expected]));
  const rows = observed.yields.map((y) => ({
    item: describeItem(db, y.itemId),
    qty: y.quantity.toLocaleString("en-US"),
    rate: fractionToNumber(y.perOre).toFixed(6),
    exp: fractionToNumber(expected.get(y.itemId)!).toFixed(3),
  }));
  const w = {
    item: Math.max(4, ...rows.map((r) => r.item.length)),
    qty: Math.max(8, ...rows.map((r) => r.qty.length)),
    rate: Math.max(8, ...rows.map((r) => r.rate.length)),
    exp: Math.max(`per ${perOre} ore`.length, ...rows.map((r) => r.exp.length)),
  };
  lines.push(
    `${"Item".padEnd(w.item)}  ${"Observed".padStart(w.qty)}  ${"Per ore".padStart(w.rate)}  ${`per ${perOre} ore`.padStart(w.exp)}`,
  );
  for (const r of rows) {
    lines.push(
      `${r.item.padEnd(w.item)}  ${r.qty.padStart(w.qty)}  ${r.rate.padStart(w.rate)}  ${r.exp.padStart(w.exp)}`,
    );
  }
  return lines.join("\n");
}
