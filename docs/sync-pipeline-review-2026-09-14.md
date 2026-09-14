# wow-ah-tracker — follow-up review (2026-09-14)

Scope: everything built *since* the 2026-09-13 review (`docs/sync-pipeline-review-2026-09-13.md`)
that hadn't been read yet — the WoW addon (`addon/WowAHTracker/`), the Windows fetch
script + its log, `healthCheck.ts`, `CLAUDE.md`, and a re-read of `runFullSync.ts`,
`auctions.ts`, `connectedRealms.ts`, the Blizzard API client/auth, `pool.ts`, and
`sync.yml` as actually built (not as proposed). Same method as the previous review:
concrete file:line, a real failure scenario, a suggested fix. Nine findings, ranked
by how much they actually matter.

---

## Finding 1 (was "B") — healthCheck.ts alarms on every partial run, which defeats the point of the 10% tolerance

`scripts/healthCheck.ts`: `if (Number(s.partial) > 0) problems.push(...)`.

`runFullSync.ts` was deliberately built to tolerate up to 10% of connected realms
failing in a single run without treating the run as broken (`MAX_FAILED_REALM_FRACTION`,
`commitRun`'s `partial = failedRealmIds.length > 0`). That's the correct design — a
single flaky realm shouldn't nuke an otherwise-good hourly snapshot.

But `healthCheck.ts` doesn't know about that tolerance. It treats **any** run with
`partial = true` — even 1 failed realm out of ~90 — as a health problem worth emailing
Simon about. That means the first ordinary realm hiccup (not a real outage, just Blizzard
being Blizzard) generates a failure email, exactly the noise the 10%-tolerance design was
built to avoid. It also directly undermines the already-filed to-do to observe the 10%
threshold's real-world calibration for a week — every partial run during that week will
look like a "failure" in your inbox regardless of whether it's within tolerance.

**Fix:** only alarm when the *rate* of partial runs, or the *size* of a single partial
run's failure, crosses a real threshold — e.g. flag if a run's `failed_realm_ids` count
exceeds some fraction close to the 10% ceiling, or if partial runs happen on most/all
recent runs (suggesting a systemic issue) rather than once. A reasonable version: keep
counting partial runs, but only push a problem if *more than N* of the last 24h's runs
were partial, or if any single run's failed-realm count is close to the configured max.

## Finding 2 (new) — an empty auction dump on one realm counts as a "failure", which will make Finding 1 fire often in practice

`src/sync/auctions.ts:58-60`:

```ts
if (data.auctions.length === 0) {
  throw new Error(`Connected realm ${connectedRealmId} returned an empty auction dump`);
}
```

The comment's reasoning is sound (an empty raw dump usually means Blizzard's
mid-regeneration, not "no auctions exist"), but the practical effect is that Blizzard's
well-documented per-hour dump-regeneration windows will routinely make one or two of the
~90 EU connected realms come back empty on any given run — and each one gets counted as a
failed realm. That's exactly the kind of ordinary, expected noise the 10% tolerance exists
to absorb — but combined with Finding 1, every one of those runs will *also* trip the
health check, because `failedRealmIds.length > 0` sets `partial = true` regardless of how
far under the 10% ceiling it is. This isn't a hypothetical interaction — it's the most
likely way Finding 1 will actually surface in your inbox.

**Fix:** this one's fine to leave as-is once Finding 1 is fixed properly (the tolerance
design already accounts for exactly this). Just flag it here so it's clear *why* Finding 1
matters in practice, not just in theory — it's not a rare edge case, it's the normal case.

## Finding 3 (was "C") — CLAUDE.md contradicts itself about the AH search fix

`CLAUDE.md`, the "Vad som är byggt och verifierat hittills" section (~lines 184-189)
still describes the **old, broken** approach — calling `C_AuctionHouse.SendSearchQuery`
via `MakeItemKey` directly. The later "Låst lärdom" section (~lines 212-227) correctly
documents the real, verified fix (drive `AuctionHouseFrame.SearchBar:SetSearchText()` +
`:StartSearch()`) and explicitly warns against the exact approach the earlier section
still describes as "built and verified."

This is a real risk specifically *because* it's in CLAUDE.md: it's the file a future
Claude Code session reads first to understand what's already done. A future session
skimming the "built and verified" list without reaching the "locked lesson" section could
reasonably conclude the old approach is the current, working one and reintroduce the exact
bug that was already found and fixed via in-game testing.

**Fix:** update the "built and verified" section's search-related line to describe the
actual current implementation (SearchBar-driven), so the two sections agree. Mechanical,
no code change needed.

## Finding 4 (was "A", sharpened) — the addon never shows data freshness, and the natural fix has a trap

`addon/WowAHTracker/WowAHTracker.lua`'s `buildSummaryLines()` never reads
`item.capturedAt` or `WowAhTrackerData.generatedAt`, even though both are in the data
file. A player has no in-game way to tell whether the prices they're looking at are 5
minutes or several hours old — which matters more than usual here, since the addon only
re-reads `data.lua` at login/`/reload`, independent of how often the Windows job refreshes
the file on disk.

