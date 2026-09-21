import type { DatabaseSync } from "node:sqlite";
import { describeItem, resolveItem } from "./items.js";
import { fraction, fractionToNumber } from "./fraction.js";
import type { FixedOutput, ItemQuantity, ResolvedOperation } from "./operations.js";
import { parseCount } from "./prospectingCli.js";
import { ValidationError } from "./validate.js";

function splitSpec(flag: string, spec: string): [string, string] {
  const cut = spec.lastIndexOf(":");
  if (cut <= 0) throw new ValidationError(`${flag} "${spec}" must look like <item id or name>:<quantity>`);
  return [spec.slice(0, cut), spec.slice(cut + 1)];
}

/** --input "<item>:<qty>" */
export function parseInputSpec(db: DatabaseSync, spec: string): ItemQuantity {
  const [item, qty] = splitSpec("--input", spec);
  return { itemId: resolveItem(db, item), quantity: parseCount(`quantity in --input "${spec}"`, qty) };
}

/** --output "<item>:<n>" or "<item>:<n>/<d>" (expected units per execution; 1/5 = a 1-in-5 proc). */
export function parseFixedOutputSpec(db: DatabaseSync, spec: string): FixedOutput {
  const [item, qty] = splitSpec("--output", spec);
  const [n, d = "1", extra] = qty.split("/");
  if (extra !== undefined) throw new ValidationError(`--output "${spec}": quantity must be N or N/D`);
  const num = parseCount(`numerator in --output "${spec}"`, n);
  const den = parseCount(`denominator in --output "${spec}"`, d);
  if (num === 0 || den === 0) throw new ValidationError(`--output "${spec}": numerator and denominator must be > 0`);
  return { itemId: resolveItem(db, item), expected: fraction(num, den) };
}

/** The full "why" for one operation: inputs, the basis of the outputs, and the sample behind them. */
export function formatOperation(db: DatabaseSync, op: ResolvedOperation): string {
  const lines = [`#${op.operationId} ${op.name}  [${op.kind}]`];
  if (op.source) lines.push(`Source: ${op.source}`);
  lines.push("Input (per execution):");
  for (const i of op.inputs) lines.push(`  ${i.quantity} x ${describeItem(db, i.itemId)}`);

  if (op.basis.type === "fixed") {
    lines.push("Output (expected per execution, fixed):");
  } else if (op.basis.type === "empirical") {
    const { sample } = op.basis.observed;
    lines.push(
      `Output (expected per execution, from observed yields of ${describeItem(db, op.basis.oreItemId)}` +
        `${op.basis.patch ? `, patch ${op.basis.patch}` : ""}):`,
    );
    lines.push(
      sample.batchCount === 0
        ? "  Sample: none"
        : `  Sample: ${sample.oreCount.toLocaleString("en-US")} ore in ${sample.batchCount} batch(es), ${sample.firstDate} .. ${sample.lastDate}`,
    );
  } else {
    const { sample } = op.basis.observed;
    lines.push(`Output (expected per execution, from your logged runs${op.basis.patch ? `, patch ${op.basis.patch}` : ""}):`);
    lines.push(
      sample.runCount === 0
        ? "  Sample: none"
        : `  Sample: ${sample.executions.toLocaleString("en-US")} execution(s) in ${sample.runCount} run(s), ${sample.firstDate} .. ${sample.lastDate}`,
    );
  }
  for (const o of op.outputs) {
    const exact = o.expected.den === 1 ? String(o.expected.num) : `${o.expected.num}/${o.expected.den}`;
    lines.push(`  ${describeItem(db, o.itemId)}: ${fractionToNumber(o.expected).toFixed(5)}  (= ${exact})`);
  }
  for (const w of op.warnings) lines.push(`WARNING: ${w}`);
  return lines.join("\n");
}
