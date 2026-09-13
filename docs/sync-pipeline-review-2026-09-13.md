# Granskning av sync-pipelinen — korrekthet och resiliens

Datum: 2026-09-13. Granskad kod: tillståndet på disk efter att 15-minuters-cronen
och `sync_runs`-självspärren landat (sync.yml, schema.sql, runFullSync.ts,
auctions.ts, client.ts, connectedRealms.ts, pool.ts, history.ts, report.ts).

Fokus: sådant som korrumperar eller tyst ger hål i historiken utan att synas
förrän långt senare. Fynden är ordnade efter allvarlighetsgrad, inte efter
frågeordningen. Varje fynd pekar på faktisk kod (fil:rad), beskriver
felscenariot konkret och ger en fix. Sist finns en prioriterad åtgärdslista
som kan köras rakt av i Claude Code.

---

## Sammanfattning — de tre fynd som spelar roll

1. **Actions-kvoten spricker (blockerande, händer inom veckor).** Repot är
   privat. GitHub Free ger 2 000 Actions-minuter/månad för privata repon, och
   varje jobb avrundas *uppåt* till hel minut. Med `*/15` blir det ~96 jobb/dag
   där även ett no-op-jobb kostar 1 minut (VM-start + checkout + `npm ci`) och
   en full sync ~2. Det ger ~3 500 min/månad — kvoten tar slut runt den 17:e
   och därefter startar inga körningar alls (utan betalmetod blockeras
   usage). Det är exakt samma symptom som tappade tick:ar, fast permanent.
   Se fynd 1.

2. **Partiella körningar landar i historiken som om de vore kompletta.**
   Ett fel på realm 47 av 92 lämnar realm 1–46 + commodities committade under
   samma `captured_at`, utan någon markör i `price_snapshots`. Läslagret
   (`getEuWideHistory`, `getLatestPerRealmPrices`) ser en "komplett" timme med
   halva kvantiteten. Dessutom: eftersom körningen då blir `success = false`
   engagerar självspärren aldrig, så en realm som är trasig i en timme ger
   fyra fulla försök i timmen mot Blizzard. Se fynd 2.

3. **Ingen upptäcker frånvaro.** Allt som GitHub notifierar om är
   *misslyckade* körningar. Tappade tick:ar, slut på kvot och stillastående
   Blizzard-dumpar ger inga misslyckanden — de ger tystnad. Se fynd 7.

Resten (idempotensnyckel, per-unit-pris, realm-ID-drift, fetch-timeout,
5xx-retry, TLS) är riktiga men mindre, och löses till stor del av samma
schemaändring som fynd 2.

---

## Fynd 1 — GitHub Actions-kvoten för privata repon (fråga 6, men värre än Neon)

**Vad koden gör.** `sync.yml` kör `*/15 * * * *` → 96 jobb/dag. Varje jobb:
`actions/checkout` + `setup-node` (utan cache) + `npm ci` + `npm run migrate`
(egen Node-process, egen Neon-anslutning) + `npm run sync`. No-op-vägen i
`runFullSync()` rad 81–88 nås först *efter* allt det.

**Felscenariot.** GitHub Free: 2 000 min/månad för privata repon, jobb avrundas
upp till hel minut, och när kvoten är slut blockeras körningarna om ingen
betalmetod finns. Räkneexempel: 72 no-op × 1 min + 24 fulla × 2 min ≈ 120
min/dag ≈ 3 600/månad. Även `*/30` (24 no-op + 24 fulla × 2 ≈ 72/dag ≈
2 160/månad) ligger över. Den gamla timcronen låg på ~1 440. Slutsatsen är
obekväm men tydlig: **med ett privat repo är ingen sub-hourly retry-kadens
kompatibel med gratiskvoten så länge en full sync bilar 2 minuter.**

**Neon-delen** (frågan som ställdes) är däremot ofarlig: gratis-tiern
autosuspendar efter ~5 min inaktivitet, så varje tick väcker databasen
(~0,5–3 s cold start) och håller den vaken i ≥5 min. Det fyrdubblar
compute-timmarna jämfört med timcron men ligger fortfarande långt under
gratiskvoten. Kontrollera siffran i Neon-konsolen, men det är inte
flaskhalsen. Det som *är* värt att fixa: `npm run migrate` som egen process
dubblar anslutningsuppsättningen per tick i onödan (se fix c nedan).

**Fix — välj en av två vägar:**

*(a) Gör repot publikt (rekommenderas).* Actions-minuter är gratis för publika
repon på standard-runners. Koden innehåller inga hemligheter (`.env` är
gitignorerad, secrets ligger i Actions). Det enda som exponeras är
`config/trackedItems.ts` — vilka items du flippar. Om det är okej är detta
en enradsändring i repo-inställningarna och `*/15` kan stå kvar.

