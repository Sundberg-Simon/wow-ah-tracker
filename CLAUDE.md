# Projekt: wow-ah-tracker

## Vad detta är
En personlig, EU-only WoW auction house-pristracker för en liten uppsättning
bevakade items (ren flipping — köp/sälj via AH, ingen crafting inblandad).
En självbyggd, nedskalad ersättare till undermine.exchange, sedan den
tjänsten gick över till en betalversion.

## Nuvarande fas
Milestone 1 och 2 klara och verifierade mot skarp data. Läslagret (v1) är
byggt: `npm run report` skriver en lokal, självständig HTML-rapport
(nuvarande pris/kvantitet per realm, regionalt min/median, pristrend) —
ingen hosting, ingen webbapp. En fullständig granskning av sync-pipelinen
(docs/sync-pipeline-review-2026-09-13.md) hittade och åtgärdade tre
allvarliga brister: Actions-kvoten hade spruckit inom veckor på privat
repo (löst genom att göra repot publikt, #8), partiella körningar kunde
landa tyst som "kompletta" i läslagret (löst med transaktion +
`sync_run_id` + partial-flagga, #9), och frånvaro (tappade tick:ar,
slut kvot, stillastående data) upptäcktes inte alls (löst med separat
`health.yml`-workflow tre ggr/dag). Även per-unit-prisbugg för framtida
stackbara icke-commodity-items fixad, TLS-certifikatverifiering
återaktiverad mot Neon, retry/timeout/`Last-Modified` tillagt i
Blizzard-klienten. Allt verifierat lokalt (dubbelkörning för
självspärr, simulerad realm-krasch för partial-hantering) och i skarp
CI. Secrets konfigurerade. Väntar fortfarande in 2-3h verifiering av
självspärren i naturlig (icke-manuellt-triggad) drift, samt att
health-checken går grön i skarpt schemalagt läge (se "Obligatoriskt
sista steg"). WoW-addonet (v1: prisalert vid login, `/waht`,
`/waht search`) och det schemalagda Windows-hämtningsjobbet är byggda
och installerade på den här maskinen — men eftersom det är spelkod, inte
CI, återstår manuell in-game-verifiering av spelaren själv innan det kan
kallas klart. [Uppdatera den här raden manuellt allt eftersom.]

## Teknikstack — håll dig till detta, föreslå inte alternativ utan att fråga
- Språk/runtime: TypeScript / Node.js (sync-jobb + query-helpers)
- Körning: GitHub Actions (cron var 15:e minut + tidsbaserad självspärr,
  se arkitekturbeslut #7) — INTE en lokal scheduler. Kontinuerlig
  historik är hela poängen med projektet, och en lokal scheduler skulle
  ge hål i datan varje gång datorn är av/sover.
- Repot är publikt (arkitekturbeslut #8) — inte privat. Detta är en
  fattad konsekvens av beslut #7 (Actions-minuter är gratis för publika
  repon, vilket gör */15-kadensen möjlig utan kvotrisk), inte ett
  fristående val att ifrågasätta separat.
- Databas: Neon Postgres (gratis-tier), EU-region (London/AWS eu-west-2)
  — krävs eftersom GitHub Actions har ett efemärt filsystem; en lokal
  SQLite-fil duger inte här.
- Datakälla: Blizzards officiella Game Data API (OAuth client-credentials
  flow), ENDAST EU-regionen (namespace dynamic-eu). Ingen scraping.

## Arkitekturbeslut — dessa är fattade beslut, inte öppna frågor
1. **Bara bevakade items, aldrig hela auktionshuset.** Blizzards
   `/data/wow/connected-realm/{id}/auctions`-endpoint returnerar alltid
   HELA realmens auktionslista — det finns inget per-item-filter på
   Blizzards sida. Vi hämtar hela dumpen men filtrerar och sparar bara
   våra bevakade item-ID:n. Föreslå aldrig att lagra/bearbeta hela dumpen
   "för säkerhets skull" eller "för framtida bruk".
2. **Bara EU.** US/TW/KR är permanent utanför scope, inte en fas-1-
   begränsning som ska tas bort senare.
3. **Realm-listan hämtas alltid live** från
   `/data/wow/connected-realm/index` — hårdkoda den aldrig utifrån en
   gissning, en wiki-lista eller ett tidigare cachat resultat. Bekräftat
   antal: 92 EU connected-realm-grupper (högre än den ursprungliga
   uppskattningen ~79 — lita på API:t, inte på den gamla uppskattningen).
4. **Två item-kategorier i schemat, satta från start**: `permanent`
   (bevakas för alltid) och `patch-specific` (knuten till aktuell
   patch/innehållscykel). Varje item har dessutom en `active`-flagga
   oberoende av kategori. Att stänga av ett patch-specifikt item ska
   bara sluta synka/visa det framåt i tiden — historik som redan finns
   ska ALDRIG raderas, och avstängning ska aldrig kräva en
   schemamigrering (fälten finns redan i schemat).
5. **Ingen full auktionshusprodukt.** Inga användarkonton, ingen auth
   utöver att jag själv kör det, inget multi-tenant, ingen publik
   ambition. Håll infrastrukturen på gratis/hobby-nivå.
6. **Ren flipping, ingen crafting.** Allt köps och säljs via AH. Detta
   gör en framtida nettoberäkning (se "Medvetet uppskjutet" nedan) enkel:
   summa sälj-transaktioner minus summa köp-transaktioner, utan behov av
   att värdera råvaror eller crafting-kostnad.
7. **Schemat kör var 15:e minut, med en tidsbaserad självspärr i
   syncjobbet — inte en gång i timmen rakt av.** Grundorsaken är
   utredd och bekräftad (via `gh run view <id> --json
   createdAt,startedAt` på flera schemalagda körningar: createdAt ==
   startedAt varje gång, dvs ingen runner-könsfördröjning — GitHub
   Actions cron-scheduler tappar helt enkelt tick:ar opålitligt på
   låg-aktivitetsrepon som det här, bekräftat genom att t.ex. 14:05/
   15:05/16:05 saknades helt ur körningshistoriken). Det här är inte
   en öppen fråga att ifrågasätta eller "optimera" senare — föreslå
   inte att gå tillbaka till en enkel timmes-cron. Implementationen:
   workflow-cronen är `*/15 * * * *` (fyra chanser i timmen), och
   `runFullSync()` i `src/sync/runFullSync.ts` slår upp senaste
   *lyckade* körning i `sync_runs`-tabellen innan den gör några
   Blizzard API-anrop — är det mindre än 55 minuter sedan, avslutas
   jobbet direkt (exit 0, inga API-anrop, inga DB-skrivningar utöver
   själva uppslaget). En körning som startar men kraschar lämnas som
   `success = false` så nästa tick får försöka igen utan att vänta ut
   hela 55-minutersfönstret.
8. **Repot är publikt.** Konsekvens av #7: med privat repo och */15-cron
   spricker GitHub Actions gratiskvoten (2000 min/månad) inom ~2-3
   veckor. Bekräftat säkert innan beslutet togs: `git log --all
   --full-history` visar att varken `.env` eller de faktiska
   secret-värdena (Blizzard client id/secret, Neon-lösenord) någonsin
   committats, i någon branch. Secrets ligger enbart i GitHub Actions
   secrets, aldrig i repot. Det enda som blir synligt för utomstående är
   koden och `config/trackedItems.ts` (vilka items som trackas) — inte en
   öppen fråga att backa från utan ny anledning.
9. **En sync-körning är antingen komplett eller så finns den inte i
   läslagret — aldrig tyst ofullständig.** Grundorsak: en körning som
   kraschade halvvägs (t.ex. realm 47 av 92) skrev tidigare ändå de
   redan hämtade raderna utan någon markör, så läslagret såg en
   "komplett" timme med halva kvantiteten. Fix, i `runFullSync.ts`:
   varje körnings rader taggas med `sync_run_id`; hela commit-steget
   (connected_realms-upsert + price_snapshots-insert + markering av
   `sync_runs` som klar) körs i EN transaktion; upp till 10% av
   realmerna får misslyckas utan att hela körningen kastas (markeras
   `partial = true` istället, resten av realmerna sparas ändå) —
   annars skulle en enda trög realm blockera självspärren i #7 och ge
   fyra fulla omförsök i timmen. `history.ts` filtrerar bort allt utom
   `success AND NOT partial`-körningar (rader utan `sync_run_id`
   antas kompletta — de föregår kolumnen). En tom auktionsdump för en
   realm behandlas som ett fel, inte som "inga listningar" (en EU-realm
   har aldrig legitimt noll auktioner). Verifierat lokalt: en simulerad
   realm-krasch gav `partial = true`, `failed_realm_ids = {id}`, övriga
   91 realmer sparades ändå, och läslagret hoppade korrekt vidare till
   senaste kompletta körning istället för den partiella.
   Bakgrund: `docs/sync-pipeline-review-2026-09-13.md` (fynd 1-7) — läs
   den för fullständigt resonemang bakom #7-#9 innan du föreslår att
   förenkla något av detta.
10. **Rapporten auto-publiceras via GitHub Pages efter varje sync-körning
    — inget manuellt `npm run report` längre för att se aktuell data.**
    `sync.yml`: efter `npm run sync` körs `npm run report` (läser bara
    från DB:n, samma `DATABASE_URL`), sedan
    `actions/upload-pages-artifact@v3` (laddar upp `reports/`-mappen —
    OK att `reports/index.html` är gitignorerad, artifact-upload kräver
    inte git-tracking, bara att filen finns på disk i jobbet). Ett
    separat `deploy`-jobb (`needs: sync`, `environment: github-pages`)
    kör `actions/deploy-pages@v4` och publicerar den. Möjliggjort av
    #8 (Pages är gratis för publika repon). URL:
    https://sundberg-simon.github.io/wow-ah-tracker/ — filen heter
    `index.html` så repo-roten fungerar direkt, ingen `/index.html`-
    suffix behövs (bytt från `latest.html` 2026-09-13 av precis den
    anledningen). Kräver `pages: write` + `id-token: write` i
    workflow-permissions. `npm run report` skriver sedan 2026-09-13
    även `reports/data.lua` bredvid `index.html` (samma
    `upload-pages-artifact`-steg tar med båda automatiskt, ingen
    workflow-ändring behövdes) — en Lua-tabell-literal (inte JSON) med
    samma per-item-data som HTML-rapporten, avsedd för det framtida
    WoW-addonet som ska läsa den via ett schemalagt Windows-jobb, inte
    över nätverket från spelet. Källa: samma `gatherItemData()`-anrop
    som HTML:en, så de två filerna kan aldrig gå isär.
    `WowAhTrackerData.connectedRealms` (tillagd 2026-09-13) listar
    *alla* EU connected-realm-ID:n + medlemsnamn oavsett aktiva
    listningar just nu (från `connected_realms`-tabellen, inte
    per-item `realms`-listan) — krävs för att addonet ska kunna mappa
    `GetRealmName()` till en grupp även när ingen bevakad vara har
    listningar på spelarens realm just då.
    OBS — engångssteg som bara kan göras i webb-UI:t, inte via kod: Pages
    måste vara påslaget i Settings → Pages → "Build and deployment" →
    källa "GitHub Actions" (inte "Deploy from a branch") innan första
    deploy-körningen kan lyckas.

## Vad som är byggt och verifierat hittills
- **Milestone 1**: OAuth-token, connected-realm-upplösning, per-realm-
  och commodity-filtrering mot riktiga item-ID:n (128671, 72145 m.fl.) —
  verifierat mot skarpt API.
- **Milestone 2**: Postgres-schema applicerat på Neon, full sync-loop
  över alla 92 EU connected realms + commodities i en körning (184 rader
  i en pass), query-helper verifierad (t.ex. EU-wide min-pris/kvantitet
  för ett item).
- **Live**: GitHub-repo (github.com/Sundberg-Simon/wow-ah-tracker,
  publikt sedan granskningen 2026-09-13), sync-workflow
  (.github/workflows/sync.yml, `*/15 * * * *` + manual
  workflow_dispatch + 55-min självspärr), health-check-workflow
  (.github/workflows/health.yml, tre ggr/dag), secrets satta via `gh`
  CLI. Flera skarpa pass har körts och skrivit verifierade rader i
  DB:n, inklusive ett verifierat partial-run-scenario (se
  arkitekturbeslut #9).
- **WoW-addon v1 + Windows-hämtningsjobb** (byggt 2026-09-13/14):
  `addon/WowAHTracker/` (Interface 120100, uppslaget mot en
  live-byggspårare — inte gissat) läser `WowAhTrackerData` vid
  `PLAYER_LOGIN`, skriver ut EU-wide min/median per aktivt bevakat item
  och jämför mot spelarens egen connected-realm-grupp (matchad via
  `GetRealmName()`, normaliserad för att stryka mellanslag på samma
  sätt som WoW:s API gör). `/waht` upprepar sammanfattningen; `/waht
  search <namn>` slår upp ett bevakat item och kör
  `C_AuctionHouse.SendSearchQuery` via `MakeItemKey` — kollar explicit
  att AH-fönstret är öppet innan anropet, annars ett tydligt
  felmeddelande istället för ett tyst no-op. Allt hanterar saknad/nil
  `WowAhTrackerData` utan Lua-fel.
  `scripts/windows/Fetch-DataLua.ps1` hämtar `data.lua` från Pages-URL:en
  till en temp-fil, validerar att den innehåller `WowAhTrackerData = {`
  nära toppen och inte ser ut som en HTML-felsida, och ersätter först då
  den riktiga filen — verifierat mot en riktig 404 att en misslyckad
  hämtning lämnar den befintliga filen helt orörd (identisk storlek och
  tidsstämpel).
  Schemaläggning: `schtasks.exe /create` tillåter INTE `/RI`+`/DU`
  tillsammans med `/sc ONLOGON` (CLI-begränsning, inte en begränsning i
  själva Task Scheduler-motorn — GUI:t stödjer exakt detta). Löst genom
  att importera en hopskriven task-XML via `schtasks /create /xml`
  istället. Det kontot som kör detta saknar dessutom rättighet att
  registrera schemalagda uppgifter alls utan förhöjda rättigheter på den
  här maskinen (bekräftat: även den enklaste möjliga `/create` gav
  "Åtkomst nekad") — löst genom en engångs-UAC-höjning
  (`Start-Process -Verb RunAs`) enbart för registreringssteget; själva
  den registrerade uppgiften körs sedan som den vanliga användaren
  (`LogonType: InteractiveToken`, ingen förhöjning vid körning).
  Verifierat: uppgiften finns (`schtasks /query /tn WowAhTrackerFetch
  /xml` visar korrekt `LogonTrigger` med `Interval PT15M` / `Duration
  P3650D`), och en riktig körning via `schtasks /run` uppdaterade
  faktiskt `data.lua` (nytt `Last Result: 0`, ny tidsstämpel, ny
  filstorlek) — inte bara att jobbet "finns".
  **Låst lärdom, gäller allt framtida AH-UI-arbete i addonet**: anropa
  ALDRIG `C_AuctionHouse.SendSearchQuery`/`SendBrowseQuery` direkt.
  Hittades i skarp in-game-testning (v1: `/waht search` skrev ut
  "Searching..." men resultatlistan uppdaterades aldrig) och bekräftades
  mot Blizzards egen klient-UI-källkod (Gethe/wow-ui-source, live-grenen,
  inte gissat): `AuctionHouseFrame` håller eget state
  (`self.activeSearches`) för vilken sökning som är "aktiv", och
  resultatlistan renderar bara sådant den känner igen som sitt eget.
  Rätt väg är alltid `AuctionHouseFrame.SearchBar:SetSearchText(text)`
  följt av `:StartSearch()` — samma två anrop som sökrutans egen
  `OnEnterPressed`-hanterare gör, vilket i sin tur går via
  `AuctionHouseFrame:SendBrowseQuery()` (sätter `activeSearches`, byter
  visningsläge till Buy, triggar rätt event) innan den någonsin rör
  C_AuctionHouse-API:t. En rak C_AuctionHouse-anrop "lyckas" tekniskt
  (riktig serverrundtripp, inget fel) men är osynligt för spelaren —
  precis den sortens bugg som inte syns förrän man testar i spelet.

## Vad vi medvetet skjuter upp (fråga innan du bygger något av detta)
- **Favorites-list-integration i addonet**: för bevakade items som är
  favoritmarkerade i spelets inbyggda AH (`IsFavoriteItem`/
  `RequestFavorites`), visa regionalt snittpris i en kolumn (hover →
  topp 10 realmer + senast uppdaterat) och eget snittsäljpris i en annan
  (hover → senaste 10 försäljningar + realm).
- **Egen sale-capture-listener i addonet**: läs `MAIL_INBOX_UPDATE` +
  `GetInboxInvoiceInfo` (invoiceType buyer/seller) för att logga egna
  köp/sälj. Funkar oavsett vilken mail-UI (t.ex. TSM:s mailing-fönster)
  som används, eftersom det läser samma underliggande spel-API. Bygg
  INTE detta ovanpå TSM:s interna accounting-data — den är odokumenterad
  och kan ändras utan varning mellan TSM-uppdateringar.
- **Lokal HTML-nettorapport**: vinst per realm, per item och totalt,
  byggd från den egna köp/sälj-loggen ovan (ingen extern hosting behövs).
- **Per-patch-rapport**: tagga transaktioner med `GetBuildInfo()` vid
  loggningstillfället (inte manuellt underhållna patch-datumintervall).
  Visa flera "bästa"-listor (vinst, omsättning, volym, största enskilda
  sälj) sida vid sida istället för att välja en enda "bästa"-mätvariabel.

## Obligatoriskt sista steg — innan du säger att något är klart att testa
Kolla i Actions-fliken (eller `gh run list`/`gh run view`) att körningen
faktiskt lyckades, inte bara att den triggades eller att en push gick
igenom. Och specifikt vid ändringar av schemat/självspärren: kör
`gh run list --workflow=sync.yml --limit 20` några timmar senare och
bekräfta att självspärren faktiskt hoppar över dubbletter — två
körningar inom samma 55-minutersfönster ska bara resultera i EN
faktisk sync (API-anrop + DB-skrivningar); den andra ska synas som en
snabb no-op i loggen ("Skipping sync: last successful run was Xmin
ago"), inte som ännu en full körning. Att cronen nu går oftare bevisar
inget i sig — det är no-op-skippet som måste verifieras i skarp drift.

Efter granskningen 2026-09-13 (docs/sync-pipeline-review-2026-09-13.md,
arkitekturbeslut #9): kör `npm run health` (eller vänta på
health.yml, tre ggr/dag) och bekräfta att den går grön i skarp drift
efter att tillräckligt många schemalagda körningar hunnit samlas
(~18 lyckade på 24h). Går den röd initialt är det förväntat tills
kadensen stabiliserats — inte nödvändigtvis ett nytt fel.

**Addon/spelkod är ett specialfall**: `gh run list` säger ingenting om
kod som körs i WoW-klienten. Ett addon eller ändring av det är ALDRIG
"klart" förrän spelaren själv har startat om WoW eller kört `/reload`,
beskrivit exakt vad som hände i chatten (eller inte hände), och du har
fått den återkopplingen — anta aldrig att Lua-koden fungerar bara för
att den parsar syntaktiskt (verifierat lokalt med `luaparse`, som bara
fångar syntaxfel, inte fel API-namn/enum-medlemmar/runtime-fel).
