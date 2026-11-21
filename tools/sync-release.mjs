// Create (or reuse) one GitHub release for the current package version, drop older releases,
// keep exactly one. Usage: node tools/sync-release.mjs [--dry-run] [version]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPOSITORY = 'luokexiaoguo/dsh-team-mode'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const version = args.find(argument => /^\d+\.\d+\.\d+$/u.test(argument)) ?? packageVersion
const tag = `v${version}`

function token() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim()
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  return out.split(/\r?\n/u).find(row => row.startsWith('password='))?.slice('password='.length)
}

const auth = {
  Authorization: `Bearer ${token()}`,
  'User-Agent': 'dsh-team-mode-release',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
}

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: auth })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 300)}`)
  return text === '' ? undefined : JSON.parse(text)
}

// A release cannot be created for a tag that does not exist yet: push the tag first.
function ensureTag() {
  const local = execFileSync('git', ['tag', '--list', tag], { encoding: 'utf8' }).trim()
  if (!local) {
    const message = `${tag}`
    if (dryRun) {
      console.log(`would create tag ${tag}`)
    } else {
      execFileSync('git', ['tag', '-a', tag, '-m', message], { stdio: 'inherit' })
      console.log(`created tag ${tag}`)
    }
  } else {
    console.log(`tag ${tag} already exists locally`)
  }
  if (dryRun) {
    console.log(`would push tag ${tag}`)
    return
  }
  execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' })
}

// Release notes come from the matching CHANGELOG section; fall back to a one-liner.
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const section = changelog.split(/^## /mu).find(block => block.startsWith(tag))
const body = section ? `## ${section.trim()}` : `Release ${version}`

ensureTag()

const releases = await api(`/repos/${REPOSITORY}/releases?per_page=50`)
for (const release of releases) {
  if (release.tag_name === tag) continue
  if (dryRun) {
    console.log(`would delete release ${release.tag_name}`)
    continue
  }
  await api(`/repos/${REPOSITORY}/releases/${release.id}`, { method: 'DELETE' })
  console.log(`deleted release ${release.tag_name}`)
}

const existing = releases.find(release => release.tag_name === tag)
if (existing) {
  console.log(`release ready: ${existing.tag_name} id=${existing.id} assets=${existing.assets?.length ?? 0}`)
} else if (dryRun) {
  console.log(`would create release ${tag}`)
} else {
  const release = await api(`/repos/${REPOSITORY}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false, make_latest: 'true' }),
  })
  console.log(`release ready: ${release.tag_name} id=${release.id} assets=${release.assets?.length ?? 0}`)
}
