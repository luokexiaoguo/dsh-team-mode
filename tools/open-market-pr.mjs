#!/usr/bin/env node
// Open the market submission PR for dsh-team-mode.
//
//   node tools/open-market-pr.mjs --dry-run   # read-only checks, prints the plan
//   node tools/open-market-pr.mjs             # fork if needed, add file, open PR
//
// Credentials come from GITHUB_TOKEN when present, else from the local git
// credential helper (the same token `git push` already uses). Nothing is written
// anywhere except a fork branch; the upstream repo is never touched directly.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const SPECIMEN = join(PACKAGE_ROOT, 'submission', 'awesome-dsh-plugin.yml')
const BRANCH = 'add/dsh-team-mode'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function gitCredentialToken() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const line = out.split(/\r?\n/u).find(row => row.startsWith('password='))
    return line ? line.slice('password='.length) : undefined
  } catch {
    return undefined
  }
}

const token = process.env.GITHUB_TOKEN?.trim() || gitCredentialToken()
if (!token) fail('no GitHub token: set GITHUB_TOKEN or make sure `git credential fill` works')

async function api(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-team-mode-market-pr',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

async function must(method, path, body) {
  const result = await api(method, path, body)
  if (result.status >= 400) fail(`${method} ${path} → ${result.status}: ${result.json?.message ?? result.text.slice(0, 300)}`)
  return result.json
}

function submissionYaml() {
  const raw = readFileSync(SPECIMEN, 'utf8')
  const lines = raw.split(/\r?\n/u)
  const start = lines.findIndex(line => line.startsWith('url:'))
  if (start < 0) fail(`${SPECIMEN}: no "url:" line found`)
  return lines.slice(start).join('\n').replace(/\n*$/u, '\n')
}

const owner = await must('GET', '/user')
const me = owner.login
console.log(`→ signed in as ${me}`)

const repository = await must('GET', `/repos/${me}/dsh-team-mode`)
const createdAt = new Date(repository.created_at)
const ageMs = Date.now() - createdAt.getTime()
const ageHours = ageMs / 3_600_000
console.log(`→ repo ${me}/dsh-team-mode created ${createdAt.toISOString()} (${ageHours.toFixed(1)}h old)`)
if (!Array.isArray(repository.topics) || !repository.topics.includes('dsh-plugin')) {
  console.log('  ! topic dsh-plugin missing — adding it')
  if (!dryRun) await must('PUT', `/repos/${me}/dsh-team-mode/topics`, { names: [...new Set([...(repository.topics ?? []), 'dsh-plugin'])] })
}
if (ageHours < 24) {
  const readyAt = new Date(createdAt.getTime() + 24 * 3_600_000)
  console.log(`  ! market gate needs a repo ≥ 1 day old; ready after ${readyAt.toISOString()}`)
}

await must('GET', `/repos/${UPSTREAM}`)

let fork = await api('GET', `/repos/${me}/${UPSTREAM.split('/')[1]}`)
if (fork.status === 404) {
  console.log(`→ forking ${UPSTREAM} to ${me}`)
  if (!dryRun) {
    await must('POST', `/repos/${UPSTREAM}/forks`, { default_branch_only: true })
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      fork = await api('GET', `/repos/${me}/${UPSTREAM.split('/')[1]}`)
      if (fork.status === 200) break
    }
    if (fork.status !== 200) fail('fork did not become available in 60s')
  }
} else if (fork.status === 200) {
  console.log(`→ fork already exists: ${fork.json.full_name}`)
} else {
  fail(`GET fork → ${fork.status}`)
}

const base = await must('GET', `/repos/${UPSTREAM}/git/ref/heads/main`)
const baseSha = base.object.sha
console.log(`→ upstream main @ ${baseSha.slice(0, 8)}`)

const path = `data/plugins/${me}__dsh-team-mode.yml`
const yaml = submissionYaml()
console.log(`→ would add ${path} (${yaml.length} bytes):\n${yaml.replace(/^/gmu, '    ')}`)

const existingPrs = await must('GET', `/repos/${UPSTREAM}/pulls?state=all&head=${encodeURIComponent(`${me}:${BRANCH}`)}`)
if (Array.isArray(existingPrs) && existingPrs.length > 0) {
  console.log(`→ PR already exists: ${existingPrs[0].html_url} (${existingPrs[0].state})`)
  process.exit(0)
}

if (dryRun) {
  console.log('→ dry run: nothing written')
  process.exit(0)
}

if (ageHours < 24) fail('repository is younger than one day; rerun after the ready time printed above')

const forkRepository = fork.status === 200 ? fork.json : await must('GET', `/repos/${me}/${UPSTREAM.split('/')[1]}`)
const forkOwner = forkRepository.owner.login
const forkName = forkRepository.name

const branch = await api('POST', `/repos/${forkOwner}/${forkName}/git/refs`, {
  ref: `refs/heads/${BRANCH}`,
  sha: baseSha,
})
if (branch.status === 422) {
  console.log(`→ branch ${BRANCH} already on the fork; reusing it`)
} else if (branch.status >= 400) {
  fail(`create branch → ${branch.status}: ${branch.json?.message ?? ''}`)
} else {
  console.log(`→ created branch ${BRANCH}`)
}

const current = await api('GET', `/repos/${forkOwner}/${forkName}/contents/${path}?ref=${BRANCH}`)
const put = await api('PUT', `/repos/${forkOwner}/${forkName}/contents/${path}`, {
  message: `Add ${me}/dsh-team-mode to the plugin list`,
  content: Buffer.from(yaml, 'utf8').toString('base64'),
  branch: BRANCH,
  ...(current.status === 200 ? { sha: current.json.sha } : {}),
})
if (put.status >= 400) fail(`write file → ${put.status}: ${put.json?.message ?? ''}`)
console.log(`→ wrote ${path}`)

const pull = await must('POST', `/repos/${UPSTREAM}/pulls`, {
  title: `Add ${me}/dsh-team-mode to the plugin list`,
  head: `${forkOwner}:${BRANCH}`,
  base: 'main',
  body: [
    'Adds `' + me + '/dsh-team-mode` to the plugin list.',
    '',
    `- repo: https://github.com/${me}/dsh-team-mode`,
    '- category: `workflow`',
    '- declares `dsh.bundle` with `cordis.patch.yml`; `dsh-plugin` topic is set',
    '',
    'What it does: splits a task across role-defined subagents, each with its own',
    'session and write scope, and aggregates their structured reports in a session',
    'panel (list view + organisation graph).',
  ].join('\n'),
})

console.log(`✓ PR opened: ${pull.html_url}`)
