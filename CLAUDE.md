# CLAUDE.md — Developer & Agent Guide

Guidance for humans and AI agents maintaining/extending this project. The
[README.md](README.md) is the **user-facing** doc (Italian). This file is the
**maintainer-facing** doc. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the deep
dive on *why* the tool works the way it does.

## What this is

A human-in-the-loop CLI that bulk-downloads PDF rulings ("sentenze") from the
Italian tax-justice case-law database
([bancadatigiurisprudenza.giustiziatributaria.gov.it](https://bancadatigiurisprudenza.giustiziatributaria.gov.it/ricerca))
into a single ZIP.

The site sits behind **Akamai Bot Manager** and sends **no CORS headers**, which
blocks both browser SPAs and Playwright-launched browsers. The tool sidesteps
this by launching a **real, non-automated Chrome/Edge**, letting the *user* run
the search, then attaching over the **Chrome DevTools Protocol (CDP)** to reuse
that legitimate human session. All network calls run *inside the page* (same
origin, same cookies) so CORS and 403s never come into play.

## Layout

```
download.mjs   The entire CLI. ~580 lines, single file, heavily commented (IT).
build.mjs      Builds standalone executables (esbuild bundle → Node SEA).
package.json   Scripts + the only runtime dep (jszip) and dev dep (esbuild).
dist/          Prebuilt standalone binaries (gitignored; checked in by hand).
README.md      User docs (Italian).
```

There is **no `src/`, no framework, no test suite, no transpile step.** The
source runs as-is on Node. Keep it that way unless there is a strong reason.

## Run / build

```bash
npm install            # installs jszip + esbuild
node download.mjs      # run from source (= npm run download)
node download.mjs -h   # all CLI options

npm run build          # build macOS + Windows binaries (must run on a Mac)
npm run build:mac      # macOS only  (needs codesign → Mac only)
npm run build:win      # Windows only (works from a Mac too)
```

CI: [.github/workflows/build.yml](.github/workflows/build.yml) runs `npm run
build` on a `macos-latest` runner on every push to `main` and publishes the two
executables to a GitHub Release tagged `v<version>` (from
[package.json](package.json)). Bump `version` to cut a new release; pushing
without a bump overwrites the existing release's assets. The macOS asset is
**Apple Silicon** (the runner is arm64).

Requires **Node 24+** and an installed Chromium browser (Google Chrome, or Edge
on Windows). Output ZIP lands as `sentenze_<timestamp>.zip` in `--out`
(default: cwd).

## The download flow (read [download.mjs](download.mjs) end-to-end first)

1. **Launch/attach Chrome** — `ensureChrome()` starts a normal Chrome with
   `--remote-debugging-port`; if one is already on the port, it just attaches.
2. **User searches** — the tool prints instructions and blocks on `waitForEnter`.
3. **Capture the search request** — a `Network.requestWillBeSent` listener grabs
   the URL + POST payload of the `…/search/submit` call (no guessing the API).
4. **Re-run paginated** — `searchWithRetry()` replays that payload with
   `pageSize: "100"`, walking every page, dedup'd by `secureRandom`.
5. **Download PDFs** — `runWithConcurrency()` fetches each
   `…/search/content/{secureRandom}/GET_CONTENT_FROM_BUTTON_DETAIL`, decoding the
   base64 `content` field. Throttled by `--concurrency` + jittered `--delay`.
6. **Zip** — JSZip builds the archive (duplicate filenames get a suffix); failed
   `secureRandom`s are listed at the end and never abort the batch.

Steps 3–6 all execute via `evaluate()` → `Runtime.evaluate` **inside the page**.
`Cdp` (around [download.mjs:191](download.mjs#L191)) is a minimal hand-rolled CDP
client over Node's built-in `WebSocket` — chosen so the only npm dependency is
`jszip`, which keeps the SEA bundle small.

## Conventions

- **ES modules**, Node built-ins preferred over deps (`node:fs/promises`,
  `node:child_process`, global `fetch`/`WebSocket`). Adding a dependency means it
  must bundle cleanly into the SEA binary — weigh that cost.
- **Comments and all user-facing strings are in Italian.** Match that. Code
  identifiers are English. (This guide is in English by convention for agents.)
- **Fail fast with actionable messages.** E.g. output-dir writability is checked
  *before* downloading (`main()` start); errors tell the user which flag to use.
- **Never abort the batch on a single PDF failure** — collect and report.
- Profile lives at `~/.sentenze-chrome` on purpose (persistent, writable, keeps
  the Akamai-trusted session warm across runs). Don't move it to cwd.

## Gotchas

- **Akamai throttles by IP.** Aggressive `--concurrency` triggers 403s; the fix
  is gentleness (`--concurrency 1 --delay 1000`) and reusing the session, *not*
  more retries. There's already exponential backoff on 403.
- **Windows double-click:** the console closes instantly on exit, so
  `holdWindowOpen()` waits for ENTER. Preserve this when touching exit paths.
- **`process.argv` indexing** is `2+` for both `node download.mjs …` and the SEA
  executable — don't assume otherwise.
- **macOS SEA needs an ad-hoc `codesign`** (Apple Silicon won't run the injected
  binary otherwise); that's why mac builds can't be produced off a Mac.
- Edge is the Windows fallback because it's preinstalled and is Chromium (same
  CDP). The `defaultChromePath()` probe order matters.

## Before you ship a change

- `node download.mjs -h` still prints cleanly.
- A real end-to-end run still produces a ZIP (there are no automated tests —
  this is a manual, browser-driven tool; verify by hand).
- If you changed bundling-relevant code, `npm run build` succeeds and the binary
  in `dist/` runs.
- Update [README.md](README.md) if you changed flags/behavior, and bump
  `version` in [package.json](package.json).
```
