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
`/waht search`) och det schemalagda Windows-hämtningsjobbet är byggda,
installerade och in-game-verifierade av spelaren (2026-09-14) — inklusive
en riktig bugg som bara syntes i skarp testning (`/waht search`
uppdaterade aldrig AH-resultatlistan; fixad, se arkitekturbeslut/lärdom
i sektionen om addonet nedan). [Uppdatera den här raden manuellt allt
eftersom.]

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
   **Förtydligande 2026-09-19 — vad "historik som aldrig raderas"
   omfattar**: det gäller **sälj-/transaktionsdata** (addonets
   sale/purchase-loggar och `earnings_*`-tabellerna, se #13) — den är
   Simons egen, oersättliga bokföring och rensas/tunnas aldrig. Det gäller
   INTE transienta **auktionssnapshots** (`price_snapshots`): de är en
   löpande observation av marknaden, inte en bokföring, och får tunnas ut
   (t.ex. rullas upp till dagliga/veckovisa aggregat efter en viss tid) när
   lagringen kräver det. Att stänga av ett item (`active: false`) raderar
   fortfarande aldrig något; det är tunnandet som är den uttryckliga,
   separata operationen (`scripts/rollupSnapshots.ts`, se #14).
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
11. **Permanenta items trackas per bas-item-id; slumpade suffix-varianter
    ("Ring of the X" vs "Ring of the Y") antas dela samma id, inte ha
    egna distinkta id:n.** Detta är en väl underbyggd men INTE 100%
    empiriskt hands-on-bekräftad slutsats (ingen sida-vid-sida-jämförelse
    av två riktiga suffix-varianters id:n har gjorts) — grundad på tre
    konvergerande källor 2026-09-15: (1) WoW:s item-link-format har haft
    `itemID` och `suffixID` som separata fält sedan pre-2.0, dokumenterat
    och arkitektoniskt oförändrat sen dess; (2) en skarp sökning mot
    Blizzards egen `/data/wow/search/item` + `/data/wow/item/{id}` över
    50 riktiga items visade noll förekomster av bakad suffix-text i
    statiska namn-fält; (3) mekaniken är sedan länge stabil, väldokumenterad
    community-kunskap, inte en smal/färsk API-yta (till skillnad från
    AH-sökbugen). Konsekvens i kod: `Categorizer.lua`s "+P"-knapp slår
    upp visningsnamnet via `C_Item.GetItemInfo(item.id)` (bart id, inte
    bag-instansens suffix-namn) eftersom bas-id:t redan antas täcka alla
    suffix-rullningar automatiskt i `price_snapshots`/`auctions.ts`s
    `aggregateByItem` — ingen schema- eller pipeline-ändring gjord för
    detta.
    **Felläge om antagandet visar sig fel för ett specifikt item**: den
    specifika suffix-varianten missas helt tyst av trackingen (samma
    begränsning som redan finns idag för vilket item som helst utanför
    listan) — inget kraschar, inget syns som fel, bara en AH-notering som
    aldrig räknas med. Om ett "varför fångade inte trackern den där
    notering"-mysterium dyker upp för ett permanent gear-item med känt
    suffix-namn i framtiden: det är HÄR man ska leta först, inte anta en
    ny bugg. Ingen ytterligare efterforskning planerad — inte värt att
    jaga ett garanterat sida-vid-sida-exempel för ett projekt i den här
    skalan. Dyker ett riktigt suffix-par upp naturligt senare (två
    varianter av samma gear-bit på samma eller olika karaktärer), räcker
    en snabb id-koll då för att bekräfta definitivt.
12. **Klassiskt slumpsuffix ("of the X") går inte att särskilja i
    Blizzards publika Auction House-API — bekräftad plattformsbegränsning,
    inte något att lösa i vår kod.** Uppföljning till #11: om
    bas-id delas mellan suffix-varianter, kan då en patch-specifik post
    ändå peka ut EN specifik suffix-variant istället för att klumpas ihop
    med alla? Svar: nej, inte för det klassiska suffix-systemet.
    Bekräftat 2026-09-15 mot Warcraft Wikis fullständiga, dokumenterade
    tabell över `Enum.ItemModification` (samma typsystem som vårt eget
    `item.modifiers`-fält i AH-svaret använder — bekräftat mot skarp
    data: `type=28` = `ContentTuningID` osv., matchar exakt tabellen)
    — klassiskt suffix-id finns INTE med i den tabellen alls. Wikin är
    explicit: suffix ligger uteslutande i det gamla positionella
    länk-fältet (`suffixID`, mot `ItemRandomProperties.db2`/
    `ItemRandomSuffix.db2`), helt separat från `Enum.ItemModification`.
    Eftersom AH-API:t bara exponerar `Enum.ItemModification`-baserade
    modifiers (plus `bonus_lists`) och ALDRIG den klassiska
    `suffixID`, finns det ingen data i AH-svaret som kan skilja
    "Ring of the X" från "Ring of the Y" — bara det delade bas-id:t.
    Ingen schemaändring, oavsett hur genomtänkt, kan återskapa data
    som API:t helt enkelt inte skickar.
    **Varför det troligen inte spelar roll i praktiken**: det klassiska
    suffix-systemet är en föråldrad (mest Vanilla-eran) mekanik.
    Aktuella patch-specifika kandidater (crafting-mats, raid-drops) är
    antingen suffix-fria helt, eller använder det MODERNA
    modifier-systemet (`ContentTuningID`, crafting quality-nivåer, etc.)
    som redan syns i `item.modifiers`/`bonus_lists` i vår data, eller är
    helt enkelt egna distinkta item-id:n från början (t.ex. olika
    stat-fokuserade katalysator-belöningar). Beslut: bygg INGEN
    suffix-medveten lagring nu — det skulle konstruera runt en mekanik
    plattformen inte kan leverera data för ändå, för ett scenario som
    knappast dyker upp i riktiga patch-specifika tillägg. Dyker ett
    genuint modifier-känsligt patch-specifikt item upp senare: kolla dess
    faktiska `modifiers`/`bonus_lists`-värden då (API:t exponerar dem för
    det moderna systemet) och utöka nyckelbildning bara om just det
    fallet kräver det — bygg inte generisk suffix-infrastruktur i förväg.
13. **Egna intäkts-/köpdata är personlig data: enbart lokalt, ALDRIG via
    Pages, ALDRIG genom det publika repot.** Bakgrund: addonets
    sale/purchase-loggar (SavedVariables, bara på Simons dator) flyttades
    2026-09-19 in i Neon för att kunna ge kontoöverskridande summor och
    långa tidsfönster (1d…1y + all-time) som inte går att göra i spelet.
    Repot och Pages är publika (#8), och intäkter per konto/realm/
    karaktärsnamn är inte något som ska ut dit. Simon sa att tillfällig
    publik exponering inte vore katastrofalt men såg ingen nackdel med
    lokalt — beslutet blev lokalt, inte en öppen fråga att ompröva.
    Konsekvenser, alla avsiktliga:
    - **Väg in i DB:n**: `npm run ingest` (`scripts/ingestSavedVariables.ts`)
      läser SavedVariables-filerna och skriver DIREKT till Neon från
      Simons dator med hans lokala `.env` — aldrig via GitHub (inga
      commits, Actions-artifacts eller issues med data; repot är publikt).
      Tabeller: `earnings_sales`, `earnings_purchases`,
      `roster_characters`, `earnings_ingest_runs`, `realm_population_history`.
    - **Rapporten** (`npm run report:earnings`) skriver
      `reports-private/earnings.html`, gitignorerad. Lägg ALDRIG
      earnings-data i `scripts/report.ts`, `data.lua` eller något som
      `sync.yml` laddar upp (`reports/`-mappen publiceras på Pages).
    - **Kontomappsnamnen** (WTF\Account-mappar = Battle.net-identifierare)
      ligger i `config/earningsAccounts.local.json` (gitignorerad; en
      `.example.json` är incheckad), inte i koden — av samma skäl.
    - **Cross-realm vs other klassas vid frågetillfället, aldrig som lagrad
      kolumn.** Ett record är "cross-realm" om dess realm+karaktär finns i
      `roster_characters` (SQL/aggregering joinar mot rostern som den ser ut
      NU); allt annat är "other". Lägger Simon till en karaktär i rostern
      flyttar dess redan loggade försäljningar retroaktivt till cross-realm.
      Samma regel som i addonet (`/waht sales`). Lägg ALDRIG till en
      `bucket`-kolumn eller cacha klassen på recordet — det fryser
      klassificeringen och bryter kravet i tysthet.
    - **Insert-only, idempotent**: inget raderas ur earnings-tabellerna
      (att städa/nollställa en lokal SavedVariables-fil ska inte kunna
      förlora historik). Identiska rader är legitima (N samtidiga
      identiska försäljningar loggas som N rader med samma tidsstämpel),
      därför ingår `dup_ordinal` i unik-nyckeln. En körning är
      allt-eller-inget (en transaktion) och avbryts om någon filrad inte
      återfinns i DB:n efteråt.
    - **Mått**: "earned" = netto (`netReceived`: pris + återbetald deposit −
      AH-avgift); inköp visas separat och dras ALDRIG av per realm (köp på
      en realm, sälj på en annan — netto per realm skulle göra köp-realmer
      till förlorare). Fönstren är rullande perioder som slutar "nu";
      tidpunkten är `captured_at` = när addonet SÅG mailet, inte när
      auktionen såldes. Realmer rankas per connected-realm-grupp (delar
      ett auktionshus). Populationstier per försäljningstillfälle från
      `realm_population_history` (skrivs i `runFullSync`s commit-transaktion
      bakom en savepoint så den aldrig kan fälla en prissnapshot; bara
      när en tier ändras; äldre records faller tillbaka på tidigast kända).
    - **"Mest sålda items"-listor** (i varje vy, respekterar Characters-/
      Window-filtren; sortering på antal sales eller netto-guld via
      "Sort items"): tre listor — patch-specifika, permanenta och "Not on
      the tracked list". Items klassas vid rapporttillfället mot
      `config/trackedItems.json` (ALLA items, även inaktiva), via item_id
      om den finns, annars via namn (skiftläges-/blankstegsokänsligt).
      `earnings_sales.item_id` är NULL på alla sales hittills (addonet kan
      bara slå upp id mot tracked-listan som den såg ut vid capture), så
      namnet är det som identifierar itemet — klassa ALDRIG in item-typ som
      lagrad kolumn, av samma skäl som cross-realm/other. Den tredje
      listan behövs på riktigt: 9 av de första 21 sales var items utanför
      tracked-listan (crafting-mats m.m.), och utan den försvinner de ur
      item-vyn. Aggregeringen kontrollerar att listorna summerar till
      rapportens sales/netto-totaler.
      **Slumpsuffix-varianter** (#11/#12): mail-fakturans namn bär suffixet
      ("Drustwrought Scythe of the Aurora") medan tracked-listan har bas-
      namnet. Efter ett exakt namnmatch räknas därför ett namn som är ett
      tracked namn + " of ..." som en variant av det itemet och slås ihop
      med basraden (längsta tracked namn vinner; " of " + något efter krävs,
      så "Old Maceration" aldrig matchar "Old Mace"). Vilka varianter som
      sålts syns bredvid namnet ("sold as: of the Aurora"), så inget döljs.
      Hittat 2026-09-19: en dyr sale låg felaktigt under "Not on the
      tracked list". Addonets `findTrackedItemId` matchar fortfarande exakt
      namn, så `earnings_sales.item_id` förblir NULL för suffixnamn — ofarligt
      eftersom rapporten matchar på namn.
    - **Crafted-flagga och uppskattad vinst** (rapport-only, medvetet enkel
      första version): varje tracked item kan ha `crafted` (bool, saknas =
      false) och `est_cost_per_unit` (GULD per enhet, nullable) i
      `config/trackedItems.json`. Ortogonalt mot permanent/patch-specific
      och läses ALDRIG av synken, `data.lua` eller addonet — kan alltså inte
      påverka insamlingen. Item-listorna får kolumnen "Est. profit" =
      netto − kostnad × units (units i den valda vyn), BARA där kostnad är
      satt; ett crafted item utan kostnad visar "cost not set" (aldrig netto
      som om det vore vinst), övriga visar streck. Uppskattningen markeras
      "≈" och förklarar sig vid hover; kostnad 0 räknas som satt, null inte.
      Handskrivna värden valideras strikt av RAPPORTEN (t.ex. "350g" eller
      negativt får rapporten att faila högt, med item och fält utpekade) —
      inte av synken, så ett stavfel kan inte stoppa insamlingen. Ingen
      automatisk mats-prisspårning: Simon uppdaterar kostnaden för hand; om
      det visar sig för grovt är verklig matsspårning ett separat, framtida
      beslut. OBS: filen är publik (#8) — en kostnad man skriver dit
      publiceras om filen pushas. Vial of the Sands (65891) och Sky Golem
      (95416) lades dit 2026-09-19 som permanent + crafted (kostnad ej satt).
    - **Rapportens layout (2026-09-20)**: ett fast banner överst med två
      flikar, **Earnings** och **Stock**, så att de två blir separata sidor i
      stället för en lång. Earnings-fliken har filtren (Characters/Window/
      Sort items), datafärskhetstabellen, alla vyer och noterna; Stock-fliken
      har bara lagersektionen (filtren döljs). En rad "Last pushed to the
      DB" ligger ovanför båda (båda beror på senaste pushen) och Stock-
      knappen visar ett rött antal när kluster är OUT/LOW. Länkar: `#stock`
      öppnar Stock; `#split-window[-sort]` öppnar Earnings som förut (gamla
      länkar funkar). Att växla flik behåller Earnings-filtren.
    - **Trigger**: genvägen "WoW AH Tracker - Push Earnings" på skrivbordet
      + den schemalagda uppgiften `WowAhTrackerPushEarnings` (dagligen
      09:00, `StartWhenAvailable`) kör båda `scripts/windows/Push-Earnings.ps1`
      = ingest och sedan rapportgenerering. WoW skriver SavedVariables
      först vid logout eller `/reload` — filen ligger alltid efter spelet.
      Uppgiften registreras med `Register-EarningsTask.ps1` (kräver en
      UAC-höjning bara för registreringen, precis som `WowAhTrackerFetch`).
    - **Låst lärdom (parsern)**: luaparse ger `StringLiteral.value = null`
      i standardläget (bara `raw` är satt) trots att typerna säger
      `string` — en naiv parse ger tyst `"null"` som nyckel överallt och
      0 rader. Parsern läser därför råa bytes, kör `encodingMode:
      "pseudo-latin1"` och avkodar UTF-8 själv (`src/earnings/savedVariables.ts`).

14. **`category` styr VAD som samlas in: permanenta items = enbart
    försäljningsdata, patch-specifika items = auktionssnapshots.**
    Bakgrund 2026-09-19: alla 108 tracked items är permanenta (long-hold,
    okänsliga för prisfluktuationer: köps billigt på en patch, säljs
    100–1000x senare); inga patch-specifika finns än. Snapshot-syncen för
    108 items är ~8 500 rader/körning ≈ 13 MB/dygn (uppmätt: ~8 körningar/
    dygn, 189 byte/rad inkl. index) — Neon-gratistiern (0,5 GB) hade varit
    full på ~39 dagar, och permanenta items har ingen nytta av datan.
    - **Inget nytt `tracking_mode`-fält**: `category` i
      `config/trackedItems.json` ÄR läget (ett andra fält kunde divergera
      från det). Ingen backfill behövdes — alla 108 var redan
      `permanent`. Inte ett DB-schema-fält (listan ligger i en incheckad fil).
    - **Snapshot-syncen** (`runFullSync`) hämtar och skriver ENBART för
      aktiva `patch-specific` items (`getSnapshotTrackedItems()`). Med noll
      sådana: inga auktionsanrop, inga prisrader, ingen `sync_runs`-rad. Jobbet
      gör då bara en metadata-refresh av `connected_realms` (population/
      status, ~93 realm-detaljanrop, högst var 20:e timme) så att
      populationshistoriken från #13 fortsätter. Lägg INTE till permanenta
      items i snapshot-syncen "för säkerhets skull" — det återskapar
      tillväxten beslutet undviker. Vill man följa priset på ett permanent
      item: gör det patch-specifikt (eller fråga).
    - **Försäljnings-/köp-pipelinen** (addon → SavedVariables → `npm run
      ingest`) påverkas inte och gäller alla items oavsett kategori.
    - **Yta**: permanenta items stannar i `data.lua` (addonets namn→id-
      uppslag för `/waht search` och sale/purchase-loggarna behöver dem) men
      utan prisdata; `report.ts` visar prissektioner bara för patch-
      specifika och visar aldrig äldre snapshotrader för permanenta (t.ex. de
      ~8 500 raderna från 2026-09-18-testkörningen ligger kvar i DB:n men
      exponeras aldrig). Addonets inloggningssammanfattning hoppar
      permanenta items (en räkneraderad istället för ~100 rader).
    - **`healthCheck.ts`** har ett idle-läge utan patch-items: kadensreglerna
      (≥18 körningar/24h m.m.) gäller snapshot-körningar och skulle annars
      larma för evigt; istället kontrolleras att metadata-refreshen skett
      senaste 48 h. KÄNT PROBLEM: `MIN_SUCCESSFUL_RUNS = 18` stämmer inte med
      verklig kadens (uppmätt 4–9 lyckade körningar/dygn, GitHub tappar
      ticks) — health-checken kommer larma så fort patch-items finns, om
      inte tröskeln justeras då.
    - **Tunnande** (`scripts/rollupSnapshots.ts`) är ett separat, manuellt
      körbart verktyg (dry-run som standard, `--apply` för att radera),
      INTE kopplat till CI/cron; se #4 för varför det inte strider mot
      "historik raderas aldrig".

15. **Lagerkoll för crafted items (pågår, byggs stegvis).** Mål: räkna hur
    många av varje crafted item (`crafted: true` i trackedItems.json — nu
    Vial of the Sands och Sky Golem) Simon har kvar per realm-kluster
    (samma connected-realm-gruppering som "Best realm"), och flagga kluster
    som börjar ta slut. **Rapporten är huvudplatsen** (lagret är utspritt
    på 3 konton och rapporten är enda stället med en samlad överblick);
    `/waht` i spelet är en snabbkoll per karaktär. Omfattning: BARA crafted
    items, inte alla tracked.
    - **Bekräftat före bygget (2026-09-19)**: addonet gjorde INGEN
      lagerräkning förut. Categorizern listar väskinnehåll (väskor 0–4 +
      reagentväska) men läser aldrig stack counts och sparar inget om
      innehållet; sale/purchase-loggarna läser mail-*fakturarubriker*
      (`GetInboxInvoiceInfo`), aldrig bilagor; ingen bank, ingen Warband-
      bank, inga egna auktionslistningar. Alltså ny mark.
    - **Stegordning**: (1) `/waht stockprobe` (`Stock.lua`) — läser bara och
      rapporterar vad varje API faktiskt returnerar just nu, eftersom API-
      dokumentationen inte avgör t.ex. om stängd bank går att läsa; (2)
      pipeline med bara väskor (snapshot per karaktär → ny SavedVariables-
      tabell `WowAHTrackerStockDB` → ingest → rapportrad + `/waht stock`);
      (3) lägg till fler källor en i taget. `.toc` ändrades (ny fil + ny
      SavedVariables) → kräver full omstart av WoW, inte bara `/reload`.
    - **Designförslag (ej låsta)**: källor = väskor + karaktärsbank +
      egna aktiva auktionslistningar + mailbilagor (returnerade utgångna
      auktioner räknas dit); Warband-banken visas som en SEPARAT rad, aldrig
      inne i ett klusters summa (delad pool, kan inte knytas till ett
      kluster, dubbelräkning om man summerar per karaktär). Varje källa har
      egen "senast skannad"-tid; en karaktär som aldrig skannats är
      "okänd", ALDRIG 0 (falskt larm och falsk trygghet är båda dåliga).
      Tröskel: flagga när antal ≤ `low_stock_threshold` (default 0,
      konfigurerbart per item i trackedItems.json senare); flagga bara
      kluster där itemet har hållits eller sålts tidigare, annars blir det
      ~80 kluster med "0, aldrig lagrat" som brus.
    - **Integritet**: lagersiffror hör till samma kategori som intäkter
      (#13): lägg dem ALDRIG i `data.lua`/`report.ts`/något som Pages
      publicerar utan att Simon uttryckligen säger det. (Ett svar på
      lokalt-bara-frågan lästes som "rapporten är huvudplatsen", inte som
      "publicera" — tolkningen är inte bekräftad, så default = lokalt.)
      Tvärkonto-summor i spelet skulle i så fall komma från en lokalt
      genererad fil, inte via Pages.
    - **Probe-fynd (körd i spelet 2026-09-19, probe #3–#7 på <character>@<realm>,
      inga Lua-fel; #1–#2 var körda på fel karaktär och ignoreras)**:
      * Väskor är alltid läsbara live (C_Container-scan = `GetItemCount`
        default).
      * Bank: direkt containerscan ger `slots=0` för ALLA banktabbar när
        banken är stängd. Med banken öppen: `CharacterBankTab_1` 98 slots
        (flikar 2–6 = 0, ej köpta), `AccountBankTab_1–5` 98 slots vardera;
        föremålet hittades i `AccountBankTab_4`. Vid banken rapporteras
        interaktionen som `Banker`=OPEN (INTE `CharacterBanker`/
        `AccountBanker`); `C_Bank.CanViewBank` Character=true, Account=true
        bara vid banken.
      * `GetItemCount`: default = bara väskor; 2:a argumentet (`+bank`)
        karaktärsbank; 5:e argumentet (`includeAccountBank`) räknade
        Warband-föremålet (1) medan banken var öppen. Den räknar INTE
        mailbilagor eller egna auktionslistningar (mail=1 resp. AH active=1
        gav 0 i alla varianter).
      * Mail: `GetInboxItem` läser bilagor bara med öppen brevlåda ("1 of 1
        mails loaded"); stängd = "0 of 0" (stämmer med tidigare SalesLog-trace).
      * Egna auktioner: `GetOwnedAuctionInfo` ger hela listan bara med AH
        öppen (61 egna auktioner, `full results=true`, Vial Active=1);
        stängd = 0 auktioner, `full results=false`.
      * Allt stängt (probe #7) med föremålet listat på AH: allt utom
        väskor osynligt — 0 i varenda källa.
      * `Enum.BagIndex` i denna klient: Keyring=-1, Characterbanktab=-2,
        Accountbanktab=-3, CharacterBankTab_1..6 = 6..11, AccountBankTab_1..5
        = 12..16; INGEN Bank-/Reagentbank-medlem (den gamla reagentbanken
        finns inte längre). Runtime-upptäckten i proben var rätt val.
      * EJ avgjort: om `GetItemCount(+bank/+warband)` räknar banken när den
        är STÄNGD — föremålet låg aldrig i en bank vid ett stängt tillfälle
        (väska → Warband → mail → AH). Kräver en extra körning: lägg ett
        Vial i banken, stäng den, kör `/waht stockprobe`.
      * **Konsekvens**: bara väskor är live. Bank, Warband, mail och egna
        AH-listningar är ögonblicksbilder från senaste besök, var och en med
        egen tid. Ett kluster vars lager ligger på AH ser ut som "0 i
        väskor" — en pipeline med bara väskor ger alltså falska "slut"-
        flaggor; AH-listningar (fullständig lista, händelsestyrd) behövs
        redan i steg 2. AH-listningar går ut inom max 48 h och mail efter 30
        dygn, så en ögonblicksbild äldre än så räknas som okänd, inte som 0.
    - **Steg 2 byggt (godkänt av Simon 2026-09-19): väskor + egna AH-
      listningar**, tidsstämpel per källa, "okänt" för ogenomsökt/föråldrat.
      Simons lager ligger i väskor, AH och ibland post — aldrig bank/Warband-
      bank; han tömmer brevlådan vid varje inloggning tills mail-källan är
      byggd (bank och post är separata tillägg senare).
      * **Addon** (`Stock.lua`): per karaktär i `WowAHTrackerStockDB.
        characters["realm|karaktär"]` = `bags`/`auctions` `{ at, ts (unix),
        counts = { [itemId] = n } }` + `held` (någonsin hållit). Snapshoten
        listar ALLA crafted item-id med explicit 0, så "räknat 0" skiljs från
        "saknas = okänt". Väskor skannas på `BAG_UPDATE_DELAYED`
        (strypt 0,5 s med en avslutande skanning så sista ändringen aldrig
        tappas; ingen skanning om väskorna inte laddats — ingen falsk "0
        överallt"). AH-listningar sparas på `OWNED_AUCTIONS_UPDATED` bara vid
        FULLA resultat och bara Active (sålda har redan lämnat); Blizzards UI
        laddar egna auktioner först när fliken **Auctions** öppnas, och vi
        anropar INTE `QueryOwnedAuctions` själva (samma lärdom som sökrutan:
        gå aldrig runt AH-fönstrets eget state). Crafted-listan kommer från
        `crafted = true` i data.lua, med de två kända som fallback tills en
        data.lua med flaggan hämtats. `/waht stock` = per konto (rapporten
        slår ihop alla), en tyst inloggningsrad bara vid OUT/LOW.
      * **Regeln** (identisk i `Stock.lua` och `src/earnings/stock.ts` —
        ändra båda och kör om delade testfall): väskor är kända om en snapshot
        listar itemet (går aldrig ut); AH-listningar bara om snapshoten är
        ≤ 48 h; total = summan av kända delar; okänt = någon karaktär saknar
        en del (eller klustret saknar känd karaktär). Helt känt: total >
        tröskel → OK, 0 → OUT, annars LOW. Delvis okänt: total > tröskel → OK
        ("minst N"), annars UNKNOWN. Tröskel default 0 (per item senare).
        Kluster listas först när itemet hållits eller sålts där.
        Karaktärer i klustret = rosterkaraktärer + observerade; en oskannad
        rosterkaraktär gör klustret okänt (lagret kan ligga på den).
      * **DB/ingest**: `stock_observations` (insert-only historik, unik på
        konto/realm/karaktär/källa/item/observed_at → idempotent),
        `stock_held`. Stock-parsningen är isolerad: ett trasigt stockrecord
        hoppas över med varning och kan ALDRIG stoppa intäkts-ingesten.
      * **Rapport**: sektionen "Crafted-item stock" (aktuellt läge, oberoende
        av fönster/filter): status-badges OUT/LOW/UNKNOWN/OK per kluster,
        per karaktär "bags N (ålder), AH N (ålder)" eller "never scanned"/
        "stale". Klustret etiketteras med de realmer som faktiskt används.
      * **`/waht realms remove <realm>, <karaktär>`** (nytt): rostern kunde
        bara växa, så en raderad karaktär (t.ex. ExampleChar, ExampleRealm) blev kvar
        för evigt och höll sitt kluster UNKNOWN. Nås DB:n vid logout/`/reload`
        + nästa ingest (roster-snapshoten ersätts per konto).
      * **Verifierat**: 24+24+16 addon-tester i Lua-interpretator (inkl. en
        delad JSON med 17 statusfall som körs mot BÅDE Lua- och TS-regeln),
        20 ingest/parser-tester (varav en rullad-tillbaka DB-transaktion),
        visuell kontroll av rapportsektionen i riktig Chrome. EJ verifierat
        i spelet (kräver att Simon spelar) — se "Obligatoriskt sista steg".
      * **Ej pushat**: `crafted = true` i data.lua (`scripts/report.ts`) ligger
        som lokal commit tills Simon säger till; addonet fungerar utan den via
        fallback-listan.

16. **WoW Crafting Optimizer — egen modul i samma repo, egen lokal SQLite,
    byggs bottom-up (påbörjad 2026-09-20).** Beräknar billigaste sättet att
    producera crafted items (BUY / CRAFT / PROSPECT / transmute, rekursivt,
    med förklarande beslutsträd) utanför spelet. Detta är den UTTRYCKLIGA
    undantaget från "Neon Postgres" i teknikstacken — inte ett skäl att slå
    ihop databaserna eller att flytta något av synken hit.
    - **Plats**: `src/crafting/` (motor + datamodell + tester), CLI i
      `scripts/crafting.ts` (`npm run crafting -- ...`), tester med
      `npm run test:crafting` (node:test via tsx, inga nya dependencies).
      TypeScript/Node, INTE Python. Ingen Lua/addon-del, varken nu eller
      initialt.
    - **Databas**: `node:sqlite` (inbyggd, Node ≥ 22.13 — lokalt körs 24; CI
      kör Node 20 men rör aldrig modulen, så `npm ci` påverkas inte). Filen
      ligger i `data-private/crafting.sqlite` (gitignorerad, likt #13:
      Simons egna empiriska data, repot är publikt), override via
      `CRAFTING_DB_PATH`. `src/crafting/**` får ALDRIG importera
      `src/db/pool.ts` eller på annat sätt läsa/skriva Neon. Schemat
      versioneras med `PRAGMA user_version` + en append-only migrationslista
      i `src/crafting/db.ts` (redigera aldrig en levererad migration). Delad
      kod från synken (OAuth, connected-realm-upplösning) FÅR återanvändas —
      den är publik och redan verifierad — men först när marknadslagret byggs.
    - **Lager (ordning är bindande, verifiera varje lager innan nästa)**:
      1 prospecting (KLART: batches → poolad observerad yield + expected
      output), 2 transmutes/processing-operationer (generell
      INPUT→OUTPUT-modell — BYGGD 2026-09-20 med "Prospect Kyparite" som
      första instans, se "Lager 2-modellen" nedan; fyra Alchemy-transmutes
      uppsatta 2026-09-21, se "Loggade transmutes" — väntar på Simons första
      loggade körningar), 3 intermediates (BUY vs CRAFT rekursivt), 4
      slutprodukter (enkel end-to-end-produkt → Panther mounts → Engineering
      mounts → Vial of the Sands → övrigt). Marknadsdata
      (`get_ah_price(item, realm)`) är fristående från trackedItems/synk/
      health — punktuppslag on demand, inte historik.
    - **Regler som redan är låsta i koden**: (a) valuta = heltals-koppar,
      aldrig float; (b) yield = exakt reducerat bråk (`fraction.ts`), aldrig
      lagrad — alltid omräknad från råa batch-rader; (c) yield är POOLAD
      (total output / total ore), inte snitt av per-batch-rates, så en liten
      batch aldrig väger lika mycket som en stor; (d) en batch är en KOMPLETT
      post: ett item som inte anges räknas som 0 för den batchens ore
      (annars blir yielden för hög); (e) `ore_count` är total ore som
      förbrukats, inte antal casts — cast-storlek är speldata som hör till
      lager 2; (f) item-id är nyckeln, namn är bara visning — samma namn kan
      finnas under flera id (CLI vägrar tvetydiga namn); (g) ingen speldata
      hårdkodas: vilken ore som ger vilka gems kommer enbart från inmatade
      batcher; (h) `patch` är fritext-tagg med exakt matchning i filter.
    - **Lager 2-modellen (2026-09-20)**: `operations` (kind, unikt namn,
      `source` = varifrån receptfakta kommer) + `operation_inputs` +
      antingen `operation_outputs` (FASTA/sannolikhets-outputs som exakta
      bråk = FÖRVÄNTADE enheter per körning: garanterad 3 = 3/1, 1-av-5-proc
      = 1/5) eller `operation_empirical_source` (outputs härleds vid varje
      resolve ur inspelade prospecting-batcher, aldrig cachat). Exakt ett av
      de två. `resolveOperation()` returnerar inputs, förväntade outputs,
      `basis` (fixed | empirical + sample size) och `warnings` — en
      empirisk operation utan batcher ger "UNKNOWN, not zero", aldrig tysta
      nollor (motorn i lager 3+ får inte behandla det som "ger inget").
      Cast-storleken är operationens input-kvantitet (inte hårdkodad).
      `kind` valideras i koden (`OPERATION_KINDS`), inte med DB-CHECK, så ett
      nytt kind inte kräver tabellombyggnad. Uppslag mot Blizzards static-API
      (`item find` / `item fetch`) går via en injicerad `StaticGet`
      (`itemLookup.ts`) som CLI:t kopplar till synkens OAuth-klient.
    - **Verifierat mot Blizzards API 2026-09-20 (static-12.1.0-EU)**: Kyparite
      Ore heter bara "Kyparite" (item **72093**, Tradeskill/Metal & Stone,
      flaggad "Prospectable" under Pandaria Jewelcrafting = skill-tier 2520
      under profession 755). "Kyparite Fragment" (97546) är ett ANNAT item.
      Receptet "Pandaria Prospecting" (40954) har beskrivningen *"Search 5
      Pandaria ore for precious gems. This will destroy the ore"* → cast-
      storlek 5, men API:t har INGA strukturerade reagens/outputs för det och
      receptet gäller alla Pandaria-ores — vad Kyparite ger kommer bara från
      Simons batcher. Operation #1 "Prospect Kyparite" (5 × 72093,
      empirisk) ligger i Simons lokala DB, inte i repot.
    - **Första riktiga batchen inmatad 2026-09-20** (3 000 Kyparite, i den
      lokala DB:n — siffrorna hör hemma där, inte här, repot är publikt).
      Lärdomar värda att behålla: (a) `--count` måste vara ore som FAKTISKT
      förbrukats (Simon hade hittat 200 extra; en felaktig nämnare skalar
      alla yields tyst); (b) Simon bekräftar att Primal Diamond (76132, samma
      Jewelcrafting-råvara som gemsen) INTE kommer från Kyparite-prospecting
      — utelämnat item = 0 är därför korrekt där; (c) sällsynta drops (~20–30
      träffar på 600 casts) är statistiskt tunna, fler batcher poolas
      automatiskt och stabiliserar dem; (d) Blizzards
      `/data/wow/search/item` behandlar flera ord som ELLER och sorterar på
      id, så en ordagrann fraskoll måste filtreras klientsidigt
      (`searchItemsByName` söker varje ord för sig och kräver alla).
    - **Marknadslager + Crafting-flik (2026-09-20)**: tredje fliken "Crafting"
      i `reports-private/earnings.html` (lokal, ALDRIG via Pages — samma regel
      som #13; siffrorna är Simons egen analys). Kedjan: `craftingReport.ts`
      (öppnar lokala SQLite, hämtar priser, räknar) → `profit.ts` (ekonomi) →
      `flow.ts` (graf) → `flowHtml.ts` (HTML). `reportEarnings.ts` anropar det
      via `loadCraftingTab()` och är ISOLERAD: fel (ingen DB, inga
      Blizzard-uppgifter, nätverk nere) blir ett meddelande i fliken, fäller
      aldrig resten av rapporten.
      * **Flödesschema-beredskap**: fliken ritas ur en GRAF, inte direkt ur
        siffrorna — item-noder + operationsnoder, kanter = flöden med
        kvantitet och värde. Ett item som är en operations output och nästa
        operations input är EN nod, så kedjor kopplas av sig själva;
        `layerNodes()` ger kolumn per nod (kastar vid cykel). Ett riktigt
        flödesschema senare = byt bara ritaren `flowHtml.ts`; nu ritas
        kolumnerna som kort med pilar.
      * **Prismodell** (`profit.ts`, medvetet enkel och utskriven i fliken):
        INKÖP = gå uppför säljlistan från billigaste (verklig kostnad för N
        st, inte bara första styckets pris); FÖRSÄLJNING = lägsta aktuella
        listning minus AH-avgift = det OPTIMISTISKA fallet, eftersom stora
        volymer pressar priset. Saknat pris (inget listat) → beloppet blir
        OKÄNT (null), aldrig 0; samma princip som "UNKNOWN, not zero". Varje
        vara visar sina enheter som % av allt som ligger listat (nära/över
        100 % = priset håller inte); `thin`-flaggan = enheter > listat.
        Inte modellerat: deposit (återbetalas vid sälj), säljtid,
        undercutting, prisrörelse under försäljningen.
      * **AH-avgift 5 %** (`AH_FEE_RATE`) är UPPMÄTT, inte antagen: 27 av 27 av
        Simons egna sales hade `consignment` = exakt 5,00 % av försäljnings-
        priset (2026-09-20). Kolla om om avgiften någonsin ändras.
      * **Marknadsdata** (`market.ts`, fristående från synk/trackedItems/
        health): commodities prissätts EU-övergripande; hela dumpen (~380k
        rader, ~2,5 s) hämtas med en injicerad hämtare (`blizzardMarket.ts`
        kopplar synkens OAuth-klient) och filtreras till efterfrågade items.
        `market_snapshots` (insert-only, unik per item + dumpens
        Last-Modified) ger offline-fallback och en prishistorik som växer av
        sig själv. Bekräftat 2026-09-20: Kyparite och alla 13 gems finns i
        commodity-dumpen.
      * **Priserna är volatila**: Kyparite-priset per ore föll ~40 % på en
        timme mellan två hämtningar och vinsten på en 3 000-ore-batch gick
        från ungefär noll till tusentals guld. En ögonblicksbild räcker
        alltså inte som beslutsunderlag — och breakeven-priset på ore
        (visas i fliken) är det stabilare måttet.
      * **Öppet / ej byggt**: trend/prishistorik i fliken, känslighet ("vinst
        utan största posten"), en mer konservativ försäljningsmodell,
        icke-commodity-items per realm, fler operationer i samma flöde.
    - **Perspektiv: Simon är CRAFTARE (bekräftat 2026-09-20) — nästa modellsteg
      är BUY vs PROSPECT per gem han behöver, inte "vinst på att sälja"**.
      Han köper i större utsträckning än han säljer på den här typen av items,
      så AH-avgiften är i det här skedet underordnad (den finns kvar i
      `profit.ts` men är inte huvudmåttet). Frågan är: är det billigare att
      köpa Kyparite och prospecta än att köpa gemsen direkt, och hur mycket?
      * **Kärnproblemet är gemensamma produkter (joint products)**: en cast ger
        ~13 olika gems på en gång, så "vad kostar en Sunstone via prospecting"
        beror på vad man gör med resten. Två gränser, båda beräknade
        2026-09-20 mot live-priser (engångsuträkning, ingen kod levererad):
        (a) HELA ore-kostnaden på ett gem (biprodukter värda 0) = mycket dyrare
        än att köpa direkt för nästan alla gems; (b) biprodukterna krediterade
        till lägsta pris = "gratis" för nästan alla, och bara Sunstone blir
        ett verkligt tal (≈ 10,7 g mot ≈ 30 g att köpa). Slutsats: prospecting
        lönar sig för en craftare bara om man faktiskt använder/säljer HELA
        utfallet; för ett enstaka gem är direkt-köp nästan alltid billigare,
        med Sunstone som undantag.
      * **Beslut som måste tas med Simon innan bygget (ÖPPET)**: hur
        biprodukter ska värderas — (1) som besparing (du hade annars köpt dem
        till lägsta pris, avgift irrelevant), (2) som försäljning (avgift,
        undercut, tunn marknad spelar in), eller (3) användarvald policy per
        gem ("behöver jag den / säljer jag den / ignorerar jag den"). Alla tre
        ger olika svar; välj inte tyst. Krediteringen till lägsta pris är den
        OPTIMISTISKA gränsen (tunna marknader, se Crafting-fliken).
      * Passar redan i strukturen: `get_cheapest_cost(item)` = min(BUY,
        PROSPECT-via-Kyparite, ...) med förklarande träd; en operation med
        flera outputs behöver en explicit allokeringsregel (ovan).
    - **Loggade transmutes (2026-09-21)**: fyra operationer uppsatta, vars
      utfall Simon loggar empiriskt istället för att anta en fast kvot.
      * **Verifierat mot Blizzards API 2026-09-21** (Pandaria Alchemy, skill-
        tier 2481, kategori Transmutation; strukturerade reagens, hela tieren
        skannad): `Transmute: Sun's Radiance` (recept 26015) = 1 Sunstone
        (76134) + 1 Golden Lotus (72238) → Sun's Radiance (76142);
        `Transmute: River's Heart` (26008) = 1 Lapis Lazuli (76133) + 1 Golden
        Lotus → River's Heart (76138); `Transmute: Primordial Ruby` (26021) =
        1 Pandarian Garnet (76136) + 1 Golden Lotus → Primordial Ruby (76131);
        `Transmute: Wild Jade` (26009) = 1 Alexandrite (76137) + 1 Golden Lotus
        → Wild Jade (76139). API:t anger nominell producerad kvantitet 1 för
        alla; det är referens, INTE inlagt som fakta — utfallet är okänt tills
        Simon loggat körningar. Golden Lotus = item 72238 (Herb).
        Operationerna ligger i Simons lokala DB (#2–#5), inte i repot.
        Blizzard listar två transmutes till (Roguestone → Imperial Amethyst,
        Tiger Opal → Vermilion Onyx); inte uppsatta, alla fyra gems där är
        sådana Simon ignorerar.
      * **Varför körningar per OPERATION, inte prospecting-batcher**: batcherna
        är nycklade på ETT ore-item; en transmute har två inputs, och samma
        item (Sunstone) är både prospecting-output och transmute-input, så en
        ore-nyckel hade blandat ihop olika saker. Nytt (schema v5):
        `operation_runs` + `operation_run_outputs` (`runs.ts`), och
        `operation_run_source` markerar att en operation tar sina outputs från
        egna körningar (`op add --from-runs`, `OperationInput.fromRuns`,
        `basis.type = "empirical-runs"`). Yield = poolad (total output / total
        executions), aldrig snitt av rates; en körning är en KOMPLETT post
        (ej angivet item = 0). CLI: `run add --op <id|namn> --count <antal
        gånger> --got <item>:<antal> ...`, `run list`, `run remove`.
      * **Körningar raderas aldrig av misstag**: ingen kaskad från operations,
        så `op remove` vägras så länge operationen har loggade körningar (de
        är oersättliga observationer, samma princip som batcherna). En körning
        kan bara loggas mot en operation som har `--from-runs` (annars vore det
        en tyst no-op).
      * **Okänt tills data finns**: en operation utan körningar ger inga
        outputs och en varning ("UNKNOWN, not zero"); ingen 1:1 antas.
        Crafting-fliken lägger sådana operationer i en egen lista "Waiting for
        data" istället för i sammanfattning/flöde (annars fylls den med
        "vad om jag körde 600 gånger"-brus och `unknown`-rader), och
        `cheapest` säger vilka operationer som inte kunde jämföras.
      * `cheapest` döper alternativet efter operationens slag (PROSPECT /
        TRANSMUTE / CRAFT), och skriver en kostnad ≤ 0 som "free (de andra
        outputs täcker inputs med X per enhet)" istället för ett negativt pris.
      * **Flödesfixar**: in- och utflöde för ett item som en operation gör och
        en annan förbrukar redovisas separat ("made: … / used: …") — de får
        inte adderas mot marknadens utbud.
      * **Känd begränsning (ÖPPET, nästa steg)**: varje operation storleksätts
        fristående (600 körningar). I en verklig kedja (Kyparite → Sunstone →
        Sun's Radiance) borde transmutens mängd styras av vad prospectingen
        faktiskt ger, och en transmutes input-kostnad för Sunstone borde vara
        min(köp, prospect) — det är lager 3 (rekursivt BUY vs CRAFT vs
        PROSPECT), inte byggt än.
    - **Living Steel-kedjan och rekursiv sourcing (2026-09-21, byggt)**: en
      kedja i tre led där Trillium Bar har flera konkurrerande vägar innan
      Living Steel ens kommer in.
      * **Verifierat mot Blizzards API 2026-09-21** (skannat: Pandaria Mining,
        Alchemy, Blacksmithing, Engineering, Jewelcrafting; strukturerade
        reagens). Item: Ghost Iron Ore 72092, Ghost Iron Bar 72096, Black
        Trillium Ore 72094, White Trillium Ore 72103, Trillium Bar 72095,
        Spirit of Harmony 76061, Living Steel 72104. Recept: `Smelt Ghost Iron`
        (24591) 2 ore → 1 bar; `Smelt Trillium` (24589) 2 Black + 2 White → 1
        Trillium Bar; `Transmute: Trillium Bar` (26020) 10 Ghost Iron Bar → 1;
        `Riddle of Steel` (27385) 3 Trillium Bar + 3 Spirit of Harmony → 1
        Living Steel. **Namnfälla**: receptet med Spirit of Harmony heter
        "Riddle of Steel" i Blizzards data; det riktiga "Transmute: Living
        Steel" (26017) är ett ANNAT recept, 6 Trillium Bar → 1 Living Steel
        (inga Spirit), en tredje väg som MEDVETET INTE är uppsatt och inte ska
        sättas upp: den har en daglig cooldown (Blizzards egen beskrivning:
        "Transmutations of this magnitude can only be done once each day") och
        går därför inte att lita på för mass-crafting. Riddle of Steel har ingen
        (beskrivningen: att använda Spirits of Harmony "does not tax the
        alchemist, allowing them to ignore the normal one day of rest") och är
        det ENDA Living Steel-recept Simon vill använda — verifierat 2026-09-21
        mot API:t; besluten är Simons. Operationen behåller därför namnet
        "Riddle of Steel" (Blizzards eget, entydigt). Lägg inte till cooldown-
        receptet som konkurrent i `procure`/`chain`.
        Operationerna ligger under Blizzards receptnamn i Simons lokala DB
        (#6–#9); transmutes med `--from-runs` (yield okänd tills loggad,
        nominellt 1 enligt API:t), smältorna som `craft` med fast utfall.
      * **Policy**: `need` på Ghost Iron Bar, Trillium Bar och Living Steel.
        För mellanprodukter påverkar policyn bara hur ÖVERBLIVNA enheter
        värderas i `chain` (procure använder ingen policy): `need` = vad det
        skulle kosta att köpa dem, vilket är rimligt bara om Simon faktiskt
        skulle använda dem; annars är `sell` (netto efter AH-avgift) ärligare.
      * **`procure.ts` (rekursiv sourcing)**: billigaste sättet att få N st av ett
        item när VARJE input i varje väg åter kan köpas ELLER tillverkas, hela
        vägen ner (t.ex. en transmute använder automatiskt en smälts kostnad
        för sina inputs när det är billigare än att köpa). Varje nod prissätts
        på den mängd den faktiskt behöver (att köpa mer går uppför säljlistan,
        så tillverkning vinner i större skala); vid exakt lika vinner köp (inget
        arbete). Avsiktliga förenklingar: EN källa per item (ingen "köp 40,
        tillverka resten"); bara enkel-output-operationer deltar (multi-output
        som prospecting saknar pris per item och hör till `chain`, listas som
        "left out"); operation utan loggad data vet inte vad den ger, hoppas
        över och namnges; cykler stoppas (ett item som är sin egen förfader kan
        bara köpas). `cheapest <item> [--units N]` svarar nu med detta träd (med
        vad alternativen hade kostat vid varje nod), och visar joint-routes som
        ren information. Tidigare prissatte `cheapest` en routes inputs som köpta
        på AH och `chain` köpte allt det inte höll — ingen av dem kunde välja
        köp/tillverka för en INPUT, därav generaliseringen innan layouten låstes.
      * **Layoutbeslut i Crafting-fliken**: när det finns en kedja visas bara
        dess operationer i sammanfattning/flöde/per-gem-tabell; behov (`need`)
        som kedjan inte gör får en egen sektion "Sourcing: buy it or make it"
        med träden (`SOURCING_UNITS` = 100). Skälet: en operation utanför
        kedjan har ingen naturlig storlek (att prissätta "600 smältningar"
        gav t.ex. ett absurt förlusttal); frågan för den är per-enhet-köp-eller-
        tillverka, alltså trädet.
      * **Fortfarande öppet**: mixad sourcing (köp en del, tillverka resten);
        `chain` (framåt) och `procure` (bakåt) är separata verktyg — en
        målstyrd plan för hela Living Steel-kedjan från råmaterial vore nästa
        steg; `chain` kräver att operationer skapats uppströms först;
        prisgränsen mot skräplistningar (se kedjeavsnittet) är införd och
        gäller även här.
    - **Kedjan: hela flödet Kyparite → gems → transmutes (2026-09-21, byggt)**:
      Simons egentliga fråga är inte "lönar transmute X" utan "vad kostar
      3 000 Kyparite + de Golden Lotus som går åt, jämfört med vad det hade
      kostat att köpa gemsen jag slutar med" — han säljer inget på AH förrän
      mounts är klara, så allt värderas som undvikna inköp (`need`).
      * **`chain.ts`**: `planChain` (förväntade värden, exakta bråk) köper rotens
        inputs, håller dess outputs, och låter varje övrig operation förbruka
        vad man håller av dess inputs (så många körningar som den knappaste
        hållna inputen räcker till; inputs man inte håller — Golden Lotus —
        köps). `evaluateChain` värderar: kostnad = inköpen uppför säljlistan,
        värde = slutinnehavet efter policy (need = vad det kostar att köpa så
        många), `saving = värde − kostnad`, break-even-pris på rotens input, och
        varje stegs BIDRAG = kedjans besparing med steget minus utan det
        (leave-one-out) — så ett förlustsbringande steg syns för sig (Sunstone →
        Sun's Radiance var det i första körningen: input dyrare än gemet).
        Operationer tillämpas i given ordning, en gång (uppströms först);
        operationer utan data eller utan något att köra på hoppas över och
        listas som varningar. CLI: `npm run crafting -- chain [--ore N]
        [--root <op>]`; fliken har sektionen "The whole chain" överst.
      * **Verifierat**: kedjans siffror från en generell, testad modell stämde
        exakt med en oberoende engångsräkning från de loggade sessionerna
        (kostnad, värde, besparing, break-even och alla stegbidrag). Utfallet
        av transmutes visade sig vara >1 per craft (proc), därför loggas det
        istället för att antas.
      * **`cheapest` omskriven**: jämför varje väg direkt mot att köpa SAMMA antal
        enheter (tidigare prissattes köp- och operationssidan i olika storlek
        och gav nonsens som "prospecting är gratis"). Enkelroutes
        (transmute/craft, en enda output) är jämförbara och de enda som
        rekommenderas; gemensamma-produkt-routes (prospecting, många outputs)
        visas för information men rekommenderas ALDRIG på egen hand, eftersom
        priset på en enskild gem där beror på vad biprodukterna är värda —
        den ärliga jämförelsen är hela kedjan. Enkelroutes storleksätts efter
        `--units` (default 100), multi-output efter `--executions` (default
        600 = en riktig batch). `verdict`: route / buy / unknown.
      * **Flik-storlekar**: den första operationen storleksätts efter
        `executions` (600 = 3 000 ore), varje vidare steg efter vad kedjan ger
        det att jobba på (annars prissattes t.ex. 600 transmutes mot en tunn
        marknad och "värdet" blev absurda 5–6-siffriga belopp).
      * **Skräplistningar — LÖST 2026-09-21 (`MAX_PRICE_MULTIPLE` i
        `market.ts`)**: prislistorna slutar ofta i en handfull platshållar-
        listningar (200 g, ~2 000 g, ~50 000 g mot ett verkligt pris på ~12 g).
        När utbudet krympte mellan två dumpar räckte de riktiga listningarna
        inte till, "köp så många" klättrade upp i skräpet och rapporten visade
        en helkedjebesparing på hundratusentals guld (verkligt: ett par
        tusen, alltså en faktor ~300 fel). Nu räknas bara
        listningar upp till 3 × det gängse priset (priset där de första ~5
        enheterna nås, inte den enskilt billigaste, så en låg utstickare inte
        krymper taket): `listedQuantity` och `walkBook` använder taket, resten
        är ett SHORTFALL ("marknaden kan inte leverera så många till rimligt
        pris") → värdet blir en flaggad NEDRE GRÄNS, inköpet blir okänt,
        `procure` ser köp som ej genomförbart. Gäller överallt (chain,
        procure, sourcing, tunn-marknad-flaggan). Kedjan antar dessutom att
        ALLA hållna input-gems transmuteras; en "bara de lönsamma stegen"-plan
        (hoppa över steg med negativt bidrag) är enkel att lägga till.
    - **"Är det värt att crafta?" — verdiktet, uppifrån och ner (2026-09-21,
      byggt)**: Simons fråga är beslutsvänd: FÖRST "är Living Steel värt att
      crafta?", och BARA om ja: "är Trillium Bar värt att crafta, och hur?" —
      en mellanprodukt vill man ha för slutproduktens skull, så köper man
      slutprodukten finns det 0 mening med att crafta mellanprodukten (åtminstone
      tills något nytt recept använder den).
      * **`verdict.ts`**: `decide()` gör om procure-trädet till ett ja/nej per
        nod: köp eller crafta, hur mycket billigare/dyrare (kr och %), VAD SOM
        SKULLE VÄNDA DET (priset på itemet själv och på de två största
        inputs vid vilket craft = köp; linjära uppskattningar med allt annat
        fixt — avsedda att visa hur knapp det är, inte exakta), och rekursiv
        "och hur?" för inputs BARA längs den valda craft-vägen. Är svaret
        "köp" listas mellanprodukterna som onödiga (`notNeeded`), med vilka
        andra operationer som använder dem: används de av något annat är det
        en annan sak ("kan ändå vara värt att ha för det").
      * **`describeVerdict`** ger orden en gång, så CLI och rapport aldrig
        kan säga emot varandra. CLI: `npm run crafting -- worth <item>
        [--units N]`. Fliken: sourcing-sektionen har "Worth crafting? YES/NO"
        överst i varje träd.
      * **Transitivt** (`pointlessInputs` + `onlyFor` i rapporten): en
        mellanprodukt som bara finns för att mata något Simon hellre köper
        FRÅGAS INTE ALLS i fliken ("Not asked: it is only needed to make X"),
        och det gäller även det som bara matar den mellanprodukten, hela
        vägen ner (Trillium Bar OCH Ghost Iron Bar när Living Steel köps).
        Slutprodukterna visas först.
      * **Beslutet är prisberoende och nära**: med två dumpar två timmar isär
        vände Trillium Bar-transmuten från 1,5 % dyrare än köp till 7,7 %
        billigare, medan Living Steel förblev "köp" (~11 % dyrare att crafta,
        drivet av Spirit of Harmony ~60 % av kostnaden). Tolka det som ett
        läge, inte en dom; break-even-priserna i verdiktet är det stabila.
    - **Buy vs prospect / biprodukt-policy (2026-09-21, byggt)**: per item en
      policy i den LOKALA crafting-DB:n (`item_policy`, schema v4, `policy.ts`;
      CLI `policy set|list|clear`): **need** = används i egna crafts, värd =
      vad det skulle kosta att köpa så många (går uppför säljlistan; AH-avgift
      irrelevant); **sell** = lägsta pris minus AH-avgift; **ignore** = 0.
      Ingen policy = OKÄNT (aldrig gissat, samma princip som "unknown, not
      zero"). Simons val 2026-09-21: 9 gems `need` (Sparkling Shard, Primordial
      Ruby, Lapis Lazuli, Sunstone, Pandarian Garnet, Alexandrite, River's
      Heart, Wild Jade, Sun's Radiance), 4 `ignore` (Tiger Opal, Roguestone,
      Vermilion Onyx, Imperial Amethyst), inga `sell`.
      * **`sourcing.ts`**: `saving = värdet av allt operationen ger (efter
        policy) − kostnaden för inputs`; >0 = "cheaper to run", ≤0 = "cheaper
        to buy" (lika = köp, ingen vinning), null = okänt. Break-even-pris för
        input = totalvärde / inputmängd. Bråkdelar av enheter (förväntade
        yields är sällan heltal) köps exakt: hela enheterna uppför listan +
        resten till nästa enhets pris (`walkBookFractional`); kan marknaden
        inte leverera allt blir värdet en NEDRE GRÄNS och flaggas.
      * **`cheapest.ts` = `get_cheapest_cost(item)`**: BUY mot PROSPECT (en
        option per operation som ger itemet), jämfört i batchskala, med ett
        förklarande träd (köp inputs, kredit per biprodukt efter policy,
        nettokostnad). CLI: `npm run crafting -- cheapest <item>`.
      * **Designfälla som hittades vid visuell kontroll**: kostnaden per gem
        "om övriga krediteras" (`effectiveUnitCost`) blir `free` för nästan alla
        gems, eftersom EN dyr gem (Sunstone) ensam kan täcka ore-kostnaden — och
        varje rad använder hela besparingen (dubbelräkning). Flik-tabellen
        visar därför istället **ore-kostnaden delad efter värde**
        (`allocatedCost`): raderna summerar till totalen och `Share of value`
        visar hur mycket resultatet vilar på en enda gem. `effectiveUnitCost`
        finns kvar för `cheapest` (frågan "hur billigt får jag just den här"),
        med en varningsrad om att biprodukterna måste användas/säljas på riktigt.
      * **Kända begränsningar (ÖPPET)**: `need` värderas som obegränsad
        användning — en batch ger gems i fasta proportioner, och enheter utöver
        vad Simon faktiskt använder är bara värda försäljningspris. Mängd per
        gem ("behöver ~20 per craft") vore nästa förfining. Resultatet är också
        priskänsligt: i första körningen stod Sunstone för ~46 % av värdet.
      * `formatGold` avrundar nu till närmaste silver (tidigare kapades det:
        10,7696 g visades 10,76).
    - **Backup av crafting-DB:n (2026-09-21)**: Simons prospecting-batcher är
      oersättliga observationer och ligger i EN gitignorerad fil, så de
      backas upp (`src/crafting/backup.ts`, `npm run crafting -- backup
      create|list|verify|restore`).
      * Backupen görs med `VACUUM INTO` (konsekvent ögonblicksbild, inte en
        filkopia mitt i en skrivning) och VERIFIERAS innan något ersätts
        eller gallras: integrity_check + radantal per tabell + schemaversion
        mot källan. Fallerar verifieringen kastas fel och ingen gammal backup
        rörs.
      * **Varje backup är en egen tidsstämplad fil** (`crafting-YYYY-MM-DD-
        HHMMSS.sqlite` i `data-private/backups/`). En första design med en fil
        per dag övergavs: den automatiska backupen efter varje ändring skrev
        då över dagens fil, så ett misstag (t.ex. fel `prospect remove`) kunde
        ta bort det goda tillståndet från just innan. Gallring: ALLT från
        senaste 24 h, därefter den senaste per kalenderdag i 30 dagar.
      * **Automatisk backup efter varje datandrande kommando** (`item add/
        fetch`, `op add/remove`, `prospect add/remove`) — det är då nya
        observationer finns — samt som sista steg i `Push-Earnings.ps1`
        (best-effort, fäller aldrig pushen). Ett misslyckat auto-backup ger
        en varning men ångrar inte ändringen.
      * **`backup restore <fil> --yes`** ersätter den levande DB:n med en
        verifierad backup; den ersatta DB:n sparas först som
        `crafting-pre-restore-<tid>.sqlite`, så en felaktig återställning kan
        ångras. Utan `--yes` görs ingenting. DB:n får inte vara öppen i
        annat program.
      * **En kopia på samma disk skyddar bara mot korruption och misstag, inte
        mot förlorad disk.** `CRAFTING_BACKUP_EXTRA_DIR` (i `.env`, lokal)
        kopierar varje backup även till en annan enhet/molnmapp; av = ingen
        extern kopia. Att välja mapp laddar upp datan till molnet och är
        Simons val, inte något att slå på tyst.
      * **Satt 2026-09-21: Google Drive**, `G:\Min enhet\wow-ah-tracker-backups`
        (egen undermapp; Simon föredrar Google Drive, inget annat i projektet
        använder OneDrive). Mappen verifierades finnas innan `.env` ändrades;
        provkörd: kopian är byte-identisk med den lokala och verifierar OK.
        Värdet ligger i den lokala `.env` (gitignorerad), inte i koden.
        Fallgrop: `npm run ... -- backup verify "<sökväg med mellanslag>"`
        splittras av npm på Windows — kör `npx tsx scripts/crafting.ts backup
        verify "<sökväg>"` direkt, eller ange bara filnamn (söks i den lokala
        backupmappen).
    - **Realm-scope (avgjort 2026-09-20)**: motorn jobbar på connected-realm-
      nivå. De 81 relevanta klustren = de connected realms där Simons rostrade
      karaktärer (`/waht realms` → `roster_characters`) finns — INTE en
      handskriven lista och INTE en locale-filtrering. Verifierat mot Neon
      2026-09-20: 81 rosterkaraktärer → 81 olika kluster, 0 med oupplöst
      `connected_realm_id`, av 92 totalt. Datalagret får känna till alla 92.
      Mekanismen som hämtar listan in i SQLite är ÖPPEN (fråga innan bygge):
      en enkel read-only-export av kluster-ID:n är rimlig, men modulen får
      inte skriva till Neon eller ha en löpande koppling dit. Rostern
      växer/krymper (`/waht realms remove`) → talet 81 är ett ögonblick,
      lita på rostern, inte på siffran.
    - **Commodities prissätts EU-övergripande, inte per realm** (bekräftat av
      Simon, se README) — realm-jämförelse av produktionskostnad ger bara
      skillnad för icke-commodity-items.
    - **Avgjorda frågor**: (1) prospecting-yield beror INTE på secondary
      stats för de aktuella (gamla) craftsen → ingen stat-tagg behövs nu;
      `patch` + `note` räcker. Gäller om det någonsin tillkommer
      stat-beroende recept: ompröva då. (2) Items med olika kvalitetsnivå
      (olika item-id) modelleras som SEPARATA recept när den dagen kommer —
      mats är inte identiska mellan nivåerna, så ingen särskild logik för
      "samma namn, olika nivå" behövs i receptmodellen.
    - **Fortfarande öppet / måste verifieras innan nästa steg** (hitta inte
      på): Kyparites verkliga gem-yields (kräver Simons batcher), vilka
      transmutes som ska in först och deras input/output/sannolikheter —
      fråga Simon, hitta aldrig på speldata.

17. **Patch-specifik gear spåras per ilvl, inte per bas-id (pågår, steg 1
    av 2).** Bakgrund 2026-09-21: samma bas-item (t.ex. Crushing Coiler
    Coif, 271441) säljs i många varianter under SAMMA item-id, och
    varianterna prissätts mycket olika (heroic-stegen 12841/12842/12843:
    ~25 900 / ~31 000 / ~60 000 g). Simon bryr sig bara om **item level**,
    inte om sekundärstats/socklar/övriga bonus-id:n.
    - **Vad AH-API:t ger**: bara `bonus_lists`/`modifiers`/`context`, aldrig
      ilvl. Skillnaden mellan heroic-varianterna är ETT upgrade-steg-id;
      dessutom fragmenterar extra id:n (6652 mot 40–43, 13695 mot 13696)
      samma variant i flera exakta mängder — exakt mängd-matchning på hela
      `bonus_lists` fungerar alltså inte. Det finns ingen bonus-id→ilvl-
      tabell i Blizzards API (och externa källor bryter mot "bara Blizzard").
      Mappningen ilvl → id:n lärs därför in från Simons egna exporter (se
      nedan) och läggs sedan i trackedItems.json (steg 2, EJ byggt).
    - **Steg 1 (byggt 2026-09-21, verifierat i spelet samma dag: Simon
      bekräftade att hjälmarna nu visas som separata ilvl-rader; `+S`/
      export är inte separat återrapporterade)**. OBS installationen:
      WoW läser en SEPARAT kopia i `…\_retail_\Interface\AddOns\WowAHTracker`,
      inte repot — en ändring i `addon/` gör ingenting i spelet förrän den
      filen kopierats dit (första försöket missade det, Simon såg oförändrat
      beteende):
      `Categorizer.lua` delar upp gear per ilvl i bag-kolumnen
      (`GetDetailedItemLevelInfo`; gear = vapen/rustning med equip-slot;
      övrigt har inga varianter). `+S` på gear lägger till EXAKT den ilvl:en
      (nyckel `"id@ilvl"` i `WowAHTrackerCategorizerDB.patchSpecific`);
      `+P` förblir bas-id (permanent). En äldre bas-post utan ilvl täcker
      alla ilvl och visas som `[any ilvl]` så Simon kan ta bort den och
      lägga till per ilvl. Exporten har nya fält `ilvl=` och `bonus=` samt
      en `# Bags`-sektion med ALLA väskitems (antal + `staged=`) så de kan
      jämföras mot `config/trackedItems.json` (den lista synken använder).
      Testat i Lua-interpretator (34 kontroller); saknar spelverifiering.
    - **Steg 2 (ej påbörjat, fråga Simon först)**: `variants` i
      trackedItems.json, synk-matchning mot en trimmad kärn-mängd av
      bonus-id:n ("innehåller alla", mest specifik vinner), nullable
      variantkolumn via bakåtkompatibel migrering, per-variant rapport/
      `data.lua`. Körs sedan med "första patch-specifika itemet"-
      verifieringen ovan.

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
  search <namn>` slår upp ett bevakat item och driver
  `AuctionHouseFrame.SearchBar:SetSearchText()` + `:StartSearch()`
  (se "Låst lärdom" nedan för varför — ALDRIG en rak
  C_AuctionHouse-anrop) — kollar explicit att AH-fönstret är öppet
  innan anropet, annars ett tydligt felmeddelande istället för ett
  tyst no-op. Allt hanterar saknad/nil `WowAhTrackerData` utan
  Lua-fel.
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
- **"Sync now"-genväg** (byggt 2026-09-14): `scripts/windows/SyncNow.ps1`
  — för precis innan en spelsession, istället för att hoppas att
  bakgrunds-`*/15`-schemat råkat triggat nyligen. Triggar
  `gh workflow run sync.yml` (återanvänder samma `gh`-CLI-inloggning som
  redan finns på maskinen — ingen ny token), hittar den specifika
  dispatch:ade körningen (matchar på `event=workflow_dispatch` +
  `createdAt`, så en samtidigt köad schemalagd körning — de kan inte
  köra parallellt pga `concurrency`-gruppen i `sync.yml` — aldrig
  förväxlas med vår), pollar tills den körningen är `completed` (inte
  `data.lua`s `generatedAt` — se fynd 4 i
  docs/sync-pipeline-review-2026-09-14.md: `generatedAt` puttas vid
  *varje* körning inklusive självspärrade no-ops, så det skulle rapportera
  "klart" nästan direkt även när ingen ny prisdata hämtats), kör sedan
  `Fetch-DataLua.ps1` oavsett `conclusion` (en misslyckad synk lämnar
  ändå en giltig, redan publicerad `data.lua` att hämta). Timeout 180s
  med tydligt meddelande, inte oändlig hängning.
  En `.lnk`-genväg finns på skrivbordet
  (`WoW AH Tracker - Sync Now.lnk`) — pinning till Aktivitetsfältet är
  ett manuellt högerklicks-steg, Windows tillåter inte fullt
  skriptstyrd pinning.
  Verifierat end-to-end, inte bara att koden ser rimlig ut: en riktig
  körning triggades (run-ID syns i Actions), självspärrades internt
  (senaste riktiga synk var 26 min gammal) men rapporterades ändå
  korrekt som lyckad, och `Fetch-DataLua.ps1` hämtade ner den redan
  publicerade `data.lua` — bekräftat genom att jämföra `generatedAt`
  (färsk, från denna körning) mot per-item `capturedAt` (26 min äldre,
  den faktiska senaste riktiga synken), exakt den distinktion skriptet
  är byggt för att aldrig blanda ihop.
  **Uppdaterad 2026-09-14: knappen tvingar nu alltid fram en riktig
  hämtning.** Simon ville ha genuint färska priser varje gång han
  trycker, även om Blizzards API hunnit tickat om bara några minuter
  efter senaste synk — API-lasten (~93 anrop/körning) är trivial även
  vid flera tryck i timmen. `runFullSync(force)`: när `true` hoppas
  55-minuters-spärren över helt (loggar explicit "Forced sync via
  manual trigger - bypassing self-throttle"). `sync.yml` har ett typat
  `workflow_dispatch`-input (`force`, default `false`) som trådas
  igenom som `FORCE_SYNC` via `github.event.inputs.force || 'false'`
  — `|| 'false'` krävs eftersom `github.event.inputs` inte existerar
  alls på en schemalagd körning. `SyncNow.ps1` dispatchar med
  `-f force=true`; bakgrunds-`*/15`-schemat och en eventuell extern
  pinger (se docs/external-pinger-setup.md om den sätts upp) fortsätter
  respektera spärren precis som förut — bara den manuella vägen ändrades.
  Det gör också att skriptets "success, data.lua updated"-meddelande nu
  alltid stämmer (en forcerad körning garanterar en riktig hämtning) —
  ingen separat "ärlig meddelande-hantering" för det självspärrade
  fallet behövs längre för just den här knappen.
  Verifierat i skarp CI, inte bara lokalt: två forcerade körningar ~6
  min isär gav båda "Forced sync..." i loggen och `captured_at` som
  faktiskt gick framåt (19:45:52 → 19:51:32) — inte bara `generatedAt`.
  En efterföljande dispatch utan `force` (simulerar en vanlig
  schemalagd tick) hoppade korrekt över synken ("last successful run
  was 2min ago"), vilket bekräftar att default-`false` fungerar även
  när inputet saknas helt, inte bara när det är explicit `false`.
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
- **Lokal HTML-nettorapport — delvis byggd (se #13)**: intäktsrapporten
  finns (`npm run report:earnings`: netto per tidsfönster, per konto, per
  populationstier, bästa realm). Kvar att bygga, fråga först: vinst
  (sälj minus köp) per item/totalt och koppling mellan köp och sälj av
  samma vara.
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

**Efter #14 (2026-09-19) — vad som INTE kan verifieras i skarp CI än**:
synken är idle by design (inga patch-specifika items), så en schemalagd
körning gör i praktiken bara en 20-timmars metadata-refresh eller ett
"idle-skip". Verifierat i skarp CI: idle-skip (schemalagd tick 2026-09-19
10:52Z, run 35438557780), metadata-refresh (forcerad dispatch,
92/92 realmer), idle-läget i `health.yml`. INTE verifierat i CI sedan
refaktoreringen: (1) själva snapshot-vägen (`commitRun` med delade
helpers) — den är bara körd lokalt mot skarp DB med två temporärt
patch-flaggade items (run 52, 132 rader, health grön i icke-idle-läge);
(2) en metadata-refresh som utlöses av *schemat* (≥20 h efter förra) och
inte av en forcerad dispatch. **Första gången ett patch-specifikt item
läggs till**: pusha, kör `gh workflow run sync.yml -f force=true` och
bekräfta i loggen att `Sync run N OK ... rows=<>0` skrivs (inte
idle-raden), att `price_snapshots` bara växer för just de items, att
deploy går grön och att `npm run health` (icke-idle) går grön; kolla sedan
nästa schemalagda tick. Gör inte detta blint innan dess — det finns
inget patch-item att köra det mot.

**Addon/spelkod är ett specialfall**: `gh run list` säger ingenting om
kod som körs i WoW-klienten. Ett addon eller ändring av det är ALDRIG
"klart" förrän spelaren själv har startat om WoW eller kört `/reload`,
beskrivit exakt vad som hände i chatten (eller inte hände), och du har
fått den återkopplingen — anta aldrig att Lua-koden fungerar bara för
att den parsar syntaktiskt (verifierat lokalt med `luaparse`, som bara
fångar syntaxfel, inte fel API-namn/enum-medlemmar/runtime-fel).