*(b) Behåll privat: `*/30` + få ner en full sync till 1 bilad minut.* Kräver
att realm-hämtningarna parallelliseras (idag sekventiellt, 92 × 2 anrop) och
att `npm ci` cacheas. Då bilar både no-op och full sync 1 minut → 48/dag ≈
1 440/månad. Parallellisering är också bra för robusthet (en långsam realm
blockerar inte de andra). Se kod under fynd 2 (`fetchAllRealms` med
concurrency-gräns).

**Oavsett väg, gör dessa i `sync.yml`:**

```yaml
name: Sync EU auction prices

on:
  schedule:
    - cron: "*/15 * * * *"   # eller "*/30" om repot förblir privat
  workflow_dispatch: {}

# Aldrig två sync-körningar samtidigt. Utan detta kan en försenad tick och
# nästa ordinarie tick köra parallellt, båda passera självspärren (den är
# inte atomär) och skriva två nästan identiska snapshots.
concurrency:
  group: sync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 20   # en hängande körning ska inte äta 6 h av kvoten
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm          # npm ci går från ~15 s till ~3 s
      - run: npm ci
      - run: npm run sync     # migrate körs inuti sync (se fix c)
        env:
          BLIZZARD_CLIENT_ID: ${{ secrets.BLIZZARD_CLIENT_ID }}
          BLIZZARD_CLIENT_SECRET: ${{ secrets.BLIZZARD_CLIENT_SECRET }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

*(c) Slå ihop migrate i sync-processen* så det blir en Node-process och en
Neon-anslutning per tick i stället för två. `scripts/runSyncOnce.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFullSync } from "../src/sync/runFullSync.js";
import { pool } from "../src/db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Schema is idempotent (IF NOT EXISTS everywhere), so applying it on every
  // tick is safe and removes the need for a separate migrate step/process.
  await pool.query(readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8"));
  await runFullSync();
}

