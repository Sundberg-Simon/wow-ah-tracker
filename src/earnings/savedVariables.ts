import luaparse from "luaparse";

// Parses a WoW SavedVariables file (a series of `Name = { ... }` global
// assignments, as written by the client) with luaparse rather than a
// hand-rolled parser - this is financial data, and the input is our own
// addon's output, so the point is correctness on edge cases (escapes, negative
// numbers, mixed keys), not defending against hostile input.

type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

function evalExpression(node: luaparse.Expression): LuaValue {
  switch (node.type) {
    case "StringLiteral":
      // pseudo-latin1 mode (see parseSavedVariables): value holds one char per
      // source BYTE, so decode the bytes back to real UTF-8 text here.
      return Buffer.from(node.value as string, "latin1").toString("utf8");
    case "NumericLiteral":
      return node.value;
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "NumericLiteral") {
        return -node.argument.value;
      }
      throw new Error(`Unsupported unary expression: ${node.operator}`);
    case "TableConstructorExpression":
      return evalTable(node);
    default:
      throw new Error(`Unsupported expression type in SavedVariables: ${node.type}`);
  }
}

function evalTable(node: luaparse.TableConstructorExpression): LuaValue {
  const positional: LuaValue[] = [];
  const keyed: { [key: string]: LuaValue } = {};
  let hasKeyed = false;

  for (const field of node.fields) {
    if (field.type === "TableValue") {
      positional.push(evalExpression(field.value));
    } else if (field.type === "TableKeyString") {
      keyed[field.key.name] = evalExpression(field.value);
      hasKeyed = true;
    } else {
      const key = evalExpression(field.key);
      keyed[String(key)] = evalExpression(field.value);
      hasKeyed = true;
    }
  }

  if (!hasKeyed) {
    return positional;
  }
  positional.forEach((value, i) => {
    keyed[String(i + 1)] = value;
  });
  return keyed;
}

/**
 * Top-level `Name = { ... }` assignments in a SavedVariables file, by global
 * name. Takes the raw file BYTES rather than a decoded string: luaparse's
 * default encoding mode leaves StringLiteral.value null (only `raw` is set,
 * which is why a naive parse silently produced "null" for every key), so we
 * parse in pseudo-latin1 mode - one char per byte, numeric escapes resolved to
 * bytes - and decode each string from UTF-8 ourselves in evalExpression.
 */
export function parseSavedVariables(bytes: Buffer): Record<string, LuaValue> {
  const chunk = luaparse.parse(bytes.toString("latin1"), {
    comments: false,
    luaVersion: "5.1",
    encodingMode: "pseudo-latin1",
  });
  const globals: Record<string, LuaValue> = {};
  for (const statement of chunk.body) {
    if (statement.type !== "AssignmentStatement") {
      throw new Error(`Unexpected top-level statement in SavedVariables: ${statement.type}`);
    }
    statement.variables.forEach((variable, i) => {
      if (variable.type !== "Identifier") {
        throw new Error(`Unexpected assignment target: ${variable.type}`);
      }
      globals[variable.name] = evalExpression(statement.init[i]);
    });
  }
  return globals;
}

// ---- normalized records ----

export interface SaleRow {
  realmName: string;
  characterName: string;
  itemName: string;
  itemId: number | null;
  quantity: number;
  totalSaleCopper: number;
  depositCopper: number | null;
  consignmentCopper: number | null;
  netCopper: number;
  buyer: string | null;
  commerceAuction: boolean | null;
  capturedAt: string; // ISO instant
  dupOrdinal: number;
}

export interface PurchaseRow {
  realmName: string;
  characterName: string;
  itemName: string;
  itemId: number | null;
  quantity: number;
  totalPaidCopper: number;
  seller: string | null;
  commerceAuction: boolean | null;
  capturedAt: string; // ISO instant
  dupOrdinal: number;
}

export interface RosterRow {
  realmName: string;
  characterName: string;
  connectedRealmId: number | null;
  addedAt: string | null;
}

export interface ExtractedAccountData {
  sales: SaleRow[];
  purchases: PurchaseRow[];
  roster: RosterRow[];
  /** Records with no realm/character: still ingested (as empty strings) but can't be classified. */
  missingRealmOrCharacter: number;
}

const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * The addon stamps records with date("%Y-%m-%dT%H:%M:%S") - the client's local
 * wall-clock time, no zone. This ingest runs on the same machine as WoW, so
 * interpreting it in this machine's zone (DST included) recovers the real
 * instant. (The one ambiguity - the repeated hour at the autumn DST change - is
 * a rounding error for gold totals and not worth special handling.)
 */
