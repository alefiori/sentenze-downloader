#!/usr/bin/env node
// Scarica Sentenze — CLI assistito (no CORS, niente da indovinare).
//
// Flusso (human-in-the-loop):
//   1. Avvia un Chrome NORMALE (non automatizzato) e vi si collega via CDP.
//   2. TU compili i campi e premi "Ricerca" nel sito.
//   3. Lo script legge l'URL/payload esatti della ricerca, recupera tutte le
//      pagine riusando la tua sessione, scarica i PDF e crea uno ZIP.
//
// Perché CDP "grezzo" e non Playwright:
//   * Akamai blocca i browser AUTOMATIZZATI: avviando un Chrome normale e
//     COLLEGANDOCI, per Akamai è un browser vero → la tua ricerca funziona.
//   * Unica dipendenza esterna: jszip. Tutto il resto è integrato in Node
//     (WebSocket, fetch, child_process) → facile da impacchettare in un
//     eseguibile standalone.
//
// Requisiti: un browser Chromium installato (Google Chrome o Microsoft Edge,
// preinstallato su Windows 10/11).

import JSZip from 'jszip'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

const SITE = 'https://bancadatigiurisprudenza.giustiziatributaria.gov.it'
const SEARCH_PAGE = `${SITE}/ricerca`
const SITE_HOST_RE = /giustiziatributaria\.gov\.it/i
const SEARCH_URL_RE = /search\/submit/i
const CONTENT_PATH = '/public/v2/search/content/__SR__/GET_CONTENT_FROM_BUTTON_DETAIL'

function defaultChromePath() {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  if (process.platform === 'win32') {
    // Cerca prima Chrome, poi Edge (anch'esso Chromium: stesso protocollo CDP).
    // Ogni browser può trovarsi in posizioni diverse a seconda di come è stato
    // installato (per tutti gli utenti vs. solo per l'utente corrente).
    const probe = (suffix) =>
      [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, suffix),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, suffix),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], suffix),
      ].filter(Boolean)
    const candidates = [
      ...probe('Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ...probe('Microsoft\\Edge\\Application\\msedge.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    // Edge è preinstallato su Windows 10/11, quindi l'ultimo fallback esiste
    // quasi sempre anche se Chrome manca.
    return candidates.find((p) => existsSync(p)) || candidates[0]
  }
  return 'google-chrome'
}

// ---- CLI -----------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    concurrency: 2,
    delayMs: 400,
    // Nella home (sempre scrivibile e persistente): un profilo stabile tra le
    // esecuzioni preserva la sessione "fidata" da Akamai. Mettere il profilo in
    // process.cwd() è fragile quando l'exe è avviato con doppio click (cwd può
    // essere di sola lettura o cambiare a ogni avvio).
    profile: path.join(os.homedir(), '.sentenze-chrome'),
    fresh: false,
    chromePath: defaultChromePath(),
    cdpPort: 9222,
    out: process.cwd(),
    timeoutMs: 60000,
  }
  // Sia con `node download.mjs …` sia come eseguibile SEA, process.argv è
  // [exec, script/invocazione, ...args]: gli argomenti reali partono da 2.
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (a === '--fresh') {
      opts.fresh = true
    } else if (a === '--profile') {
      opts.profile = path.resolve(String(argv[++i]))
    } else if (a === '--chrome-path') {
      opts.chromePath = String(argv[++i])
    } else if (a === '--port') {
      opts.cdpPort = Math.max(1024, parseInt(argv[++i], 10) || 9222)
    } else if (a === '--concurrency') {
      opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 2)
    } else if (a === '--delay') {
      opts.delayMs = Math.max(0, parseInt(argv[++i], 10) || 0)
    } else if (a === '--out') {
      opts.out = path.resolve(String(argv[++i]))
    } else {
      console.error(`Argomento sconosciuto: ${a}  (usa --help)`)
      process.exit(2)
    }
  }
  return opts
}

