# ARCHITECTURE.md

Design rationale and internals for `sentenze-downloader`. For the quick
maintainer orientation see [CLAUDE.md](CLAUDE.md); for end-user instructions see
[README.md](README.md).

## The core problem

The target site
([bancadatigiurisprudenza.giustiziatributaria.gov.it](https://bancadatigiurisprudenza.giustiziatributaria.gov.it/ricerca))
is protected by **Akamai Bot Manager** and serves **no CORS headers**. Two naive
approaches both fail:

| Approach | Why it fails |
| --- | --- |
| Browser SPA / `fetch` from another origin | No CORS headers → blocked; auth flows 302-loop; 403s. |
| Playwright / Puppeteer launching a browser | Akamai fingerprints the automation flags and blocks the *search* request even though the page loads. |

## The solution: drive a real browser via raw CDP

Instead of letting an automation framework *launch* the browser, the tool:

1. Spawns an **ordinary Chrome/Edge** with `--remote-debugging-port` and a
   persistent user-data-dir — no automation flags, so Akamai sees a real browser.
2. **The user performs the search** in that window → a legitimate human session
   with valid cookies.
3. The tool **attaches over CDP** (`connectOverCDP`-style, but hand-rolled) and
   runs all subsequent network calls **inside the page** via `Runtime.evaluate`.

Because those calls originate from the page itself:

- **CORS is irrelevant** — it's same-origin, and it's Node orchestrating, not a
  foreign browser origin.
- **No 403 redirect loops** — the requests carry the same session/cookies the
  human just established.
- The tool **intercepts the real search request** rather than reverse-engineering
  the API, so the exact URL and payload are always correct even if the site
  changes them.

## Component map (`download.mjs`)

```
parseArgs / printHelp        CLI parsing; defaults live here.
defaultChromePath            Per-OS Chrome/Edge discovery (Win probes multiple
                             install locations; Edge is the preinstalled fallback).
Cdp (class)                  Minimal CDP client over Node's built-in WebSocket:
                               .send(method, params)  → request/response by id
                               .on(method, fn)        → event subscription
evaluate()                   Runs an async expression in the page, unwraps result
                             or throws on exceptionDetails.
searchExpr / pdfExpr         Build the JS strings executed *in the page*. pdfExpr
                             has its own 4-try backoff loop inside the browser.
searchWithRetry              Node-side 403 backoff around the search replay.
runWithConcurrency           Bounded worker pool with per-item progress callback.
ensureChrome / getPageTarget Launch-or-attach + find the right page target.
main()                       Orchestrates the whole flow; see below.
holdWindowOpen               Windows-only: pause before exit so the console stays
                             readable on double-click launches.
```

## Control flow in `main()`

1. **Pre-flight:** verify `--out` is writable (write+delete a probe file) so the
   tool fails early, not after downloading everything.
2. `ensureChrome(opts)` → `getPageTarget()` → `Cdp.attach()`; enable `Page` and
   `Network` domains; navigate to the search page if needed.
3. Register a `Network.requestWillBeSent` listener that captures the **last**
   POST to a URL matching `search/submit` (URL, postData, requestId). A `locked`
   flag freezes the capture once the user hits ENTER.
4. Block on `waitForEnter()` while the user searches.
5. Recover the POST body (via `Network.getRequestPostData` if the event omitted
   it), parse it into `basePayload`, derive `origin`.
6. **Paginate:** replay `basePayload` with `pageSize:"100"` and incrementing
   `pageNumber`, using `pageTotal`/`searchTotalResult` from page 1; accumulate
   results in a `Map` keyed by `secureRandom` (dedup, including any pages the
   user browsed manually).
7. **Download:** `runWithConcurrency` over the `secureRandom`s, each worker
   sleeping a jittered `--delay` then running `pdfExpr`. Progress printed in place.
8. **Zip:** JSZip; duplicate `nomeFile`s get a numeric suffix; failures collected
   into `failures[]` and reported. ZIP written to `sentenze_<timestamp>.zip`.
9. `finally`: close the CDP socket and kill Chrome **only if we launched it**
   (`proc` is null when we attached to an existing instance).

## Anti-blocking strategy

Akamai flags an IP on bursty, scraper-like traffic. Mitigations, in order of
importance:

1. **Real, non-automated browser** — the search itself isn't blocked.
2. **Persistent session reuse** (`~/.sentenze-chrome`) — reruns ride an
   already-trusted session. `--fresh` wipes it.
3. **Low concurrency + jittered delay** (`--concurrency` default 2, `--delay`
   default 400ms + random jitter).
4. **Backoff on intermittent 403** — both Node-side (`searchWithRetry`) and
   in-page (`pdfExpr`).

If blocked anyway: wait ~10–15 min for IP reputation to recover, then
`node download.mjs --concurrency 1 --delay 1000`.

## Build pipeline (`build.mjs`)

Produces dependency-free standalone executables (no Node install needed on the
target — only a Chromium browser):

1. **esbuild** bundles `download.mjs` + `jszip` into one CJS file
   (`dist/bundle.cjs`), targeting the current Node major.
2. **Node SEA** (`--experimental-sea-config`) turns the bundle into a blob.
3. **postject** injects the blob into a copy of a `node` binary:
   - **macOS:** copy the local `node`, `codesign --remove-signature`, inject,
     then `codesign --sign -` (ad-hoc; required on Apple Silicon). **Must run on
     a Mac.**
   - **Windows:** download the matching `node.exe` from nodejs.org, inject. Works
     from a Mac.
4. Intermediate artifacts are cleaned up; binaries remain in `dist/`.

The single-dependency design (`jszip` only) exists precisely to keep this bundle
small and the SEA injection reliable. Adding deps raises the cost of every build.

## Invariants worth protecting

- The only runtime dependency is `jszip`. Everything else is Node built-ins.
- All network I/O against the site happens **in the page**, never from Node's own
  fetch (which would have no session and hit CORS/403).
- A single PDF failure never aborts the batch.
- The Chrome profile is persistent and lives in the user's home directory.
- Error messages name the flag that fixes them.
```
