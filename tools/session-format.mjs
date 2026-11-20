/**
 * Session-log primitives shared by the repair CLI and the plugin itself.
 *
 * A DSH session log (`*.v4.jsonl.zstd`) is a concatenation of zstd frames, one
 * frame per durable append. The first frame carries the JSONL header record;
 * every later frame carries event rows.
 *
 * Two rules matter here:
 *
 * 1. Frame boundaries must come from the frame *structure*, never from a scan
 *    for the magic bytes: compressed block payloads may contain those bytes by
 *    accident, and splitting there corrupts (or truncates) a real frame.
 * 2. Only event types that this harness does not know *and* that are not marked
 *    `ignorable` make a log unreadable. `team/task`, `team/mode`,
 *    `team/member`, `team/message/*` are first-party events, so a blind
 *    `team/*` rewrite would damage the built-in Agent Teams task board.
 *
 * @module team-mode/session-format
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Little-endian zstd frame magic (`0xFD2FB528`). */
export const ZSTD_MAGIC = 4247762216

/** Event types that the 0.1.x line wrote without the `plugin:` prefix. */
export const LEGACY_EVENT_TYPES = Object.freeze(['team/roster', 'team/staff', 'team/report'])

/** Prefix required for durable plugin records. */
export const PLUGIN_RECORD_PREFIX = 'plugin:team-mode/'

const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/**
 * Locate complete frames by walking frame headers and block headers.
 *
 * Mirrors the harness reader: invalid structure throws, and a torn final frame
 * reports its start offset instead of being treated as a frame.
 *
 * @param buffer - bytes of the whole log.
 * @returns complete frame ranges plus an optional torn-tail offset.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode every complete frame of a log.
 *
 * @param buffer - bytes of the whole log.
 * @returns decoded frame texts with their byte ranges, plus a torn-tail offset.
 */
export function decodeFrames(buffer) {
  const { frames, tornStart } = scanFrames(buffer)
  const decoded = []
  for (const frame of frames) {
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch (error) {
      throw new Error(`frame at byte ${frame.start} does not decompress: ${error instanceof Error ? error.message : String(error)}`)
    }
    decoded.push({ start: frame.start, end: frame.end, text })
  }
  return { frames: decoded, tornStart }
}

/**
 * Compress one frame the way the harness does (checksummed, one append = one frame).
 *
 * @param text - JSONL bytes for this frame.
 * @returns the complete frame.
 */
export function encodeFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS)
}

/**
 * Decide the plugin-record type for one legacy event type.
 *
 * @param type - the event type found in the log.
 * @param knownTypes - event types this harness understands; when omitted only
 *   the three types the 0.1.x line wrote are considered legacy.
 * @returns the repaired type, or undefined when nothing should change.
 */
export function repairedType(type, knownTypes) {
  if (typeof type !== 'string' || !type.startsWith('team/')) return undefined
  if (knownTypes !== undefined && knownTypes !== null) {
    if (knownTypes.has(type)) return undefined
  } else if (!LEGACY_EVENT_TYPES.includes(type)) {
    return undefined
  }
  return PLUGIN_RECORD_PREFIX + type.slice('team/'.length)
}

/**
 * Rewrite the legacy rows of one decoded frame text.
 *
 * Line order, line count and the trailing newline are preserved; untouched
 * rows keep their original bytes.
 *
 * @param text - decoded frame text.
 * @param knownTypes - event types this harness understands.
 * @returns the rewritten text and what changed.
 */
export function repairFrameText(text, knownTypes) {
  const lines = text.split('\n')
  const repaired = []
  const repairs = []
  const knownSkipped = []
  for (const line of lines) {
    if (line.trim() === '') {
      repaired.push(line)
      continue
    }
    let event
    try {
      event = JSON.parse(line)
    } catch {
      repaired.push(line)
      continue
    }
    const next = repairedType(event?.type, knownTypes)
    if (next === undefined) {
      if (typeof event?.type === 'string' && event.type.startsWith('team/')) knownSkipped.push({ seq: event.seq, type: event.type })
      repaired.push(line)
      continue
    }
    repairs.push({ seq: event.seq, type: event.type })
    repaired.push(JSON.stringify({ ...event, type: next, ignorable: true }))
  }
  return { text: repaired.join('\n'), repairs, knownSkipped }
}

/**
 * Rewrite a whole log while preserving every untouched frame byte-for-byte.
 *
 * @param buffer - bytes of the whole log.
 * @param knownTypes - event types this harness understands.
 * @returns the new log bytes, the repairs, and whether anything changed.
 */
export function repairLogBuffer(buffer, knownTypes) {
  const { frames, tornStart } = decodeFrames(buffer)
  const pieces = []
  const repairs = []
  const knownSkipped = []
  let changedFrames = 0
  let changedBytes = 0
  for (const frame of frames) {
    const result = repairFrameText(frame.text, knownTypes)
    repairs.push(...result.repairs)
    knownSkipped.push(...result.knownSkipped)
    if (result.repairs.length === 0) {
      pieces.push(buffer.subarray(frame.start, frame.end))
      continue
    }
    changedFrames += 1
    changedBytes += frame.end - frame.start
    pieces.push(encodeFrame(result.text))
  }
  if (tornStart !== undefined) pieces.push(buffer.subarray(tornStart))
  return {
    buffer: Buffer.concat(pieces),
    frames: frames.length,
    tornStart,
    changedFrames,
    changedBytes,
    repairs,
    knownSkipped,
    changed: repairs.length > 0,
  }
}

/**
 * Count the legacy rows of one decoded frame text without rewriting it.
 *
 * @param text - decoded frame text.
 * @param knownTypes - event types this harness understands.
 * @returns the legacy rows found.
 */
export function legacyRows(text, knownTypes) {
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (repairedType(event?.type, knownTypes) !== undefined) rows.push({ seq: event.seq, type: event.type })
  }
  return rows
}

/**
 * Resolve the default DSH sessions directory.
 *
 * @param home - explicit DSH home, if any.
 * @returns the `sessions` directory path.
 */
export function sessionsRoot(home) {
  const base = typeof home === 'string' && home !== ''
    ? home
    : typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  return path.join(base, 'sessions')
}

/**
 * Find recent session logs that still carry legacy rows.
 *
 * The scan is capped by count and file size so it stays cheap enough to run on
 * plugin activation. Unreadable files are skipped rather than reported.
 *
 * @param options - `home`, `limit` (default 6) and `maxBytes` (default 8 MiB).
 * @returns findings, newest first.
 */
export function findLegacyLogs(options = {}) {
  const limit = options.limit ?? 6
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const knownTypes = options.knownTypes
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        try {
          const stat = statSync(full)
          if (stat.size > 0 && stat.size <= maxBytes) files.push({ file: full, mtime: stat.mtimeMs, size: stat.size })
        } catch {
          // A log can disappear between listing and stat; ignore it.
        }
      }
    }
  }
  walk(sessionsRoot(options.home), 1)
  files.sort((left, right) => right.mtime - left.mtime)
  const findings = []
  for (const entry of files.slice(0, limit)) {
    let rows
    try {
      rows = decodeFrames(readFileSync(entry.file)).frames.flatMap(frame => legacyRows(frame.text, knownTypes))
    } catch {
      continue
    }
    if (rows.length === 0) continue
    findings.push({
      file: entry.file,
      session: path.basename(path.dirname(entry.file)),
      count: rows.length,
      rows,
      types: [...new Set(rows.map(row => row.type))],
    })
  }
  return findings
}