function printHelp() {
  console.log(`Scarica Sentenze — CLI assistito

Avvia il browser (Chrome o Edge). Compila i filtri e premi "Ricerca" NEL SITO;
poi torna nel terminale e premi INVIO: i PDF dei risultati finiscono in uno ZIP.

Opzioni:
  --concurrency <n>  Download PDF paralleli (default 2)
  --delay <ms>       Ritardo (+ jitter) tra le richieste PDF (default 400)
  --out <dir>        Cartella di output per lo ZIP (default: cartella corrente)
  --fresh            Cancella il profilo Chrome e riparte pulito
  --profile <dir>    Profilo Chrome dedicato (default ./.sentenze-chrome)
  --chrome-path <p>  Percorso del browser Chromium (Chrome/Edge; default OS)
  --port <n>         Porta DevTools per il collegamento CDP (default 9222)
  -h, --help         Questo aiuto

Se vieni bloccato spesso:  --concurrency 1 --delay 1000
`)
}

// ---- Helpers -------------------------------------------------------------

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(promptText, () => {
      rl.close()
      resolve()
    })
  })
}

async function waitForCdp(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/json/version`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true
    } catch {
      /* non pronto */
    }
    await sleep(300)
  }
  return false
}

// Esegue tasks con un numero limitato di worker; onProgress dopo ognuno.
async function runWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length)
  let next = 0
  let done = 0
  async function runner() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = await worker(items[i], i)
      } catch (err) {
        results[i] = { error: String((err && err.message) || err) }
      }
      done++
      if (onProgress) onProgress(done, items.length)
    }
  }
  const runners = []
  for (let w = 0; w < Math.min(limit, items.length); w++) runners.push(runner())
  await Promise.all(runners)
  return results
}

// ---- Client CDP minimale (su WebSocket integrato di Node) ----------------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
  }
  static attach(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const c = new Cdp(ws)
      ws.addEventListener('open', () => resolve(c))
      ws.addEventListener('error', () => reject(new Error('Connessione WebSocket a Chrome fallita')))
      ws.addEventListener('message', (ev) => c._onMessage(ev.data))
    })
  }
  _onMessage(data) {
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || 'Errore CDP'))
      else resolve(msg.result)
    } else if (msg.method) {
      const ls = this.listeners.get(msg.method)
      if (ls) for (const l of ls) l(msg.params)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* noop */
    }
  }
}

// Esegue un'espressione async nella pagina e ne restituisce il valore.
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error((d.exception && d.exception.description) || d.text || 'Errore Runtime.evaluate')
  }
  return r.result ? r.result.value : undefined
}

// ---- Espressioni eseguite nella pagina (stessa sessione/cookie, no CORS) --

function searchExpr(url, payload) {
  return `(async () => {
    const res = await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(payload)}),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { ok: res.ok, status: res.status, json };
  })()`
}

function pdfExpr(origin, sr) {
  const SR = JSON.stringify(sr)
  return `(async () => {
    const url = ${JSON.stringify(origin)} + ${JSON.stringify(CONTENT_PATH)}.replace('__SR__', ${SR});
    let lastErr;
    for (let a = 1; a <= 4; a++) {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.content) throw new Error('Risposta senza contenuto PDF');
        return { secureRandom: ${SR}, nomeFile: data.nomeFile || ('sentenza_' + ${SR} + '.pdf'), contentBase64: data.content };
      } catch (e) { lastErr = e; if (a < 4) await new Promise((r) => setTimeout(r, 500 * a)); }
    }
    return { secureRandom: ${SR}, error: String((lastErr && lastErr.message) || lastErr) };
  })()`
}

async function searchWithRetry(cdp, url, payload, tries = 4) {
  let r
  for (let attempt = 1; attempt <= tries; attempt++) {
    r = await evaluate(cdp, searchExpr(url, payload))
    if (r.ok || r.status !== 403) return r
    if (attempt < tries) {
      const wait = 800 * attempt
      console.log(`    Akamai 403 — riprovo tra ${wait}ms (${attempt}/${tries - 1})…`)
      await sleep(wait)
    }
  }
  return r
}

// ---- Avvio / collegamento Chrome -----------------------------------------

async function ensureChrome(opts) {
  if (await waitForCdp(opts.cdpPort, 800)) {
    console.log(`▶ Trovato Chrome su :${opts.cdpPort}, mi collego…`)
    return null // non l'abbiamo avviato noi
  }
  if (opts.fresh) {
    await rm(opts.profile, { recursive: true, force: true }).catch(() => {})
    console.log('▶ Profilo Chrome azzerato (--fresh).')
  }
  console.log(`▶ Avvio Chrome: ${opts.chromePath}`)
  console.log(`  (profilo: ${opts.profile})`)
  if (process.platform === 'win32' && !existsSync(opts.chromePath)) {
    throw new Error(
      `Chrome non trovato in "${opts.chromePath}".\n` +
        `  Indica il percorso con --chrome-path "<percorso di chrome.exe>".`
    )
  }
  const proc = spawn(
    opts.chromePath,
    [
      `--remote-debugging-port=${opts.cdpPort}`,
      `--user-data-dir=${opts.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      SEARCH_PAGE,
    ],
    { stdio: 'ignore' }
  )
  // Non terminiamo qui: lasciamo che l'errore risalga a main() così la finestra
  // resta aperta (su Windows) e l'utente può leggere il messaggio.
  let spawnErr = null
  proc.on('error', (err) => {
    spawnErr = err
  })
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    if (spawnErr) {
      throw new Error(
        `Impossibile avviare Chrome (${opts.chromePath}): ${spawnErr.message}\n` +
          `  Indica il percorso con --chrome-path "<percorso di chrome.exe>".`
      )
    }
    if (await waitForCdp(opts.cdpPort, 300)) return proc
  }
  if (spawnErr) {
    throw new Error(
      `Impossibile avviare Chrome (${opts.chromePath}): ${spawnErr.message}\n` +
        `  Indica il percorso con --chrome-path "<percorso di chrome.exe>".`
    )
  }
  throw new Error(`Chrome non ha aperto la porta di debug :${opts.cdpPort} in tempo.`)
}