function localTimestampToIso(value: unknown, where: string): string {
  const m = typeof value === "string" ? LOCAL_TIMESTAMP.exec(value) : null;
  if (!m) {
    throw new Error(`${where}: bad capturedAt ${JSON.stringify(value)}`);
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

function requireInt(record: Record<string, LuaValue>, field: string, where: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}: ${field} is not a number (${JSON.stringify(value)})`);
  }
  return Math.round(value);
}

function optionalInt(record: Record<string, LuaValue>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function optionalString(record: Record<string, LuaValue>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function asRecordArray(value: LuaValue | undefined, where: string): Record<string, LuaValue>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    // An empty Lua table `{}` parses as [], so anything else non-array is a
    // genuine shape surprise (e.g. keyed by index) - fail loudly.
    throw new Error(`${where}: expected a list of records`);
  }
  return value.map((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${where}[${i + 1}]: expected a record table`);
    }
    return row as Record<string, LuaValue>;
  });
}

/**
 * Rank of each row among identical rows (same `identity` string) in file
 * order, starting at 0. Combined with the row's own fields this is what makes
 * re-ingesting the same file a no-op: identical rows are legitimate (N
 * simultaneous identical sales), so "same fields" alone can't be the key.
 */
function assignOrdinals<T>(rows: T[], identity: (row: T) => string): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = identity(row);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return ordinal;
  });
}

const SEP = "\u001e";

export function extractAccountData(globals: Record<string, LuaValue>): ExtractedAccountData {
  let missingRealmOrCharacter = 0;

  const salesDb = (globals.WowAHTrackerSalesDB ?? {}) as Record<string, LuaValue>;
  const saleRecords = asRecordArray(salesDb.sales, "WowAHTrackerSalesDB.sales");
  const salesPartial = saleRecords.map((r, i) => {
    const where = `sales[${i + 1}]`;
    const realmName = optionalString(r, "realm") ?? "";
    const characterName = optionalString(r, "character") ?? "";
    if (!realmName || !characterName) {
      missingRealmOrCharacter++;
    }
    const itemName = optionalString(r, "itemName");
    if (!itemName) {
      throw new Error(`${where}: missing itemName`);
    }
    return {
      realmName,
      characterName,
      itemName,
      itemId: optionalInt(r, "itemId"),
      quantity: requireInt(r, "count", where),
      totalSaleCopper: requireInt(r, "totalSalePrice", where),
      depositCopper: optionalInt(r, "deposit"),
      consignmentCopper: optionalInt(r, "consignment"),
      netCopper: requireInt(r, "netReceived", where),
      buyer: optionalString(r, "buyer"),
      commerceAuction: typeof r.commerceAuction === "boolean" ? r.commerceAuction : null,
      capturedAt: localTimestampToIso(r.capturedAt, where),
    };
  });
  const saleOrdinals = assignOrdinals(salesPartial, (s) =>
    [s.realmName, s.characterName, s.capturedAt, s.itemName, s.quantity, s.totalSaleCopper, s.netCopper].join(SEP),
  );
  const sales: SaleRow[] = salesPartial.map((s, i) => ({ ...s, dupOrdinal: saleOrdinals[i] }));

  const purchaseDb = (globals.WowAHTrackerPurchaseDB ?? {}) as Record<string, LuaValue>;
  const purchaseRecords = asRecordArray(purchaseDb.purchases, "WowAHTrackerPurchaseDB.purchases");
  const purchasesPartial = purchaseRecords.map((r, i) => {
    const where = `purchases[${i + 1}]`;
    const realmName = optionalString(r, "realm") ?? "";
    const characterName = optionalString(r, "character") ?? "";
    if (!realmName || !characterName) {
      missingRealmOrCharacter++;
    }
    const itemName = optionalString(r, "itemName");
    if (!itemName) {
      throw new Error(`${where}: missing itemName`);
    }
    return {
      realmName,
      characterName,
      itemName,
      itemId: optionalInt(r, "itemId"),
      quantity: requireInt(r, "count", where),
      totalPaidCopper: requireInt(r, "totalPricePaid", where),
      seller: optionalString(r, "seller"),
      commerceAuction: typeof r.commerceAuction === "boolean" ? r.commerceAuction : null,
      capturedAt: localTimestampToIso(r.capturedAt, where),
    };
  });
  const purchaseOrdinals = assignOrdinals(purchasesPartial, (p) =>
    [p.realmName, p.characterName, p.capturedAt, p.itemName, p.quantity, p.totalPaidCopper].join(SEP),
  );
  const purchases: PurchaseRow[] = purchasesPartial.map((p, i) => ({ ...p, dupOrdinal: purchaseOrdinals[i] }));

  const rosterDb = (globals.WowAHTrackerRealmRosterDB ?? {}) as Record<string, LuaValue>;
  const rosterChars = (rosterDb.characters ?? {}) as Record<string, LuaValue>;
  const roster: RosterRow[] = Object.entries(rosterChars).map(([key, entry]) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`roster entry ${key}: expected a record table`);
    }
    const e = entry as Record<string, LuaValue>;
    const realmName = optionalString(e, "realm");
    const characterName = optionalString(e, "character");
    if (!realmName || !characterName) {
      throw new Error(`roster entry ${key}: missing realm/character`);
    }
    return {
      realmName,
      characterName,
      connectedRealmId: optionalInt(e, "connectedRealmId"),
      addedAt: optionalString(e, "addedAt"),
    };
  });

  return { sales, purchases, roster, missingRealmOrCharacter };
}
