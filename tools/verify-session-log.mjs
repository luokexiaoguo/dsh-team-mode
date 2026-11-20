#!/usr/bin/env node
/**
 * Verify a plaintext session log with the harness' own restorer.
 *
 * The restorer (`restoreReleasedV4Artifact`) lives inside `app.asar`, which only
 * Electron's Node can import, so the repair CLI spawns this script with
 * `ELECTRON_RUN_AS_NODE=1` instead of re-implementing the rules.
 *
 * Usage (normally invoked by tools/session-repair.mjs):
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness>" tools/verify-session-log.mjs --modules <dir> --jsonl <file>
 *   ... --mode known
 *
 * Output: one line `@@VERIFY@@ {json}`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const options = { modules: '', jsonl: '', mode: 'verify' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--modules') options.modules = argv[++index] ?? ''
    else if (arg === '--jsonl') options.jsonl = argv[++index] ?? ''
    else if (arg === '--mode') options.mode = argv[++index] ?? 'verify'
  }
  return options
}

const emit = payload => {
  process.stdout.write(`@@VERIFY@@${JSON.stringify(payload)}\n`)
}

const options = parseArgs(process.argv.slice(2))
if (options.modules === '') {
  emit({ ok: false, error: 'missing --modules <node_modules/@deepseek-ai>' })
  process.exit(2)
}

const formatUrl = pathToFileURL(path.join(options.modules, 'dsh-session-format-v3-to-v4/lib/index.js')).href
const sessionUrl = pathToFileURL(path.join(options.modules, 'dsh-session/lib/index.js')).href

let restorer
let knownTypes
try {
  restorer = await import(formatUrl)
  const session = await import(sessionUrl)
  knownTypes = session.KNOWN_SESSION_EVENT_TYPES
} catch (error) {
  emit({ ok: false, error: `cannot load the harness session modules: ${error instanceof Error ? error.message : String(error)}` })
  process.exit(3)
}

if (options.mode === 'known') {
  emit({ ok: true, known: [...knownTypes], restorer: typeof restorer.restoreReleasedV4Artifact === 'function' })
  process.exit(0)
}

if (options.jsonl === '') {
  emit({ ok: false, error: 'missing --jsonl <file>' })
  process.exit(2)
}

let text
try {
  text = readFileSync(options.jsonl, 'utf8')
} catch (error) {
  emit({ ok: false, error: `cannot read ${options.jsonl}: ${error instanceof Error ? error.message : String(error)}` })
  process.exit(2)
}

const lines = text.split('\n')
let header
try {
  header = JSON.parse(lines[0])
} catch (error) {
  emit({ ok: false, error: `header record is not JSON: ${error instanceof Error ? error.message : String(error)}` })
  process.exit(2)
}
// The on-disk first record carries JSONL framing (`type: "session"`); the
// format validator only accepts the session header fields themselves.
const HEADER_FIELDS = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset']
const headerForRestore = {}
for (const key of HEADER_FIELDS) if (header?.[key] !== undefined) headerForRestore[key] = header[key]
const events = []
for (let index = 1; index < lines.length; index += 1) {
  const line = lines[index]
  if (line.trim() === '') continue
  try {
    events.push(JSON.parse(line))
  } catch (error) {
    emit({ ok: false, error: `event row ${index} is not JSON: ${error instanceof Error ? error.message : String(error)}` })
    process.exit(2)
  }
}
let inheritedEventCount = 0
if (header?.isSeeded === true) {
  for (const [index, event] of events.entries()) {
    if (event?.type === 'session/end-seed' && event?.data?.inherited === true) inheritedEventCount = index + 1
  }
}
const unknown = events
  .filter(event => !knownTypes.has(event?.type) && event?.ignorable !== true)
  .map(event => ({ seq: event?.seq, type: event?.type }))
  .slice(0, 10)

try {
  restorer.restoreReleasedV4Artifact({ header: headerForRestore, events, inheritedEventCount }, knownTypes)
  emit({ ok: true, events: events.length, unknown })
  process.exit(0)
} catch (error) {
  emit({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    unknown,
    events: events.length,
  })
  process.exit(4)
}
