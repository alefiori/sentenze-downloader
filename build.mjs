#!/usr/bin/env node
// Costruisce eseguibili standalone (macOS + Windows) di download.mjs.
//
// Pipeline:
//   1. esbuild  → impacchetta download.mjs + jszip in un singolo file CJS.
//   2. Node SEA → genera un "blob" e lo inietta in una copia del binario node
//      del sistema operativo target (macOS: il node locale; Windows: node.exe
//      scaricato da nodejs.org per la stessa versione).
//
// Uso:
//   node build.mjs            # costruisce per la piattaforma corrente
//   node build.mjs --all      # costruisce macOS + Windows
//   node build.mjs --win      # solo Windows
//   node build.mjs --mac      # solo macOS

import { build as esbuild } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { writeFile, mkdir, copyFile, rm, chmod } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dist')
const BUNDLE = path.join(DIST, 'bundle.cjs')
const BLOB = path.join(DIST, 'sea-prep.blob')
const SEA_CONFIG = path.join(DIST, 'sea-config.json')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const NODE_VER = process.versions.node

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`Comando fallito: ${cmd} ${args.join(' ')}`)
}

async function download(url, dest) {
  console.log(`  scarico ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download fallito (${res.status}): ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

async function makeBundleAndBlob() {
  await mkdir(DIST, { recursive: true })
  console.log('▶ esbuild: impacchetto download.mjs…')
  await esbuild({
    entryPoints: [path.join(ROOT, 'download.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${NODE_VER.split('.')[0]}`,
    outfile: BUNDLE,
    banner: { js: '' }, // niente shebang nel bundle SEA
    legalComments: 'none',
  })
  await writeFile(
    SEA_CONFIG,
    JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true }, null, 2)
  )
  console.log('▶ Node SEA: genero il blob…')
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG])
}

async function buildMac() {
  console.log('▶ Build macOS…')
  const out = path.join(DIST, 'sentenze-downloader-macos')
  await copyFile(process.execPath, out)
  await chmod(out, 0o755)
  // Rimuovi la firma, inietta il blob, ri-firma ad-hoc (necessario su Apple Silicon).
  run('codesign', ['--remove-signature', out])
  run('npx', [
    '--yes', 'postject', out, 'NODE_SEA_BLOB', BLOB,
    '--sentinel-fuse', FUSE,
    '--macho-segment-name', 'NODE_SEA',
  ])
  run('codesign', ['--sign', '-', out])
  console.log(`  ✔ ${out}`)
}

async function buildWin() {
  console.log('▶ Build Windows…')
  const nodeExe = path.join(DIST, 'node-win.exe')
  await download(`https://nodejs.org/dist/v${NODE_VER}/win-x64/node.exe`, nodeExe)
  const out = path.join(DIST, 'sentenze-downloader-win.exe')
  await copyFile(nodeExe, out)
  run('npx', [
    '--yes', 'postject', out, 'NODE_SEA_BLOB', BLOB,
    '--sentinel-fuse', FUSE,
  ])
  await rm(nodeExe, { force: true })
  console.log(`  ✔ ${out}`)
}

async function main() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const wantMac = all || args.includes('--mac') || (!args.length && process.platform === 'darwin')
  const wantWin = all || args.includes('--win') || (!args.length && process.platform === 'win32')

  await makeBundleAndBlob()
  if (wantMac) {
    if (process.platform !== 'darwin') {
      console.log('  ⚠ Salto macOS: la firma (codesign) richiede di buildare su un Mac.')
    } else {
      await buildMac()
    }
  }
  if (wantWin) await buildWin()

  // Pulizia artefatti intermedi.
  await rm(BUNDLE, { force: true }).catch(() => {})
  await rm(BLOB, { force: true }).catch(() => {})
  await rm(SEA_CONFIG, { force: true }).catch(() => {})
  console.log('\n✔ Fatto. Eseguibili in ./dist')
}

main().catch((err) => {
  console.error(`\n✖ Build fallita: ${err.message || err}`)
  process.exit(1)
})
