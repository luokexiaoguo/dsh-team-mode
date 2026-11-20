#!/usr/bin/env node
// Print the module id each installed client bundle registers with, to confirm the
// convention (id must equal the package name, or the client runner drops the bundle).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')
const packages = readdirSync(root).filter(name => name.startsWith('dsh-') || name.startsWith('@'))

for (const name of packages) {
  if (name.startsWith('@')) {
    const scopeDir = join(root, name)
    let entries = []
    try { entries = readdirSync(scopeDir) } catch { continue }
    for (const sub of entries) packages.push(`${name}/${sub}`)
    continue
  }
  const file = join(root, name, 'client.js')
  if (!existsSync(file) || !statSync(file).isFile()) continue
  const text = readFileSync(file, 'utf8')
  const match = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,400}?id\s*:\s*(['"])([^'"]+)\1/u.exec(text)
  console.log(`${name.padEnd(28)} id=${match ? match[2] : '(not found)'}`)
}
