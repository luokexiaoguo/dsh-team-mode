#!/usr/bin/env node
/**
 * Repair legacy `team/*` session events written by team-mode 0.1.x.
 *
 * 0.1.x appended plain session events (`team/roster`, `team/staff`,
 * `team/report`). DSH refuses to reopen a log that contains an event type it
 * does not know and that is not marked `ignorable`, so such a session fails with
 * `SessionFormatUnsupportedMigrationError: ... unknown event type "team/roster"`.
 * Current builds write `plugin:team-mode/*` records through `appendPluginRecord`,
 * which are ignorable by construction.
 *
 * The repair is deliberately conservative:
 *
 * - frame boundaries come from the zstd frame structure, so a magic byte
 *   sequence inside compressed data can never split a frame;
 * - only event types this harness does *not* know are rewritten, so first-party
 *   `team/task`, `team/mode`, `team/member` and `team/message/*` events (the
 *   built-in Agent Teams task board) are left alone;
 * - untouched frames are copied byte-for-byte and stay separate frames;
 * - before anything is written, the result is replayed through the harness'
 *   own `restoreReleasedV4Artifact`; an unreadable result is never written.
 *
 * Run it while DSH is closed: the live process appends to the same file.
 *
 * Usage:
 *   node tools/session-repair.mjs --session <session.v4.jsonl.zstd>            # dry run
 *   node tools/session-repair.mjs --session <session.v4.jsonl.zstd> --write    # repair
 *   node tools/session-repair.mjs --all [--home <dsh-home>] --write            # repair every legacy log
 *   node tools/session-repair.mjs --session <log> --modules <node_modules/@deepseek-ai> --harness <exe>
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  LEGACY_EVENT_TYPES,
  decodeFrames,
  findLegacyLogs,
  legacyRows,
  repairLogBuffer,
} from './session-format.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERIFIER = path.join(HERE, 'verify-session-log.mjs')
const VERIFY_MARKER = '@@VERIFY@@'

function parseArgs(argv) {
  const options = { session: '', all: false, home: '', write: false, force: false, modules: '', harness: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--session') options.session = argv[++index] ?? ''
    else if (arg === '--all') options.all = true
    else if (arg === '--home') options.home = argv[++index] ?? ''
    else if (arg === '--write') options.write = true
    else if (arg === '--force') options.force = true
    else if (arg === '--modules') options.modules = argv[++index] ?? ''
    else if (arg === '--harness') options.harness = argv[++index] ?? ''
  }
  return options
}

/**
 * Candidate `node_modules/@deepseek-ai` directories, most specific first.
 *
 * Inside `app.asar` plain Node cannot stat directories, so candidates are not
 * filtered here; `resolveHarness()` probes each of them through the Electron
 * child instead.
 *
 * @param explicit - value of `--modules`, if any.
 * @returns candidate module roots.
 */
export function moduleCandidates(explicit) {
  const candidates = []
  if (explicit !== '') candidates.push(explicit)
  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install !== '') candidates.push(path.resolve(install, '..'))
  const exe = process.env.DSH_NODE_EXECUTABLE
  if (typeof exe === 'string' && exe !== '') {
    candidates.push(path.join(path.dirname(exe), 'resources/app.asar/dsh/node_modules/@deepseek-ai'))
  }
  candidates.push('D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai')
  return [...new Set(candidates.map(candidate => path.normalize(candidate)))]
}

/**
 * Candidate Electron executables able to import modules from the asar.
 *
 * @param explicit - value of `--harness`, if any.
 * @returns existing candidates.
 */
export function harnessCandidates(explicit) {
  const candidates = []
  if (explicit !== '') candidates.push(explicit)
  const exe = process.env.DSH_NODE_EXECUTABLE
  if (typeof exe === 'string' && exe !== '') candidates.push(exe)
  candidates.push('D:/dsh/DeepSeek Harness.exe')
  candidates.push(path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'DeepSeek Harness/DeepSeek Harness.exe'))
  return candidates.filter(candidate => {
    try {
      return existsSync(candidate)
    } catch {
      return false
    }
  })
}