main()
  .catch((err) => {
    console.error("Sync failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
```

Behåll `npm run migrate` som fristående script för lokalt bruk.

---

## Fynd 2 — Partiella körningar skrivs utan markör (fråga 1)

**Vad koden gör.** `runFullSync.ts` rad 97–124: en enda `try/catch` runt
hela loopen, men *ingen transaktion*. `insertObservations()` (rad 103 och
115) är separata autocommit-queries. Faller `fetchTrackedAuctionsForRealm`
för realm nr 47 så är commodities + realm 1–46 redan committade under
`captured_at = now`, catch-grenen sätter `success = false` och kastar vidare.

**Felscenariot, steg för steg.**

- `price_snapshots` har nu en snapshot vid T med ~46 realmer. Tabellen har
  ingen `sync_run_id`-kolumn, så det finns ingen väg från en rad tillbaka till
  sin körning. `getEuWideHistory()` gör `SUM(quantity) … GROUP BY captured_at`
  → T ser ut som en komplett timme med halva EU-kvantiteten, och `MIN` kan
  missa den billigaste realmen. Sparkline-dippen som blir följden är
  påhittad, och ingenting kan skilja den från en riktig.
- Nästa tick (T+15) ser `success = false`, hoppar över spärren, kör fullt →
  komplett snapshot vid T+15. Den partiella vid T städas aldrig.
- Är realmen trasig i en timme (händer vid Blizzards realm-underhåll) blir
  varje tick ett fullt misslyckat försök: fyra partiella snapshots i timmen,
  noll lyckade, självspärren engagerar aldrig, ~93 flera-MB-nedladdningar
  per försök. Motsatsen till avsikten.
- `blizzardGet()` har ingen explicit timeout (undicis default är 300 s per
  fas). En långsam realm kan hålla jobbet uppe länge; utan
  `concurrency`-gruppen i workflowen startar nästa tick parallellt.
- Följdfel: `upsertConnectedRealm()` (rad 109) körs *före* auktionshämtningen,
  så `connected_realms.last_synced_at` sätts även när prisdatan aldrig
  sparades. Kolumnen betyder i praktiken "vi slog upp namnet", inte "vi
  sparade priser" — vilseledande om den används för att hitta eftersläpande
  realmer.

**Fix — samla i minnet, avgör, skriv i en transaktion.** Volymen är liten
(~2–40 items × 92 realmer = några hundra rader), så det är trivialt att
buffra allt och skriva i ett svep. Kombinerat med per-realm-tolerans med
tröskel:

Schema (läggs *sist* i `schema.sql` eftersom hela filen körs varje tick —
allt måste vara `IF NOT EXISTS`-säkert):

```sql
-- Tie every snapshot row to the run that produced it, so partial/failed runs
-- can be identified and filtered by the query layer.
ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS sync_run_id BIGINT REFERENCES sync_runs(id);

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS realms_expected INTEGER,
  ADD COLUMN IF NOT EXISTS realms_ok INTEGER,
  ADD COLUMN IF NOT EXISTS failed_realm_ids INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gap_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS source_modified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error TEXT;

-- True idempotency key: one observation per item per realm per run.
-- COALESCE because connected_realm_id is NULL for commodities and Postgres
-- treats NULLs as distinct in plain UNIQUE constraints. 0 is never a real id.
CREATE UNIQUE INDEX IF NOT EXISTS price_snapshots_run_item_realm_uidx
  ON price_snapshots (sync_run_id, item_id, COALESCE(connected_realm_id, 0));

ALTER TABLE connected_realms
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS names_changed_at TIMESTAMPTZ;
```

`src/sync/runFullSync.ts` (ersätter hela filen):

```ts
import type pg from "pg";
import { pool } from "../db/pool.js";
import { getActiveTrackedItemIds } from "../../config/trackedItems.js";
import { fetchConnectedRealm, fetchConnectedRealmIds } from "./connectedRealms.js";
import {
  fetchTrackedAuctionsForRealm,
  fetchTrackedCommodities,
  type PriceObservation,
} from "./auctions.js";

// GitHub Actions' cron scheduler drops ticks unpredictably on this repo, so
// the workflow runs every 15 minutes and this guard keeps the effective
// cadence near-hourly: skip entirely if a successful run happened recently.
const MIN_INTERVAL_MS = 55 * 60 * 1000;

// A run with a few failed realms is still worth keeping (flagged as partial)
// - otherwise one flaky realm would block the guard and cause 4 full retries
// per hour. Above this fraction the run is treated as failed and nothing is
// written, so the next tick retries.
const MAX_FAILED_REALM_FRACTION = 0.1;

// If Blizzard is slow, don't let one realm hang the whole run.
const REALM_CONCURRENCY = 6;

interface RealmResult {
  connectedRealmId: number;
  realmNames: string[];
  observations: PriceObservation[];
}

async function getLastSuccessfulSyncStartedAt(): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT started_at FROM sync_runs WHERE success = true ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0]?.started_at ?? null;
}

async function startSyncRun(startedAt: Date, gapMinutes: number | null): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sync_runs (started_at, gap_minutes) VALUES ($1, $2) RETURNING id`,
    [startedAt, gapMinutes],
  );
  // pg returns BIGSERIAL as a string by default - normalise so callers that
  // compare or do arithmetic on it don't get surprised.
  return Number(rows[0].id);
}

async function markRunFailed(id: number, err: unknown, failedRealmIds: number[]) {
  await pool.query(
    `UPDATE sync_runs
       SET finished_at = now(), success = false, error = $2, failed_realm_ids = $3
     WHERE id = $1`,
    [id, String(err).slice(0, 2000), failedRealmIds],
  );
}

/** Run `fn` over `items` with at most `limit` in flight. Order of results is preserved. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function commitRun(
  client: pg.PoolClient,
  runId: number,
  capturedAt: Date,
  realms: RealmResult[],
  commodityObservations: PriceObservation[],
  failedRealmIds: number[],
  realmsExpected: number,
  sourceModifiedAt: Date | null,
) {
  await client.query("BEGIN");
  try {
    for (const realm of realms) {
      await client.query(
        `INSERT INTO connected_realms (connected_realm_id, realm_names, last_synced_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (connected_realm_id) DO UPDATE SET
           realm_names = EXCLUDED.realm_names,
           last_synced_at = EXCLUDED.last_synced_at,
           -- Record when Blizzard changed the group's membership (merge/split),
           -- so a jump in a realm's time series can be explained later.
           names_changed_at = CASE
             WHEN connected_realms.realm_names IS DISTINCT FROM EXCLUDED.realm_names
             THEN EXCLUDED.last_synced_at
             ELSE connected_realms.names_changed_at
           END`,
        [realm.connectedRealmId, realm.realmNames, capturedAt],
      );
    }

    const all = [...commodityObservations, ...realms.flatMap((r) => r.observations)];
    // Chunk to stay well under Postgres' 65 535 bind-parameter limit.
    const CHUNK = 5000;
    for (let start = 0; start < all.length; start += CHUNK) {
      const chunk = all.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((obs, i) => {
        const b = i * 7;
        values.push(runId, obs.itemId, obs.connectedRealmId, capturedAt,
                    obs.minPrice, obs.totalQuantity, obs.listingCount);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
      });
      await client.query(
        `INSERT INTO price_snapshots
           (sync_run_id, item_id, connected_realm_id, captured_at,
            min_price_copper, quantity, listing_count)
         VALUES ${tuples.join(", ")}
         ON CONFLICT DO NOTHING`,
        values,
      );
    }

    await client.query(
      `UPDATE sync_runs SET
         finished_at = now(), success = true,
         partial = $2, failed_realm_ids = $3,
         realms_expected = $4, realms_ok = $5, source_modified_at = $6
       WHERE id = $1`,
      [runId, failedRealmIds.length > 0, failedRealmIds,
       realmsExpected, realms.length, sourceModifiedAt],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function runFullSync(): Promise<void> {
  const now = new Date();
  const lastSuccess = await getLastSuccessfulSyncStartedAt();
  const elapsedMs = lastSuccess ? now.getTime() - lastSuccess.getTime() : null;
  const gapMinutes = elapsedMs === null ? null : Math.round(elapsedMs / 60000);

  if (elapsedMs !== null && elapsedMs < MIN_INTERVAL_MS) {
    console.log(`Skipping sync: last successful run was ${gapMinutes}min ago (< 55min). No API calls, no DB writes.`);
    return;
  }
  if (gapMinutes !== null && gapMinutes > 120) {
    // Shows as a warning annotation on the Actions run; also stored on the row.
    console.log(`::warning::Gap of ${gapMinutes}min since last successful sync - dropped ticks or an outage.`);
  }

  const trackedIds = new Set(getActiveTrackedItemIds());
  if (trackedIds.size === 0) {
    console.log("No active tracked items - nothing to sync.");
    return;
  }

  const runId = await startSyncRun(now, gapMinutes);
  const failedRealmIds: number[] = [];

  try {
    const connectedRealmIds = await fetchConnectedRealmIds();
    console.log(`Resolved ${connectedRealmIds.length} EU connected-realm groups.`);

    const commodities = await fetchTrackedCommodities(trackedIds);

    const realmResults = await mapWithConcurrency(connectedRealmIds, REALM_CONCURRENCY, async (id) => {
      try {
        const realm = await fetchConnectedRealm(id);
        if (realm.connectedRealmId !== id) {
          throw new Error(`Index said ${id} but detail endpoint returned ${realm.connectedRealmId}`);
        }
        const observations = await fetchTrackedAuctionsForRealm(id, trackedIds);
        return { connectedRealmId: id, realmNames: realm.realms.map((r) => r.name), observations } satisfies RealmResult;
      } catch (err) {
        failedRealmIds.push(id);
        console.log(`::warning::Connected realm ${id} failed, continuing: ${String(err).slice(0, 300)}`);
        return null;
      }
    });
    const realms = realmResults.filter((r): r is RealmResult => r !== null);

    const maxFailed = Math.ceil(connectedRealmIds.length * MAX_FAILED_REALM_FRACTION);
    if (failedRealmIds.length > maxFailed) {
      throw new Error(`${failedRealmIds.length}/${connectedRealmIds.length} realms failed (limit ${maxFailed}) - not writing a snapshot this run.`);
    }

    const client = await pool.connect();
    try {
      await commitRun(client, runId, now, realms, commodities.observations,
                      failedRealmIds, connectedRealmIds.length, commodities.lastModified);
    } finally {
      client.release();
    }

    const stored = commodities.observations.length + realms.reduce((n, r) => n + r.observations.length, 0);
    console.log(
      `Sync run ${runId} OK: captured_at=${now.toISOString()} realms=${realms.length}/${connectedRealmIds.length}` +
      ` rows=${stored} failed=[${failedRealmIds.join(",")}] source_modified=${commodities.lastModified?.toISOString() ?? "?"}`,
    );
  } catch (err) {
    await markRunFailed(runId, err, failedRealmIds);
    throw err;
  }
}
```

(`commodities.observations` / `commodities.lastModified` förutsätter ändringen i
fynd 5 där `fetchTrackedCommodities` returnerar `Last-Modified`. Vill du hålla
den ändringen separat: byt till `const commodities = { observations: await
fetchTrackedCommodities(trackedIds), lastModified: null }` tills vidare.)

**Läslagret** måste sedan respektera flaggan. I `history.ts` — lägg till i
båda queries som grupperar per `captured_at`:

```sql
-- getEuWideHistory: only aggregate complete runs (legacy rows with NULL
-- sync_run_id predate the column and are assumed complete).
AND (ps.sync_run_id IS NULL OR EXISTS (
  SELECT 1 FROM sync_runs sr WHERE sr.id = ps.sync_run_id AND sr.success AND NOT sr.partial
))
```

För `getLatestPerRealmPrices` räcker det att `MAX(captured_at)`-uppslaget får
samma villkor, så "senaste" alltid är en komplett körning. Om partiella
körningar ska *visas* men märkas i rapporten: returnera `sr.partial` och
`sr.failed_realm_ids` och skriv ut "N realmer saknas" i `report.ts`.

---

## Fynd 3 — Ingen idempotensnyckel; självspärren är inte atomär (fråga 2)

**Vad koden gör.** `schema.sql` rad 24–25 är ett vanligt `CREATE INDEX`, inte
`UNIQUE`. `price_snapshots` accepterar samma (item, realm, captured_at) hur
många gånger som helst. Och `getLastSuccessfulSyncStartedAt()` → `startSyncRun()`
i `runFullSync()` rad 81–96 är två separata queries utan lås.

**Bedömning, ärligt.** Exakta dubbletter (samma ms-tidsstämpel) är i praktiken
omöjliga med nuvarande kod: `captured_at` sätts en gång per process, och
ingenting retry:ar `insertObservations`. Det verkliga problemet är
*nästan-dubbletter*: två Actions-körningar som passerar spärren samtidigt
(GitHub kan avfyra en försenad tick tätt inpå nästa; `workflow_dispatch`
under en pågående körning) ger två kompletta snapshots sekunder isär. Det
korrumperar inte, men fördubblar API-lasten och ger två punkter i
`getEuWideHistory` för samma timme — exakt det spärren skulle förhindra.

**Fix.** Det unika indexet på `(sync_run_id, item_id, COALESCE(realm, 0))` +
`ON CONFLICT DO NOTHING` från fynd 2 gör själva inserten idempotent.
`concurrency: { group: sync }` i workflowen (fynd 1) tar bort den parallella
Actions-körningen. Kvar är bara "jag kör `npm run sync` lokalt samtidigt som
Actions" — vill du täcka även det, gör spärr + insert atomär med ett
advisory lock:

```ts
// In runFullSync(), replace the first two lines with:
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(7245001)"); // any constant; released on disconnect
  const lastSuccess = ... // same SELECT, but via client
  ...guard...
  const runId = ... // INSERT via client
} finally {
  await client.query("SELECT pg_advisory_unlock(7245001)").catch(() => {});
  client.release();
}
```

Valfritt — workflow-concurrency räcker för det som faktiskt händer i drift.

---

## Fynd 4 — Per-unit-pris för itemized stacks (fråga 4 och 5)

**Vad koden gör.** `auctions.ts` rad 55–56: `price: a.buyout`, `quantity:
a.quantity`. I Blizzards per-realm-dump är `buyout` priset för *hela
listningen* (stacken), medan `unit_price` i commodities-dumpen är per enhet.
`aggregateByItem` tar sedan `Math.min` över blandade stack-storlekar.

**Bedömning.** Dubbelräkning mellan commodities och per-realm (frågan som
ställdes) sker inte: Blizzard klassar varje item som antingen commodity eller
itemized, aldrig båda, och koden hanterar det korrekt genom att skicka samma
ID-set till båda hämtarna och ta det som kommer. Skulle Blizzard omklassa ett
item i en patch (har hänt vid stack-size-ändringar) byter tidsserien bara från
"92 rader summerade" till "1 EU-rad" — `SUM`/`MIN` i `getEuWideHistory` förblir
semantiskt rätt.

Men per-unit-buggen är latent: dagens två items är mounts/pets (qty 1) så
ingen data är fel *nu*. Första gången en stackbar icke-commodity läggs till
som patch-specifikt item blir `min_price_copper` "billigaste stacken", inte
"billigaste enheten". Enheter/overflow i övrigt är OK: `BIGINT` för copper
(WoW-max ~1e11 ryms), `pg` returnerar BIGINT som sträng och `history.ts`
`Number()`-ar korrekt överallt, `captured_at` går rent genom JS-Date ↔
timestamptz eftersom värdet skapas i JS (ms-precision) — men det är just
därför `sync_run_id` är en bättre join-nyckel än en tidsstämpel-likhet.

**Fix** (`auctions.ts` rad 54–56):

```ts
const matching = data.auctions
  .filter((a) => trackedItemIds.has(a.item.id) && typeof a.buyout === "number" && a.quantity > 0)
  // buyout is for the whole listing; store per-unit so stacks of different
  // sizes are comparable and consistent with commodity unit_price.
  .map((a) => ({
    itemId: a.item.id,
    price: Math.floor((a.buyout as number) / a.quantity),
    quantity: a.quantity,
  }));
```

Och en förvarning inför patch-specifika items, för `CLAUDE.md`: gear med
samma `item.id` men olika `bonus_lists` (ilvl-varianter) hamnar i samma
tidsserie. Vill du tracka raid-drops, avgör då om det ska vara "billigaste
oavsett variant" eller per variant — det senare kräver att `bonus_lists`
sparas. Samma sak för burade pets: de ligger som item 82800 (Pet Cage) +
`pet_species_id`, inte under petens eget item-ID.

---

## Fynd 5 — Stillastående Blizzard-dumpar syns inte; ingen 5xx-retry; ingen timeout (fråga 1, 7)

**Vad koden gör.** `client.ts` retry:ar bara på 429 (rad 38–42), ingen
timeout, och kastar bort svarshuvudena. Blizzards dump regenereras ungefär
varje timme och svaret bär `Last-Modified`. Står deras generator still
(händer, ibland i timmar) sparar vi samma data under ny `captured_at` — en
platt linje som ser ut som "stabilt pris" men betyder "gammal data".

**Fix** i `client.ts` — retry på 5xx/nätverksfel, timeout, och exponera
`Last-Modified`:

```ts
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 90_000;

export async function blizzardGetWithMeta<T>(
  path: string,
  { namespace, locale = "en_GB", params = {} }: GetOptions,
): Promise<{ data: T; lastModified: Date | null }> {
  const token = await getAccessToken();
  const url = new URL(`${API_HOST}${path}`);
  url.searchParams.set("namespace", `${namespace}-${env.region}`);
  url.searchParams.set("locale", locale);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const lm = response.headers.get("last-modified");
        return { data: (await response.json()) as T, lastModified: lm ? new Date(lm) : null };
      }
      const body = await response.text().catch(() => "");
      lastError = new Error(`GET ${url.pathname} failed (${response.status}): ${body.slice(0, 200)}`);
      if (!RETRYABLE_STATUS.has(response.status)) throw lastError;
      const retryAfter = Number(response.headers.get("retry-after") ?? 0) * 1000;
      await sleep(Math.max(retryAfter, 2000 * 2 ** (attempt - 1)));
    } catch (err) {
      // AbortError / network errors are retryable too.
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function blizzardGet<T>(path: string, opts: GetOptions): Promise<T> {
  return (await blizzardGetWithMeta<T>(path, opts)).data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

Och i `auctions.ts`, låt `fetchTrackedCommodities` returnera
`{ observations, lastModified }` via `blizzardGetWithMeta`. Commodities-dumpen
räcker som representant för Blizzards timcykel — spara den i
`sync_runs.source_modified_at` (kolumnen finns i fynd 2). Då kan hälsokollen
i fynd 7 flagga "tre körningar i rad med samma source_modified_at".

Bonus: skicka `If-Modified-Since` med förra körningens värde. Blizzard svarar
304 om dumpen inte ändrats → ingen nedladdning, och 304 är i sig signalen
"stillastående". Lägg till när grunden ovan är på plats.

---

## Fynd 6 — Connected-realm-ID-drift (fråga 3)

**Vad koden gör.** `connected_realms` skriver över `realm_names` varje körning
(`runFullSync.ts` rad 38–46). Rader raderas aldrig. ID:t från index-href:en
används för både upsert och auktionsanrop; `detail.id` från
detaljanropet ignoreras.

**Bedömning.** Connected-realm-ID:n är i praktiken stabila och återanvänds
inte (de är knutna till gruppens "master"-realm). Vid en merge försvinner
det ena ID:t ur indexet: dess rader står kvar med frusen `last_synced_at`
(bra — det är en användbar signal), och det andra ID:ts tidsserie får ett
kvantitetshopp från merge-datumet. Det är *korrekt* beteende — men idag
finns ingen markör som förklarar hoppet, och alla historiska rader visar
gruppens *nuvarande* namn i rapporten, inte namnen vid mättillfället.

**Fix.** `names_changed_at` + `first_seen_at` (schema i fynd 2) och den
upsert som sätter `names_changed_at` bara när arrayen faktiskt ändras (kod i
`commitRun` ovan). Plus assert:en `realm.connectedRealmId !== id` i loopen,
så en avvikelse mellan index och detalj blir ett realm-fel i stället för tyst
felattribuering. Vill du senare ha exakt medlemskap per tidpunkt, är det en
liten `connected_realm_membership(connected_realm_id, realm_names,
valid_from)`-tabell som bara får en rad när `names_changed_at` sätts —
inte värt det förrän det behövs.

---

## Fynd 7 — Frånvaro upptäcks inte (fråga 7)

**Vad som finns idag.** `console.log` i Actions-loggen. GitHub mejlar den
som senast committade workflow-filen när en *schemalagd körning
misslyckas*. Det täcker krascher. Det täcker inte: tappade tick:ar (ingen
körning → inget fel), slut på Actions-kvot (körningar startar inte), partiella
körningar efter fynd 2-fixen (de *lyckas* nu), stillastående Blizzard-dump
(lyckas), eller en realm som tyst returnerar `auctions: []` under underhåll
(lyckas, 0 rader, oskiljbart från "inga listningar").

**Principen.** GitHub notifierar bara om misslyckanden, så det enda som
fungerar utan extern infrastruktur är att **översätta frånvaro till ett
misslyckande**: ett separat, billigt hälsojobb som frågar databasen och
failar om något ser fel ut.

**Fix a — tom dump = realm-fel** (`auctions.ts`, i `fetchTrackedAuctionsForRealm`
direkt efter hämtningen):

```ts
// An EU connected realm never legitimately has zero itemized auctions; an
// empty list means Blizzard's dump for that realm is mid-regeneration or the
// realm is in maintenance. Treat it as a fetch failure so the run flags it
// instead of silently storing "no listings".
if (data.auctions.length === 0) {
  throw new Error(`Connected realm ${connectedRealmId} returned an empty auction dump`);
}
```

**Fix b — hälsokoll**, `scripts/healthCheck.ts`:

```ts
import { pool } from "../src/db/pool.js";

const WINDOW_HOURS = 24;
const MIN_SUCCESSFUL_RUNS = 18;   // 24 expected; tolerate a few dropped ticks
const MAX_GAP_MINUTES = 180;
const MAX_STALE_SOURCE_RUNS = 3;  // same Last-Modified N runs in a row

async function main() {
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT * FROM sync_runs
      WHERE started_at > now() - interval '${WINDOW_HOURS} hours'
      ORDER BY started_at
    ),
    gaps AS (
      SELECT started_at - lag(started_at) OVER (ORDER BY started_at) AS gap
      FROM recent WHERE success
    )
    SELECT
      (SELECT count(*) FROM recent WHERE success)                          AS successful,
      (SELECT count(*) FROM recent WHERE NOT success)                      AS failed,
      (SELECT count(*) FROM recent WHERE partial)                          AS partial,
      (SELECT coalesce(max(extract(epoch FROM gap)/60), 0) FROM gaps)     AS max_gap_min,
      (SELECT extract(epoch FROM now() - max(started_at))/60
         FROM recent WHERE success)                                        AS since_last_min,
      (SELECT count(*) FROM (
         SELECT source_modified_at FROM recent WHERE success
         ORDER BY started_at DESC LIMIT ${MAX_STALE_SOURCE_RUNS}
       ) t WHERE source_modified_at IS NOT NULL
       GROUP BY source_modified_at HAVING count(*) = ${MAX_STALE_SOURCE_RUNS}) AS stale_source
  `);
  const s = rows[0];
  const problems: string[] = [];
  if (Number(s.successful) < MIN_SUCCESSFUL_RUNS)
    problems.push(`only ${s.successful} successful runs in ${WINDOW_HOURS}h (expected ~24)`);
  if (Number(s.max_gap_min) > MAX_GAP_MINUTES)
    problems.push(`max gap between successful runs ${Math.round(s.max_gap_min)}min`);
  if (s.since_last_min === null || Number(s.since_last_min) > MAX_GAP_MINUTES)
    problems.push(`last successful run ${Math.round(s.since_last_min ?? 9999)}min ago`);
  if (Number(s.partial) > 0)
    problems.push(`${s.partial} partial run(s) - check failed_realm_ids`);
  if (Number(s.stale_source) > 0)
    problems.push(`Blizzard dump unchanged for the last ${MAX_STALE_SOURCE_RUNS} runs`);

  console.log(JSON.stringify(s, null, 2));
  if (problems.length) {
    console.log(`::error::Sync health: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("Sync health OK.");
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => pool.end());
```

`.github/workflows/health.yml` — tre gånger om dagen, så att minst en tick
överlever GitHubs drop-rate; kollen är idempotent och kostar ~1 minut:

```yaml
name: Sync health check
on:
  schedule:
    - cron: "20 6,14,22 * * *"
  workflow_dispatch: {}
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run health
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

Plus `"health": "tsx scripts/healthCheck.ts"` i `package.json`. När den failar
får du GitHubs vanliga misslyckande-mejl — med orsaken i `::error::`-raden.
Det är hela "upptäckbart inom en dag"-kravet, utan ny infrastruktur.

**Fix c — en strukturerad summeringsrad** per körning (finns i
`runFullSync`-koden ovan: `Sync run N OK: captured_at=… realms=x/y rows=…
failed=[…] source_modified=…`). Det gör `gh run view --log | grep "Sync run"`
till en fullständig historik utan att gräva i DB.

---

## Mindre saker (fixa i förbifarten)

- `pool.ts` rad 10: `rejectUnauthorized: false` stänger av certifikat-
  verifiering — krypterat men inte autentiserat. Neon använder publikt
  betrodda certifikat, så `ssl: { rejectUnauthorized: true }` bör fungera
  rakt av. Testa lokalt först; faller det, pinna Neons CA i stället för att
  lämna det avstängt.
- `startSyncRun()` returnerar en sträng vid runtime trots `Promise<number>`
  (`pg` parsar BIGINT/BIGSERIAL som sträng). Fixat med `Number()` i koden
  ovan; alternativt `pg.types.setTypeParser(20, Number)` globalt i `pool.ts`
  om du är säker på att inga värden överstiger 2^53.
- `README.md` "Scheduling" och `CLAUDE.md` rad 87–90 ("hourly workflow …
  `5 * * * *`") beskriver fortfarande timcronen. Uppdatera samtidigt.
- `quantity INTEGER` på `price_snapshots`: commodity-rader är EU-totaler;
  populära mats når miljoner, inte miljarder, så det håller — men
  `ALTER COLUMN quantity TYPE BIGINT` är gratis och tar bort frågan.
- `sync_runs.started_at` sätts från JS-klockan, `finished_at` från
  Postgres `now()`. Båda UTC, ofarligt, men var konsekvent (koden ovan
  använder `capturedAt` för `last_synced_at` av samma skäl).
- 92 detaljanrop per körning bara för realm-namn. Inte fel, men onödigt:
  hämta bara detalj för ID:n som saknas i `connected_realms` eller vars
  `last_synced_at` är äldre än ett dygn. Sparar hälften av API-anropen och
  ~halva körtiden — relevant om du väljer väg (b) i fynd 1.

---

## Prioriterad åtgärdslista (kör i denna ordning)

1. **Bestäm väg för fynd 1** — publikt repo (behåll `*/15`) eller privat +
   `*/30` + parallellisering. Det här måste avgöras innan månadskvoten tar
   slut; allt annat kan vänta en dag, det här kan inte. Lägg in
   `concurrency`, `timeout-minutes` och `cache: npm` i `sync.yml` oavsett.
2. **Fynd 2 + 3 tillsammans** — schemaändringarna (alla `IF NOT EXISTS`) och
   nya `runFullSync.ts`. Verifiera lokalt med `npm run sync` två gånger inom
   55 min: andra ska no-op:a. Verifiera sedan att en simulerad realm-krasch
   (kasta i `fetchTrackedAuctionsForRealm` för ett hårdkodat ID, tillfälligt)
   ger `partial = true`, `failed_realm_ids = {id}` och att övriga realmer
   ändå landar.
3. **Fynd 5** — `client.ts` med retry/timeout/`Last-Modified`, och
   `source_modified_at` i `sync_runs`.
4. **Fynd 7** — tom-dump-checken, `healthCheck.ts`, `health.yml`. Kör
   `workflow_dispatch` på health en gång manuellt och bekräfta att den går
   grönt, sedan att den går rött om du tillfälligt sätter
   `MIN_SUCCESSFUL_RUNS = 999`.
5. **Fynd 4 + 6 + mindre saker** — per-unit-pris, `names_changed_at`-upsert
   (redan i koden från steg 2), TLS, docs.
6. **Läslagret** — `history.ts` filtrerar på `success AND NOT partial`,
   `report.ts` visar partial-status. Utan det här steget ger steg 2 skydd
   i databasen men inte i rapporten.

Obligatoriskt sista steg enligt CLAUDE.md gäller fortfarande: efter deploy,
vänta 2–3 timmar och kör `gh run list --workflow=sync.yml --limit 20`. Nytt
är att du nu också kan köra `npm run health` lokalt och få samma bedömning
som det schemalagda jobbet.

---

## Källor

- GitHub Free: 2 000 Actions-minuter/månad för privata repon; publika repon
  gratis på standard-runners; usage blockeras när kvoten är slut utan
  betalmetod: [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- Per-jobb-avrundning uppåt till hel minut: [Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
