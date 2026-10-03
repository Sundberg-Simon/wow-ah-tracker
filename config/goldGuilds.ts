import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Which guild banks count toward the total-gold graph in the local earnings
// report (CLAUDE.md #18). The addon records every guild bank Simon opens; only
// the ones listed here are added to the total - some guilds are pure storage
// and he decides per guild. The report lists every guild bank it has seen,
// counted or not, with the exact key to paste here.
//
// config/goldGuilds.local.json is GITIGNORED (guild names are personal; the repo
// is public). Shape: { "countedGuildBanks": ["<realm>|<guild name>", ...] }.
// A missing file means "no guild banks counted yet" - not an error.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GOLD_GUILDS_CONFIG = path.join(__dirname, "goldGuilds.local.json");

export interface GoldGuildConfig {
  /** "realm|guild" keys, exactly as the report lists them. */
  counted: Set<string>;
  /** Set when the file exists but can't be used - the report shows it instead of failing. */
  error: string | null;
  fileExists: boolean;
}

export function loadGoldGuilds(file: string = GOLD_GUILDS_CONFIG): GoldGuildConfig {
  if (!existsSync(file)) return { counted: new Set(), error: null, fileExists: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const list = (parsed as { countedGuildBanks?: unknown })?.countedGuildBanks;
    if (!Array.isArray(list) || !list.every((k) => typeof k === "string" && /^[^|]+\|[^|]+$/.test(k))) {
      return {
        counted: new Set(),
        error: `${path.basename(file)} must be { "countedGuildBanks": ["<realm>|<guild name>", ...] } - no guild banks are counted until it's fixed.`,
        fileExists: true,
      };
    }
    return { counted: new Set(list as string[]), error: null, fileExists: true };
  } catch (err) {
    return { counted: new Set(), error: `${path.basename(file)} is not valid JSON (${String(err)}) - no guild banks are counted until it's fixed.`, fileExists: true };
  }
}
