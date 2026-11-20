#!/usr/bin/env node
/**
 * D6 acceptance: a multi-frame log that contains a legacy `team/*` event must
 * be rejected by the harness restorer, and accepted once repaired — with every
 * first-party `team/*` event and every untouched frame preserved.
 *
 * Uses the real `restoreReleasedV4Artifact` from the installed harness (through
 * the Electron child, like the repair CLI). Skips loudly when the harness is not
 * installed (for example on CI without DSH).
 */
import assert from 'node:assert/strict'
import { decodeFrames, encodeFrame, repairLogBuffer } from '../tools/session-format.mjs'
import { resolveHarness, verifyText } from '../tools/session-repair.mjs'

const harness = resolveHarness({ modules: '', harness: '' })
if (harness.ok !== true) {
  console.log(`SKIP: harness unavailable — ${harness.error}`)
  process.exit(0)
}

const header = {
  type: 'session',
  version: 4,
  id: 'session-d6-fixture',
  createdAt: 1795089226203,
  cwd: process.cwd(),
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}

const rows = [
  // First-party Agent Teams rows: must survive untouched.
  { type: 'team/mode', seq: 0, time: 1, data: { enabled: true } },
  { type: 'team/task', seq: 1, time: 2, data: { taskId: 't1', status: 'pending' } },
  // The 0.1.x row that breaks the log.
  { type: 'team/roster', seq: 2, time: 3, data: { roles: [{ id: 'a' }] } },
  { type: 'team/member', seq: 3, time: 4, data: { name: 'a' } },
  { type: 'team/staff', seq: 4, time: 5, data: { roleId: 'a', name: 'a' } },
]

// Three frames: header | rows 0-1 | rows 2-4 (so the legacy rows share the last frame).
const frameBodies = [
  JSON.stringify(header) + '\n',
  rows.slice(0, 2).map(row => JSON.stringify(row)).join('\n') + '\n',
  rows.slice(2).map(row => JSON.stringify(row)).join('\n') + '\n',
]
const original = Buffer.concat(frameBodies.map(encodeFrame))

const decoded = decodeFrames(original)
assert.equal(decoded.frames.length, 3, 'fixture keeps three frames')

const before = verifyText(frameBodies.join(''), harness.harness, harness.modules)
assert.equal(before.ok, false, 'legacy log must be rejected before repair')
assert.match(String(before.error), /unknown event type "team\/roster" at seq 2/)

const repaired = repairLogBuffer(original, harness.knownTypes)
assert.equal(repaired.frames, 3, 'frame count is preserved')
assert.equal(repaired.changedFrames, 1, 'only the frame carrying legacy rows is rewritten')
assert.deepEqual(
  repaired.repairs.map(row => [row.seq, row.type]),
  [[2, 'team/roster'], [4, 'team/staff']],
  'only the unknown team/* rows are repaired',
)

const repairedFrames = decodeFrames(repaired.buffer).frames
const afterText = repairedFrames.map(frame => frame.text).join('')
const after = verifyText(afterText, harness.harness, harness.modules)
assert.equal(after.ok, true, `repaired log must be accepted: ${after.error ?? ''}`)

// Untouched frames are byte-identical to the original.
assert.equal(repairedFrames[0].text, frameBodies[0], 'header frame untouched')
assert.equal(repairedFrames[1].text, frameBodies[1], 'first-party frame untouched')

// First-party events survive with their original shape and are not marked ignorable.
const kept = repairedFrames
  .flatMap(frame => frame.text.split('\n'))
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line))
for (const type of ['team/mode', 'team/task', 'team/member']) {
  const row = kept.find(event => event.type === type)
  assert.ok(row !== undefined, `first-party ${type} survives`)
  assert.equal(row.ignorable, undefined, `first-party ${type} is not marked ignorable`)
}
const rewritten = kept.filter(event => event.type.startsWith('plugin:team-mode/'))
assert.equal(rewritten.length, 2, 'the two legacy rows became plugin records')
assert.ok(rewritten.every(event => event.ignorable === true), 'rewritten rows are ignorable')

// Second pass is a no-op (idempotent).
const again = repairLogBuffer(repaired.buffer, harness.knownTypes)
assert.equal(again.changed, false, 'repair is idempotent')
assert.equal(again.buffer.length, repaired.buffer.length, 'no-op repair changes no bytes')

// Torn tail stays a torn tail: it is copied verbatim, never re-framed.
const tornTail = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])
const torn = Buffer.concat([original, tornTail])
const tornDecoded = decodeFrames(torn)
assert.ok(tornDecoded.tornStart !== undefined, 'fixture ends with a torn frame')
const tornRepair = repairLogBuffer(torn, harness.knownTypes)
const tornAfter = decodeFrames(tornRepair.buffer)
assert.ok(tornAfter.tornStart !== undefined, 'torn tail is preserved as torn')
assert.equal(tornRepair.buffer.subarray(tornRepair.buffer.length - 6).toString('hex'), '28b52ffd0001', 'torn bytes untouched')

// Still-broken text is refused (this is what the CLI does before writing).
const refused = verifyText(frameBodies.join(''), harness.harness, harness.modules)
assert.equal(refused.ok, false, 'still-broken text is refused')
assert.match(String(refused.error), /team\/roster/)

console.log('D6 checks passed: rejected before, accepted after, frames and first-party events preserved')
