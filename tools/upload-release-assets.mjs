#!/usr/bin/env node
// Attach npm tarballs to existing GitHub releases.
//
//   node tools/upload-release-assets.mjs 1.0.1 1.0.2
//
// For each version it downloads https://registry.npmjs.org/dsh-team-mode/-/dsh-team-mode-<v>.tgz
// and uploads it to the matching release tag v<v> as an asset. Existing assets with the same
// name are skipped, so the script is safe to rerun.

import { execFileSync } from 'node:child_process'

const REPOSITORY = 'luokexiaoguo/dsh-team-mode'
const versions = process.argv.slice(2).filter(argument => /^\d+\.\d+\.\d+$/u.test(argument))
if (versions.length === 0) {
  console.error('usage: node tools/upload-release-assets.mjs <version> [version ...]')
  process.exit(1)
}

function gitCredentialToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const line = out.split(/\r?\n/u).find(row => row.startsWith('password='))
  return line?.slice('password='.length)
}

const token = process.env.GITHUB_TOKEN?.trim() || gitCredentialToken()
if (!token) {
  console.error('no GitHub token: set GITHUB_TOKEN or make sure `git credential fill` works')
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'dsh-team-mode-release-assets',
  Accept: 'application/vnd.github+json',
}

async function json(method, url) {
  const response = await fetch(url, { method, headers })
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${await response.text()}`)
  return response.json()
}

const releases = await json('GET', `https://api.github.com/repos/${REPOSITORY}/releases`)

for (const version of versions) {
  const release = releases.find(entry => entry.tag_name === `v${version}`)
  if (!release) {
    console.log(`- v${version}: no release, skipped`)
    continue
  }
  const name = `dsh-team-mode-${version}.tgz`
  if (release.assets.some(asset => asset.name === name)) {
    console.log(`- v${version}: ${name} already attached`)
    continue
  }
  const tarball = await fetch(`https://registry.npmjs.org/dsh-team-mode/-/dsh-team-mode-${version}.tgz`)
  if (!tarball.ok) {
    console.log(`- v${version}: npm tarball ${tarball.status}, skipped`)
    continue
  }
  const bytes = Buffer.from(await tarball.arrayBuffer())
  const uploadUrl = `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${name}&label=${encodeURIComponent('npm tarball')}`
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length) },
    body: bytes,
  })
  if (!response.ok) throw new Error(`upload ${name} -> ${response.status} ${await response.text()}`)
  const asset = await response.json()
  console.log(`- v${version}: attached ${asset.name} (${asset.size} bytes)`)
}