**The trap for whoever implements this:** `generatedAt` (top of `data.lua`, set in
`scripts/report.ts`) is *not* a good freshness signal on its own. `sync.yml`'s `report`
step runs on every tick — including ticks where `runFullSync()` self-throttled and did
nothing (`MIN_INTERVAL_MS`, ~every 15 min) — so `generatedAt` gets bumped roughly every 15
minutes regardless of whether any new price data was actually captured. The real
per-item freshness signal is `item.capturedAt`, which only advances when a sync actually
ran (roughly hourly). Showing `generatedAt` in the addon would tell the player "updated 3
minutes ago" while the actual prices could be nearly an hour old — worse than showing
nothing, since it actively misleads.

**Fix:** surface `item.capturedAt` (per item, already present) rather than
`WowAhTrackerData.generatedAt` when this gets built.

## Finding 5 (was "F") — `/waht search`'s substring match relies on non-deterministic table iteration order

`WowAHTracker.lua`'s `searchAuctionHouse` resolves the search term to a tracked item by
substring match, iterating tracked items with `pairs()` (Lua's iteration order over a
table is undefined and can vary between game sessions). With today's 2-item test list,
there's no way for two items to both match the same substring, so this is invisible now.
Once the real ~20-40 item list is loaded, a query like "ore" or "flask" could plausibly
substring-match more than one tracked item, and which one wins becomes arbitrary and can
change from one login to the next.

**Fix:** when multiple items match, either pick the *shortest name* (closest to an exact
match) deterministically, or list all matches and ask the player to be more specific,
rather than silently taking whichever `pairs()` happens to visit first.

## Finding 6 (was "D") — Fetch-DataLua.ps1's log encoding mangles non-ASCII error text

`scripts/windows/Fetch-DataLua.ps1`'s `Write-Log` uses `Add-Content -Path $LogPath -Value
$line` with no `-Encoding` specified. On a Swedish-locale Windows machine this has already
produced mojibake in the log (`Fj�rrservern returnerade ett fel` instead of
`Fjärrservern...`, visible in the real log's line 3). Harmless today since the *presence*
of "FAILED" is still greppable, but any future troubleshooting that depends on reading the
actual .NET/PowerShell exception text will hit garbled characters exactly where the detail
matters.

**Fix:** `Add-Content -Path $LogPath -Value $line -Encoding utf8`.

## Finding 7 (was "E") — the 15-minute repeat schedule has only produced one real repeat so far

The log shows exactly one scheduled-task-triggered success after the Pages-enablement
period (`2026-09-14T06:15:47`, ~15h+ after the prior entries which were all from initial
manual testing / Pages-not-ready). That's consistent with the task working as intended,
but it's also consistent with the repeat trigger silently not firing and this being the
next *login* event instead of a genuine 15-minute repeat. Given the `schtasks /create /xml`
workaround used to get `/RI`+`/DU` working with `ONLOGON` at all, it's worth confirming
this empirically rather than assuming the XML import did what was intended.

**Fix:** not a code change — just check `Fetch-DataLua.log` again after a few hours of a
normal logged-in session. You should see entries roughly 15 minutes apart, not just one
per login. If you don't, the task's repetition settings need a second look.

## Finding 8 (new, low priority) — DB SSL is enabled by a substring check on the connection string, not real parsing

`src/db/pool.ts:13`: `ssl: env.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: true } : undefined`.

This works today because Neon's connection strings include that exact substring. But it's
a plain string search, not URL/query-param parsing — if the `DATABASE_URL` secret's format
ever changes slightly (different query-param order is fine, but e.g. Neon switching its
default to `sslmode=verify-full`, or a differently-cased/spaced value) this silently falls
through to `ssl: undefined`, which lets `pg`/Node decide rather than explicitly requiring
TLS. In practice Neon terminates non-TLS connections server-side, so this would likely fail
loudly (connection refused) rather than silently downgrading to plaintext — low real-world
risk, but worth tightening since a loud failure today doesn't guarantee one after a Neon
change.

**Fix (optional, low priority):** parse the URL properly (`new URL(...).searchParams.get("sslmode")`)
instead of a substring match, so the intent survives a reordering or minor format change.

## Finding 9 (verified fine, no action) — OAuth token caching

Worth confirming explicitly since it wasn't checked before: `src/blizzard-api/auth.ts`
caches the Blizzard access token at module scope and reuses it across all ~90
connected-realm fetches plus the commodities fetch within one sync run, refreshing 60
seconds before expiry. This is correctly implemented — no repeated token requests per
realm, no finding here. Listed only so it's clear this was checked, not missed.

---

## Priority if you only fix a few things

1. **Finding 1 + 2 together** (healthCheck's any-partial-run alarm, and why it'll fire
   often) — this is the one most likely to actually cost you attention: false-alarm emails
   starting soon, undermining the week-long calibration observation you already planned.
2. **Finding 3** (CLAUDE.md contradiction) — five-minute fix, prevents a real regression
   the next time a Claude Code session works on the addon.
3. **Finding 4** (freshness + the generatedAt trap) — worth keeping in mind for whenever
   the addon's freshness display gets built, so it's built right the first time.
4. Findings 5-8 are real but lower-urgency: they either need real scale (5), are cosmetic
   (6), are a one-time empirical check you can do yourself (7), or are defense-in-depth
   (8).
