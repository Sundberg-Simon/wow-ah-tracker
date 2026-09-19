import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The WoW accounts whose SavedVariables the earnings ingest reads. `folder` is
// the WTF\Account directory name (also what's stored in the DB's `account`
// column - the stable id); `label` is the display name used in reports, kept
// here so renaming one never needs a DB migration.
//
// The list itself lives in config/earningsAccounts.local.json, which is
// GITIGNORED: the WTF folder names are Battle.net account identifiers, and this
// repo is public (CLAUDE.md #8). Copy earningsAccounts.example.json to
// earningsAccounts.local.json and fill in the real folder names. Only the
// local-only earnings scripts import this file - sync/report/CI never do.

export interface EarningsAccount {
  folder: string;
  label: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG = path.join(__dirname, "earningsAccounts.local.json");

function loadAccounts(): EarningsAccount[] {
  if (!existsSync(LOCAL_CONFIG)) {
    throw new Error(
      `Missing ${LOCAL_CONFIG}. Copy config/earningsAccounts.example.json to earningsAccounts.local.json ` +
        `and fill in your WTF\\Account folder names (this file is gitignored on purpose - see config/earningsAccounts.ts).`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(LOCAL_CONFIG, "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((a) => a && typeof a.folder === "string" && a.folder && typeof a.label === "string" && a.label)
  ) {
    throw new Error(`${LOCAL_CONFIG} must be a non-empty JSON array of { "folder": string, "label": string }.`);
  }
  return parsed as EarningsAccount[];
}

export const EARNINGS_ACCOUNTS: EarningsAccount[] = loadAccounts();

export function accountLabel(folder: string): string {
  return EARNINGS_ACCOUNTS.find((a) => a.folder === folder)?.label ?? folder;
}
