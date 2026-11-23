/**
 * Repro: a reporting-line cycle accepted by team_form makes the panel crash.
 *
 * validateRoster (index.js) rejects duplicate ids, dangling reportsTo and
 * self-reporting, but not a->->b->->a. Client orderRoles then walks children
 * without a visited set, so rendering the panel hits
 * "RangeError: Maximum call stack size exceeded".
 *
 * Run: node test/panel-cycle.mjs   (exit 0 = fixed, exit 1 = the cycle still crashes)
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundleSource = await readFile(join(here, '..', 'client.js'), 'utf8')

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
  },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
}

function loadBundle() {
  let mod
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        mod = factory(specifier => {
          if (specifier === 'react') return React
          throw new Error(`unexpected require(${specifier})`)
        })
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  new Function('window', bundleSource)(window)
  return mod
}

const cyc = [['a', 'b'], ['b', 'a']].map(([id, boss]) => ({
  id,
  title: `角色 ${id}`,
  duty: 'x',
  deliverables: [],
  reportsTo: boss,
  writeScopes: [],
  name: '',
}))

const mod = loadBundle()
const captured = []
mod.apply({
  slots: {
    inject: (_name, register) => register(),
    register: (opts, Component) => void captured.push({ opts, Component }),
  },
})
assert.equal(captured.length, 3, 'team View + session probe + composer switch')

const props = {
  useProjection: key => (key === 'teamMode' ? { goal: 'g', roles: cyc, reports: [] } : { tasks: [] }),
  sessionId: 'session-cycle',
  useSessions: () => 1,
}

// FIX A2: orderRoles carries a visited set, so a cyclic roster that somehow
// reaches the client renders once per role instead of recursing forever.
const view = captured.find(entry => entry.opts.name === 'conversation.view')
const probe = captured.find(entry => entry.opts.name === 'conversation.session.header.utilities')
let error
try {
  // Both halves touch the reporting tree, so both have to survive the cycle.
  probe.Component(props)
  view.Component(props)
} catch (caught) {
  error = caught
}
assert.equal(error, undefined, `panel must not throw on a cyclic roster: ${error?.message}`)
console.log('FIX A2 verified: panel renders a cyclic roster without RangeError')