async function getPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      const hit = pages.find((t) => SITE_HOST_RE.test(t.url)) || pages[0]
      if (hit) return hit
    } catch {
      /* riprova */
    }
    await sleep(300)
  }
  return null
}

// ---- Main ----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv)

  // Verifica subito che la cartella di output sia scrivibile: meglio fallire
  // ora con un messaggio chiaro che dopo aver scaricato tutti i PDF.
  try {
    await mkdir(opts.out, { recursive: true })
    const probe = path.join(opts.out, `.sentenze-write-test-${process.pid}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
  } catch (err) {
    throw new Error(
      `Cartella di output non scrivibile: ${opts.out}\n` +
        `  (${err.message}) — usa --out "<cartella scrivibile>".`
    )
  }
  console.log(`▶ Output ZIP in: ${opts.out}`)

  const proc = await ensureChrome(opts)
  const target = await getPageTarget(opts.cdpPort, 15000)
  if (!target) throw new Error('Nessuna scheda di Chrome trovata a cui collegarsi.')

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Network.enable').catch(() => {})
  if (!SITE_HOST_RE.test(target.url)) {
    await cdp.send('Page.navigate', { url: SEARCH_PAGE }).catch(() => {})
  }

  // Cattura l'ULTIMA richiesta di ricerca (URL + payload). I risultati li
  // recuperiamo poi noi rifacendo la ricerca con pageSize grande.
  let captured = null
  let locked = false
  cdp.on('Network.requestWillBeSent', (p) => {
    try {
      if (locked || !p.request || p.request.method !== 'POST') return
      if (!SEARCH_URL_RE.test(p.request.url)) return
      captured = {
        url: p.request.url,
        postData: p.request.postData,
        hasPostData: p.request.hasPostData,
        requestId: p.requestId,
      }
      console.log('  ✓ Ricerca rilevata nel browser.')
    } catch {
      /* ignora */
    }
  })

  try {
    console.log('\n────────────────────────────────────────────────────────')
    console.log('  Nel BROWSER (Chrome/Edge): compila i filtri e premi "Ricerca".')
    console.log('  Quando vedi i risultati, torna QUI e premi INVIO.')
    console.log('────────────────────────────────────────────────────────\n')
    await waitForEnter('Premi INVIO quando i risultati sono comparsi… ')
    locked = true

    if (!captured) {
      throw new Error(
        'Nessuna ricerca rilevata. Premi "Ricerca" nel sito (con risultati ' +
          'visibili) prima di premere INVIO.'
      )
    }

    // Recupera il payload (anche se non incluso nell'evento).
    let postData = captured.postData
    if (!postData && captured.hasPostData) {
      try {
        const r = await cdp.send('Network.getRequestPostData', { requestId: captured.requestId })
        postData = r.postData
      } catch {
        /* niente */
      }
    }
    let basePayload
    try {
      basePayload = JSON.parse(postData || '{}')
    } catch {
      basePayload = null
    }
    const origin = new URL(captured.url).origin

    // 1) Raccogli TUTTI i risultati (pageSize grande), deduplicati.
    const bySr = new Map()
    const ingest = (json) => {
      if (json && Array.isArray(json.result)) {
        for (const r of json.result) if (r && r.secureRandom) bySr.set(r.secureRandom, r)
      }
    }
    const PAGE_SIZE = '100'
    let total = 0
    await sleep(1200) // evita una seconda ricerca identica subito.
    if (basePayload && basePayload.options) {
      let p = 1
      let pageTotal = 1
      do {
        const payload = {
          ...basePayload,
          options: { ...basePayload.options, pageSize: PAGE_SIZE, pageNumber: p },
        }
        const r = await searchWithRetry(cdp, captured.url, payload)
        const cnt = r.ok && r.json && Array.isArray(r.json.result) ? r.json.result.length : 0
        if (r.ok && r.json) {
          ingest(r.json)
          if (p === 1) {
            pageTotal = r.json.pageTotal || 1
            total = r.json.searchTotalResult ?? bySr.size
          }
        }
        console.log(
          `  pagina ${p}/${pageTotal} (pageSize ${PAGE_SIZE}): HTTP ${r.status}, ${cnt} risultati — raccolti ${bySr.size}/${total || '?'}`
        )
        p++
      } while (p <= pageTotal)
    } else {
      throw new Error('Payload di ricerca non interpretabile.')
    }

    const withSr = [...bySr.values()]
    if (withSr.length === 0) throw new Error('Nessun risultato con secureRandom da scaricare.')
    if (total && withSr.length < total) {
      console.log(`  ⚠ Raccolti ${withSr.length}/${total}.`)
    }

    // 2) Scarica i PDF (concorrenza limitata + ritardo con jitter).
    const jitter = () => (opts.delayMs > 0 ? opts.delayMs + Math.floor(Math.random() * opts.delayMs) : 0)
    const downloads = await runWithConcurrency(
      withSr.map((r) => r.secureRandom),
      opts.concurrency,
      async (sr) => {
        const d = jitter()
        if (d > 0) await sleep(d)
        return evaluate(cdp, pdfExpr(origin, sr))
      },
      (done, tot) => process.stdout.write(`\r  Scaricati ${done}/${tot} PDF…   `)
    )
    process.stdout.write('\n')

    // 3) Costruisci lo ZIP.
    const zip = new JSZip()
    const usedNames = new Map()
    const failures = []
    for (const d of downloads) {
      if (!d || d.error || !d.contentBase64) {
        failures.push(d && d.secureRandom ? d.secureRandom : '(sconosciuto)')
        continue
      }
      let name = d.nomeFile
      if (usedNames.has(name)) {
        const count = usedNames.get(name) + 1
        usedNames.set(name, count)
        const dot = name.lastIndexOf('.')
        name = dot > 0 ? `${name.slice(0, dot)}_${count}${name.slice(dot)}` : `${name}_${count}`
      } else {
        usedNames.set(name, 0)
      }
      zip.file(name, Buffer.from(d.contentBase64, 'base64'))
    }

    const successCount = withSr.length - failures.length
    if (successCount === 0) throw new Error('Nessun PDF scaricato con successo.')

    await mkdir(opts.out, { recursive: true })
    const zipPath = path.join(opts.out, `sentenze_${timestamp()}.zip`)
    await writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))

    console.log(
      `✔ Completato: ${successCount} PDF in ${zipPath}` +
        (failures.length ? ` (${failures.length} falliti)` : '')
    )
    if (failures.length) {
      console.log('  secureRandom falliti:')
      for (const id of failures) console.log(`   - ${id}`)
    }
  } finally {
    cdp.close()
    if (proc) proc.kill()
  }
}

// Su Windows l'exe viene spesso lanciato con doppio click: la finestra della
// console si chiude appena il processo termina. Senza una pausa l'utente non
// riesce a leggere né gli errori né l'esito ("appare una finestra nera e poi
// nulla"). Aspettiamo INVIO prima di uscire.
async function holdWindowOpen() {
  if (process.platform !== 'win32') return
  if (!process.stdout.isTTY) return
  await waitForEnter('\nPremi INVIO per chiudere questa finestra… ')
}

main()
  .then(async () => {
    await holdWindowOpen()
  })
  .catch(async (err) => {
    console.error(`\n✖ Errore: ${err.message || err}`)
    await holdWindowOpen()
    process.exit(1)
  })