function runVerifier({ harness, modules, jsonl, mode }) {
  const result = spawnSync(harness, [VERIFIER, '--modules', modules, '--jsonl', jsonl, '--mode', mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  const stdout = result.stdout ?? ''
  const line = stdout.split('\n').find(row => row.startsWith(VERIFY_MARKER))
  if (line === undefined) {
    return {
      ok: false,
      error: `verifier produced no result (exit ${result.status}); stderr: ${(result.stderr ?? '').trim().slice(0, 500)}`,
    }
  }
  try {
    return JSON.parse(line.slice(VERIFY_MARKER.length))
  } catch (error) {
    return { ok: false, error: `verifier output is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Resolve the harness modules and executable used for the pre-write self check.
 *
 * Candidates are probed through the Electron child (plain Node cannot read
 * inside `app.asar`), so the first pair whose event catalogue loads wins.
 *
 * @param options - parsed CLI options.
 * @returns the resolved paths, or an explanation of what is missing.
 */
export function resolveHarness(options) {
  const harness = harnessCandidates(options.harness)[0]
  if (harness === undefined) {
    return {
      ok: false,
      error: 'cannot find the DeepSeek Harness executable needed for the self check. Pass --harness <exe> or set DSH_NODE_EXECUTABLE.',
    }
  }
  const failures = []
  for (const modules of moduleCandidates(options.modules)) {
    const known = runVerifier({ harness, modules, jsonl: '', mode: 'known' })
    if (known.ok === true && Array.isArray(known.known)) {
      return { ok: true, modules, harness, knownTypes: new Set(known.known) }
    }
    failures.push(`${modules}: ${known.error ?? 'unexpected output'}`)
  }
  return {
    ok: false,
    error:
      'cannot read the harness event catalogue. Pass --modules <.../app.asar/dsh/node_modules/@deepseek-ai>.\n  ' +
      failures.join('\n  '),
  }
}

/**
 * Replay a plaintext log through the harness restorer.
 *
 * @param text - plaintext JSONL.
 * @param harness - absolute path to the Electron executable.
 * @param modules - `node_modules/@deepseek-ai` used by that harness.
 * @returns the verifier verdict.
 */
export function verifyText(text, harness, modules) {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-mode-verify-'))
  const file = path.join(dir, 'candidate.jsonl')
  try {
    writeFileSync(file, text, 'utf8')
    return runVerifier({ harness, modules, jsonl: file, mode: 'verify' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.session === '' && options.all !== true) {
    console.error('usage: node tools/session-repair.mjs --session <session.v4.jsonl.zstd> [--write] [--modules <dir>] [--harness <exe>]')
    console.error('       node tools/session-repair.mjs --all [--home <dsh-home>] [--write] [--modules <dir>] [--harness <exe>]')
    process.exit(2)
  }
  const harness = resolveHarness(options)
  const knownTypes = harness.ok ? harness.knownTypes : undefined
  if (harness.ok !== true) {
    console.log(`note: harness self check unavailable — ${harness.error}`)
    if (knownTypes === undefined) {
      console.log(`      counting only ${LEGACY_EVENT_TYPES.join(', ')}; first-party team/* events are ignored by name.`)
    }
  }

  // --all resolves the targets by scanning recent session logs, so one command can
  // close out every log the 0.1.x build left behind.
  const targets = options.all === true
    ? findLegacyLogs({ home: options.home === '' ? undefined : options.home, limit: 200, knownTypes })
    : [{ file: options.session }]
  if (targets.length === 0) {
    console.log('no session log carries legacy team/* events')
    process.exit(0)
  }

  const failures = []
  let repaired = 0
  for (const target of targets) {
    if (targets.length > 1) console.log(`\n== ${target.session ?? target.file}`)
    const outcome = repairOne(target.file, options, harness, knownTypes)
    if (outcome === 'repaired') repaired += 1
    if (outcome === 'failed') failures.push(target.file)
  }
  if (targets.length > 1) {
    console.log(`\n${repaired} log(s) repaired, ${failures.length} failed${options.write === true ? '' : ' (dry run)'}`)
  }
  process.exit(failures.length === 0 ? 0 : 4)
}

/**
 * Repair one session log, printing what happened.
 *
 * @param file - absolute path to `session.v4.jsonl.zstd`.
 * @param options - parsed CLI options.
 * @param harness - `resolveHarness()` result.
 * @param knownTypes - event types the harness understands, when known.
 * @returns the outcome, for exit-code accounting.
 */
function repairOne(file, options, harness, knownTypes) {
  let raw
  try {
    raw = readFileSync(file)
  } catch (error) {
    console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
  let decoded
  try {
    decoded = decodeFrames(raw)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 'failed'
  }
  const legacy = decoded.frames.flatMap(frame => legacyRows(frame.text, knownTypes))
  console.log(`frames: ${decoded.frames.length}${decoded.tornStart === undefined ? '' : ` (+ torn tail at ${decoded.tornStart})`}`)
  console.log(`legacy events needing repair: ${legacy.length}`)
  for (const row of legacy.slice(0, 20)) console.log(`  seq ${row.seq}: ${row.type}`)
  if (legacy.length === 0) {
    console.log('nothing to repair')
    return 'clean'
  }

  const result = repairLogBuffer(raw, knownTypes)
  const bufferText = buffer => decodeFrames(buffer).frames.map(frame => frame.text).join('')
  if (options.write !== true) {
    if (harness.ok === true) {
      const before = verifyText(bufferText(raw), harness.harness, harness.modules)
      const after = verifyText(bufferText(result.buffer), harness.harness, harness.modules)
      console.log(`self check: before → ${before.ok ? 'ACCEPTED' : `REJECTED (${before.error})`}`)
      console.log(`self check: after  → ${after.ok ? 'ACCEPTED' : `REJECTED (${after.error})`}`)
    }
    console.log('dry run: pass --write while DSH is closed to rewrite the log')
    return 'dry'
  }
  if (harness.ok !== true && options.force !== true) {
    console.error('refusing to write: the pre-write self check is unavailable (pass --force to override, or --modules/--harness)')
    return 'failed'
  }
  if (harness.ok === true) {
    const verdict = verifyText(bufferText(result.buffer), harness.harness, harness.modules)
    if (verdict.ok !== true) {
      console.error(`refusing to write: repaired log is still rejected by the harness restorer: ${verdict.error}`)
      return 'failed'
    }
    console.log('self check: repaired log ACCEPTED by restoreReleasedV4Artifact')
  }
  const backup = `${file}.bak-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}`
  copyFileSync(file, backup)
  const staged = `${file}.repairing-${process.pid}`
  writeFileSync(staged, result.buffer)
  renameSync(staged, file)
  console.log(`repaired ${result.repairs.length} event(s) in ${result.changedFrames} frame(s); ${result.frames - result.changedFrames} frame(s) untouched`)
  console.log(`backup: ${backup}`)
  return 'repaired'
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main()
