# Scarica Sentenze

CLI assistito per scaricare in blocco i PDF dalla banca dati della
giurisprudenza tributaria
([bancadatigiurisprudenza.giustiziatributaria.gov.it](https://bancadatigiurisprudenza.giustiziatributaria.gov.it/ricerca)).

Apre un browser vero, **tu** fai la ricerca nel sito, e lo script scarica i PDF
di tutti i risultati in un unico ZIP.

Richiede **Google Chrome** installato.

## Eseguibili pronti (consigliato)

In `dist/` ci sono gli eseguibili standalone — **non serve Node**, basta Chrome:

- **macOS**: `sentenze-downloader-macos`
- **Windows**: `sentenze-downloader-win.exe`

```bash
# macOS (da terminale, nella cartella dell'eseguibile)
./sentenze-downloader-macos

# Windows (da cmd/PowerShell)
sentenze-downloader-win.exe
```

Poi: si apre Chrome → compili i filtri e premi **Ricerca** → torni al terminale
e premi **INVIO** → i PDF finiscono in `sentenze_<timestamp>.zip`.

> Gli eseguibili non sono firmati: al primo avvio macOS (Gatekeeper) e Windows
> (SmartScreen) potrebbero avvisare. Su macOS: tasto destro → *Apri*, oppure
> `xattr -dr com.apple.quarantine sentenze-downloader-macos`. Su Windows:
> *Ulteriori informazioni → Esegui comunque*.

## Uso da sorgente (con Node)

```bash
npm install
node download.mjs          # oppure: npm run download
```

1. Si apre una finestra di **Chrome** sulla pagina di ricerca.
2. Compila i filtri e premi **Ricerca** nel sito.
3. Torna nel terminale e premi **INVIO**: lo script recupera tutti i risultati
   e scarica i PDF in `sentenze_<timestamp>.zip`.

`node download.mjs --help` per tutte le opzioni.

## Build degli eseguibili

```bash
npm run build          # macOS + Windows (da un Mac)
npm run build:mac      # solo macOS
npm run build:win      # solo Windows
```

Pipeline (`build.mjs`): **esbuild** impacchetta `download.mjs` + `jszip` in un
unico file, poi **Node SEA** inietta il blob in una copia del binario `node`
(macOS: quello locale, firmato ad-hoc; Windows: `node.exe` scaricato da
nodejs.org per la stessa versione). La build di macOS richiede un Mac (per la
firma `codesign`); Windows si costruisce anche da Mac.

### Opzioni

| Opzione | Descrizione |
| --- | --- |
| `--concurrency <n>` | Download PDF paralleli (default 2). Valori alti fanno scattare il blocco di Akamai. |
| `--delay <ms>` | Ritardo (+ jitter) tra le richieste PDF (default 400). |
| `--out <dir>` | Cartella di output per lo ZIP (default: cartella corrente). |
| `--fresh` | Cancella il profilo Chrome e riparte pulito. |
| `--profile <dir>` | Profilo Chrome dedicato (default `./.sentenze-chrome`). |
| `--chrome-path <p>` | Percorso dell'eseguibile Chrome (default standard OS). |
| `--port <n>` | Porta DevTools per il collegamento CDP (default 9222). |

## Perché funziona così (no CORS, no 403)

Il sito è protetto da **Akamai Bot Manager** e non invia header CORS. Una SPA
nel browser veniva bloccata (CORS / 302 in loop / 403), e persino un browser
**lanciato da Playwright** veniva riconosciuto come automatizzato: la pagina si
caricava ma la chiamata di ricerca veniva bloccata.

La soluzione: **non far lanciare il browser a Playwright**. Lo script avvia un
**Chrome normale** (senza i flag di automazione) con un debug port e vi si
**collega** via DevTools Protocol (`connectOverCDP`). Per Akamai è un browser
vero.

- **La ricerca la fai tu** in quel Chrome reale → sessione umana legittima.
- **È Node, non un browser-origin** → il concetto di CORS non esiste.
- Lo script **intercetta la risposta della ricerca** (`response` su
  `…/search/submit`) per conoscere URL e payload esatti — niente da indovinare.
- Le chiamate ai PDF partono **dalla stessa pagina** (stessa sessione/cookie,
  stesso origin) → niente loop di redirect, niente 403.

## Come scarica

1. **Risultati** — riusa il payload catturato e rifà la ricerca con
   `pageSize: "100"`, ricalcolando il numero di pagine; accumula i risultati di
   tutte le pagine (più quelle eventualmente sfogliate a mano), deduplicati per
   `secureRandom`.
2. **PDF** — per ogni risultato
   `GET /public/v2/search/content/{secureRandom}/GET_CONTENT_FROM_BUTTON_DETAIL`,
   con al massimo `--concurrency` richieste in parallelo; decodifica il campo
   base64 `content`.
3. **ZIP** — JSZip costruisce l'archivio (nomi duplicati ricevono un suffisso) e
   lo scrive su disco.

I PDF che falliscono non bloccano il batch: i relativi `secureRandom` vengono
elencati alla fine.

## Evitare i blocchi di Akamai

Il sito flagga l'IP se vede troppe richieste ravvicinate (pattern da scraper):
funziona una volta, poi i rerun vengono bloccati per qualche minuto. Per questo
lo strumento:

- usa un **Chrome reale** (non automatizzato), così la ricerca non viene
  bloccata come browser-bot;
- **riusa la sessione** tra le esecuzioni (profilo `./.sentenze-chrome`): i
  rerun "cavalcano" una sessione già fidata. Usa `--fresh` per azzerarlo;
- scarica con **bassa concorrenza** (`--concurrency`, default 2) e un **ritardo
  con jitter** tra le richieste (`--delay`, default 400ms);
- **riprova** automaticamente (backoff) sui 403 intermittenti.

Se vieni comunque bloccato, **aspetta ~10-15 minuti** (la reputazione IP si
sblocca) e riprova in modo gentile:

```bash
node download.mjs --concurrency 1 --delay 1000
```

## Note

- Tutto in memoria, nessun backend, nessuna persistenza oltre allo ZIP finale e
  al profilo Chrome (`./.sentenze-chrome`, cancellabile).
- Usa lo strumento responsabilmente: è un server pubblico, tieni
  `--concurrency` contenuto.

## Sviluppo / contribuire

Per chi (o quale Agent) deve mantenere o estendere il progetto:

- [CLAUDE.md](CLAUDE.md) — guida rapida per manutentori e Agent: struttura,
  convenzioni, flusso, gotcha e checklist prima di una modifica.
- [ARCHITECTURE.md](ARCHITECTURE.md) — il *perché* del design (CDP grezzo,
  anti-Akamai, mappa dei componenti, pipeline di build, invarianti da preservare).
