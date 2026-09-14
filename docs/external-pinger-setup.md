# wow-ah-tracker — extern pinger (framtida förbättring, ej brådskande)

Bakgrund: GitHub Actions' inbyggda `schedule`-triggers (cron) hamnar i en lågprioriterad
kö som kan skjutas upp flera timmar på tysta repon (bekräftat både i vår egen körhistorik
och i flera oberoende rapporter från andra användare). `workflow_dispatch` — ett direkt
API-anrop — går inte via den kön, och fungerar pålitligt även när `schedule` inte gör det.

Den lokala "sync nu"-genvägen (`SyncNow.ps1`) löser redan detta för stunder du faktiskt
sitter vid datorn och ska spela. Den här pingern är ett komplement för bakgrundstakten
— så att prishistoriken/trendgrafen på sajten fortsätter fyllas på jämnt även när du inte
spelar, istället för att ha samma oförutsägbara håltimmar som `schedule` har idag.

Inget kodarbete i repot krävs för detta (workflow:et har redan `workflow_dispatch: {}`
som trigger). Allt nedan görs i din egen webbläsare, i din egen takt.

## Steg 1 — Skapa en avgränsad GitHub-token

Gå till **github.com/settings/personal-access-tokens/new** och skapa en "fine-grained
personal access token":

- **Namn:** valfritt, t.ex. `wow-ah-tracker-pinger`
- **Expiration:** t.ex. 90 dagar. Den här typen av token *måste* ha ett utgångsdatum —
  sätt en påminnelse (kalender, telefon) att förnya den innan den går ut, annars slutar
  pingern tyst att fungera utan att du märker det.
- **Resource owner:** ditt eget konto
- **Repository access:** "Only select repositories" → välj `wow-ah-tracker` (bara detta
  repo, inget annat)
- **Permissions:** under "Repository permissions", sätt **Actions** till **Read and
  write**. Inget annat behövs — lämna allt annat på "No access".
- Klicka "Generate token" och **kopiera den direkt** — den visas bara den här gången. Om
  du missar den får du skapa en ny.

## Steg 2 — Skapa ett gratis konto på cron-job.org

Gå till **cron-job.org**, registrera ett gratis konto, och skapa en ny cronjob med
följande inställningar:

- **URL:** `https://api.github.com/repos/Sundberg-Simon/wow-ah-tracker/actions/workflows/sync.yml/dispatches`
- **Request method:** POST
- **Request headers** (lägg till alla fyra):
  - `Authorization: Bearer <din token från steg 1>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Request body:**
  ```json
  {"ref":"master"}
  ```
  (Bekräftat via `gh repo view --json defaultBranchRef` — repots huvudgren heter
  `master`, inte `main`. Med fel grennamn svarar GitHub med ett fel istället för att
  trigga workflow:et.)
- **Schema:** var 15:e minut (samma takt som det befintliga `schedule`-schemat i
  `sync.yml`)
- Spara.

## Steg 3 — Verifiera att det fungerar

Efter att den första schemalagda pingen borde ha skett (upp till 15 minuter efter du
sparade), kör i en terminal med `gh` inloggat:

```
gh run list --workflow=sync.yml --limit 5
```

Du bör se en ny körning i listan med en tidsstämpel som matchar när cron-job.org skulle
ha triggat den. Om cron-job.org visar en "execution history"/loggflik för jobbet i sitt
eget gränssnitt kan du också se där om anropet gick igenom (statuskod 204 är förväntat
svar från GitHub vid en lyckad dispatch).

## Att komma ihåg

- Token från steg 1 går ut — förnya den innan utgångsdatumet, annars slutar pingern
  fungera utan felmeddelande till dig.
- Om du någon gång vill stänga av pingern helt (t.ex. om du slutar spela ett tag), gå
  bara in på cron-job.org och pausa/ta bort jobbet — inget att ändra i repot.
- Be gärna Claude Code lägga till en kort rad i CLAUDE.md om att pingern finns, när/om
  du sätter upp den, så framtida sessioner förstår hela bilden (self-throttle + */15
  schedule + extern pinger + lokal sync-nu-genväg som de fyra lagren som tillsammans
  håller datan färsk).
