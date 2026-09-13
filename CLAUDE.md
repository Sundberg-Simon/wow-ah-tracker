# Projekt: wow-ah-tracker

## Vad detta är
En personlig, EU-only WoW auction house-pristracker för en liten uppsättning
bevakade items (ren flipping — köp/sälj via AH, ingen crafting inblandad).
En självbyggd, nedskalad ersättare till undermine.exchange, sedan den
tjänsten gick över till en betalversion.

## Nuvarande fas
Milestone 1 och 2 klara och verifierade mot skarp data. Projektet är live:
privat GitHub-repo, hourly GitHub Actions-workflow bekräftad fungerande
end-to-end (ett schemalagt pass har skrivit en riktig rad i DB:n),
secrets konfigurerade. [Uppdatera den här raden manuellt allt eftersom.]

## Teknikstack — håll dig till detta, föreslå inte alternativ utan att fråga
- Språk/runtime: TypeScript / Node.js (sync-jobb + query-helpers)
- Körning: GitHub Actions (cron, en gång i timmen) — INTE en lokal
  scheduler. Kontinuerlig historik är hela poängen med projektet, och en
  lokal scheduler skulle ge hål i datan varje gång datorn är av/sover.
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

## Vad som är byggt och verifierat hittills
- **Milestone 1**: OAuth-token, connected-realm-upplösning, per-realm-
  och commodity-filtrering mot riktiga item-ID:n (128671, 72145 m.fl.) —
  verifierat mot skarpt API.
- **Milestone 2**: Postgres-schema applicerat på Neon, full sync-loop
  över alla 92 EU connected realms + commodities i en körning (184 rader
  i en pass), query-helper verifierad (t.ex. EU-wide min-pris/kvantitet
  för ett item).
- **Live**: GitHub-repo (github.com/Sundberg-Simon/wow-ah-tracker,
  privat), hourly workflow (.github/workflows/sync.yml, `5 * * * *` +
  manual workflow_dispatch), secrets satta via `gh` CLI. Ett skarpt
  schemalagt pass har körts och skrivit en verifierad rad i DB:n.

## Vad vi medvetet skjuter upp (fråga innan du bygger något av detta)
- **In-game-addon**: en companion-app synkar bevakad prisdata ner till en
  lokal fil; addonet läser den + `GetRealmName()` vid login och visar en
  alert om något bevakat item ser bra ut på den realmen. Sökning i AH
  triggas direkt via `C_AuctionHouse.SendSearchQuery`/`SendBrowseQuery`
  när spelaren klickar, inte via kopiera-klistra (Lua-addons har ingen
  OS-clipboard-åtkomst).
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
[Fyll i det här när det finns en tydlig verifieringsrutin — t.ex. "kolla
att GitHub Actions-körningen faktiskt lyckades i Actions-fliken, inte
bara att pushen gick igenom" eller motsvarande för den här projekttypen.]
