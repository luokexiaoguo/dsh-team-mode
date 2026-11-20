// Create the v1.0.3 release from the CHANGELOG, drop older releases, keep exactly one.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPOSITORY = 'luokexiaoguo/dsh-team-mode'

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

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const section = changelog.split(/^## /mu).find(block => block.startsWith('v1.0.3'))
const body = section ? `## ${section.trim()}` : 'Release 1.0.3'

const releases = await api(`/repos/${REPOSITORY}/releases?per_page=20`)
for (const release of releases) {
  if (release.tag_name !== 'v1.0.3') {
    await api(`/repos/${REPOSITORY}/releases/${release.id}`, { method: 'DELETE' })
    console.log(`deleted release ${release.tag_name}`)
  }
}

const existing = releases.find(release => release.tag_name === 'v1.0.3')
const release = existing ?? await api(`/repos/${REPOSITORY}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: 'v1.0.3', name: 'v1.0.3', body, draft: false, prerelease: false, make_latest: 'true' }),
})
console.log(`release ready: ${release.tag_name} id=${release.id} assets=${release.assets?.length ?? 0}`)
