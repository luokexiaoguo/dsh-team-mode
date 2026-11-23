/**
 * Render smoke test for client.js.
 *
 * The web GUI is served over an authenticated origin, so the panel cannot be
 * opened in a scratch browser. This test loads the real client bundle with a
 * minimal React stand-in (elements + hooks), renders the panel twice (closed and
 * open) against a synthetic projection, and asserts the org chart, the task
 * board and the reports actually reach the tree.
 *
 * Run: node test/render-smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')
const bundleSource = await readFile(bundlePath, 'utf8')

// ---------------------------------------------------------------- React stand-in
const hooks = { openInitial: false, nullInitial: null }

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
  },
  useState(initial) {
    // `openInitial` drives the panel's open/closed state; `viewInitial` drives
    // the list/graph toggle; `nullInitial` seeds the selected role so the
    // click-through detail can be rendered without simulating a click. Each
    // call gets its own slot so the hooks do not read the same value.
    const value = typeof initial === 'string'
      ? (hooks.viewInitial ?? initial)
      : initial === null
        ? (hooks.nullInitial ?? null)
        : (hooks.openInitial ?? initial)
    return [value, () => {}]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
  // The overlay entry subscribes to the module store; a snapshot read is enough
  // here because the test renders each state explicitly.
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

function loadBundle() {
  let mod
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        mod = factory(specifier => {
          if (specifier === 'react') return React
          throw new Error(`unexpected require(${specifier}) from ${id}`)
        })
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const source = bundleSource
  // The bundle touches `window` at module scope; give it one and evaluate it.
  new Function('window', source)(window)
  return mod
}

// ---------------------------------------------------------------- fake projections
const roster = {
  goal: '把「团队模式」插件在 DSH 桌面版落地并验收',
  template: 'software',
  updatedAt: '2026-11-19T20:20:00.000Z',
  roles: [
    { id: 'pm', title: '产品经理', duty: '定义目标、范围与验收标准', deliverables: ['PRD'], reportsTo: 'lead', writeScopes: ['docs/'], name: 'pm' },
    { id: 'research', title: '市场与用户调研', duty: '竞品与用户调研', deliverables: ['调研报告'], reportsTo: 'lead', writeScopes: ['docs/'], name: '' },
    { id: 'architect', title: '架构与方案', duty: '技术方案与接口约定', deliverables: ['方案文档'], reportsTo: 'pm', writeScopes: ['docs/'], name: 'architect' },
    { id: 'frontend', title: '前端实现', duty: '面板与交互实现', deliverables: ['client.js'], reportsTo: 'architect', writeScopes: ['packages/team-mode/'], name: 'frontend' },
    { id: 'qa', title: '质量与缺陷', duty: '验证与回归', deliverables: ['测试报告'], reportsTo: 'pm', writeScopes: ['packages/team-mode/test/'], name: '' },
  ],
  reports: [
    { role: 'frontend', status: 'in_progress', summary: '面板骨架已完成', evidence: ['client.js:129'], blockers: '', next: '补 SSR 冒烟测试', at: '2026-11-19T20:25:00.000Z' },
    { role: 'qa', status: 'blocked', summary: '缺少真实渲染验证', evidence: [], blockers: 'GUI 需要鉴权 token', next: '等 lead 提供入口', at: '2026-11-19T20:30:00.000Z' },
  ],
}

const board = {
  enabled: true,
  tasks: [
    { id: 't1', subject: '写团队面板', status: 'in_progress', ownerName: 'frontend', ready: true, revision: 1 },
    { id: 't2', subject: '渲染冒烟测试', status: 'completed', ownerName: 'qa', ready: false, revision: 2 },
  ],
}

function collector() {
  const texts = []
  const visit = node => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node === 'string' || typeof node === 'number') return void texts.push(String(node))
    if (typeof node.type === 'function') {
      // Composite (ListView, GraphView, TeamChip…): render it for real instead
      // of skipping its subtree, otherwise the assertions see an empty panel.
      visit(node.type(node.props))
      return
    }
    visit(node.props?.children)
  }
  return { texts, visit }
}

function render(overrides = {}) {
  const mod = loadBundle()
  const captured = []
  const ctx = { slots: { inject: (name, register) => register(), register: (opts, Component) => void captured.push({ opts, Component }) } }
  mod.apply(ctx)
  assert.equal(captured.length, 3, 'client bundle must register the team View, the session probe and the composer switch')
  assert.deepEqual(mod.inject, ['slots'])
  const viewEntry = captured.find(entry => entry.opts.name === 'conversation.view')
  const probeEntry = captured.find(entry => entry.opts.name === 'conversation.session.header.utilities')
  const chipEntry = captured.find(entry => entry.opts.name === 'conversation.input.left')
  assert.ok(viewEntry !== undefined, 'the team must be a Conversation View beside 对话 / 轨迹 / 上下文')
  assert.equal(viewEntry.opts.id, 'team')
  assert.equal(viewEntry.opts.label(), '团队')
  assert.equal(probeEntry.opts.id, 'team-mode')
  assert.equal(chipEntry.opts.id, 'team-mode-chip')
  // No floating-layer seat: that layer is not visible in the app shell, and the
  // View already covers the surface.
  assert.equal(captured.some(entry => entry.opts.name === 'shell.overlay'), false, 'the panel no longer lives on the overlay seat')
  const team = overrides.team === undefined ? roster : overrides.team
  // A child Session summary with running:true is the liveness signal the panel
  // uses when a member is mid-turn and has not reported yet.
  const sessionsState = overrides.sessions === undefined
    ? {
      items: [
        { sessionId: 'child-architect', running: true, parentSessionId: 'session-test' },
        { sessionId: 'child-frontend', running: false, parentSessionId: 'session-test' },
        { sessionId: 'unrelated', running: true },
      ],
      projectionsBySession: {
        'session-test': {
          values: {
            subagentCatalog: [
              { id: 'child-architect', name: 'architect', mode: 'continuable', label: '架构与方案' },
              { id: 'child-frontend', name: 'frontend', mode: 'continuable', label: '前端实现' },
            ],
          },
        },
      },
    }
    : overrides.sessions
  const props = {
    useProjection: key => (key === 'teamMode' ? team : key === 'agentTeam' ? board : undefined),
    sessionId: 'session-test',
    useSessions: selector => (typeof selector === 'function' ? selector(sessionsState) : sessionsState),
    inputActions: overrides.inputActions,
  }
  return {
    // The View seat reads the session's own projections and always renders.
    view: viewEntry.Component(props),
    viewOpts: viewEntry.opts,
    // The session probe feeds the module store; it renders nothing itself.
    probe: probeEntry.Component(props),
    chip: chipEntry.Component(props),
    chipOpts: chipEntry.opts,
    opts: viewEntry.opts,
  }
}

// closed: the View renders the panel body, while the session probe stays silent
hooks.openInitial = false
{
  const { view, probe } = render()
  assert.equal(probe, null, 'the session probe renders nothing')
  const { texts, visit } = collector()
  visit(view)
  const joined = texts.join(' ')
  assert.match(joined, /团队模式/, 'the View must show the team')
  console.log('view    ok:', joined.slice(0, 100), '…')
}

// the View renders the whole panel — the team surface is the tab body, not a
// floating card, so nothing depends on a button being pressed first
{
  const { view, probe } = render()
  assert.equal(probe, null, 'the session probe renders nothing')
  const { texts, visit } = collector()
  visit(view)
  const joined = texts.join(' | ')
  for (const needle of ['团队模式', 'software', '目标', '把「团队模式」插件', '组织 3/5', '产品经理', '市场与用户调研', '未上岗', '任务板 · 1/2 完成', '写团队面板', '最近动向', '面板骨架已完成', '阻塞：GUI 需要鉴权 token', '下一步：等 lead 提供入口', '进行中 1 · 完成 1 · 待上岗 2']) {
    assert.ok(joined.includes(needle), `the team View is missing ${needle}`)
  }
  // depth: architect reports to pm, so it must be indented one level deeper
  const blocks = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node.type === 'function') return walk(node.type(node.props))
    if (node.props?.style?.borderLeft && node.props.style.marginLeft) blocks.push(node.props.style.marginLeft)
    walk(node.props?.children)
  }
  walk(view)
  // pm at the top, architect under it, frontend under that, then qa beside
  // architect and research beside pm — i.e. a real reporting tree, not a flat list.
  assert.deepEqual(blocks, ['0px', '14px', '28px', '14px', '0px'], 'org chart indentation must follow the reporting line')
  console.log('open    ok:', joined.slice(0, 160), '…')
  console.log('indent  ok:', blocks.join(' '))
}

// the composer switch: label follows the session policy and a click toggles it
{
  const sent = []
  const inputActions = {
    setDraft: line => sent.push(['draft', line]),
    submit: () => sent.push(['submit']),
  }
  const on = render({ team: { ...roster, auto: true }, inputActions })
  const off = render({ team: { ...roster, auto: false }, inputActions })
  const auto = render({ team: { ...roster, auto: null }, inputActions })
  const chipText = node => {
    const { texts, visit } = collector()
    visit(node)
    return texts.join(' ')
  }
  assert.equal(on.chipOpts.label, '团队开关')
  // three states must be visibly different: 自动 (follow default) / 开 / 关
  assert.match(chipText(on.chip), /团队 · 开 3\/5/, 'a forced-on team must show its staffing')
  assert.equal(on.chip.props['data-team-mode-state'], 'on')
  assert.match(chipText(off.chip), /团队 · 关/)
  assert.equal(off.chip.props['data-team-mode-state'], 'off')
  assert.match(chipText(auto.chip), /团队 · 自动 3\/5/, 'auto must not look identical to forced on')
  assert.equal(auto.chip.props['data-team-mode-state'], 'auto')
  // clicking the chip drafts the slash command and submits it right away
  on.chip.props.onClick()
  off.chip.props.onClick()
  assert.deepEqual(sent, [['draft', '/team off'], ['submit'], ['draft', '/team on'], ['submit']])
  console.log('switch  ok:', chipText(on.chip), '|', chipText(off.chip), '|', chipText(auto.chip))
}

// the View header: the state badge is a real button, the header carries a
// heartbeat, and every control is labelled for the keyboard/reader
{
  hooks.openInitial = true
  hooks.viewInitial = 'list'
  const sent = []
  const inputActions = { setDraft: line => sent.push(['draft', line]), submit: () => sent.push(['submit']) }
  const { view } = render({ team: { ...roster, auto: true }, inputActions })

  const find = (node, predicate, found = []) => {
    if (!node || typeof node !== 'object') return found
    if (Array.isArray(node)) {
      node.forEach(child => find(child, predicate, found))
      return found
    }
    if (typeof node.type === 'function') return find(node.type(node.props), predicate, found)
    const props = node.props ?? {}
    if (predicate(node.type, props)) found.push({ type: node.type, props })
    return find(props.children, predicate, found)
  }

  const badges = find(view, (type, props) => props['data-team-mode-mode'] !== undefined)
  assert.equal(badges.length, 1, 'the state badge must exist')
  assert.equal(badges[0].type, 'button', 'the state badge used to be a span that looked clickable')
  assert.equal(badges[0].props['data-team-mode-mode'], 'on')
  badges[0].props.onClick()
  assert.deepEqual(sent, [['draft', '/team off'], ['submit']], 'clicking the badge must flip the switch')

  // The View is a page, not a popup: no close button, and the heartbeat lives
  // on the panel itself instead of on a launcher.
  const close = find(view, (type, props) => props['data-team-mode-close'] !== undefined)
  assert.equal(close.length, 0, 'a View page needs no close button')
  const panel = find(view, (type, props) => props['data-team-mode-panel'] !== undefined)
  assert.equal(panel.length, 1, 'the View renders the panel exactly once')
  assert.equal(panel[0].props['data-team-mode-heartbeat'], 'busy', 'in-progress tasks must surface')
  assert.match(panel[0].props.title, /进行中/, 'the panel title must carry the counts')
  assert.equal(panel[0].props.role, 'region', 'the View is a region, not a dialog')

  const views = find(view, (type, props) => props['data-team-mode-view'] !== undefined)
  assert.deepEqual(views.map(node => node.props['aria-label']).sort(), ['切换到列表视图', '切换到图谱视图'])
  console.log('header  ok: badge is a button, heartbeat =', panel[0].props['data-team-mode-heartbeat'])
}

// an empty team renders the View's explanation instead of a blank page, and the
// composer switch stays available
{
  const { view, chip } = render({ team: { goal: '', template: 'generic', roles: [], reports: [] } })
  const { texts, visit } = collector()
  visit(view)
  const joined = texts.join(' ')
  assert.match(joined, /用团队模式做这件事/, 'an empty team must explain how one gets formed')
  assert.ok(chip !== null && chip !== undefined, 'the switch must survive an empty roster')
  console.log('empty   ok: explanation shown, switch still rendered')
}

console.log('\nall render smoke checks passed')
// the node graph: one node per role, a connector per reporting line, tasks hung
// under their owner, and flowing dashes for a member that is still working
{
  hooks.viewInitial = 'graph'
  const { view } = render()
  const nodes = []
  const paths = []
  const walkGraph = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walkGraph)
    if (typeof node.type === 'function') return walkGraph(node.type(node.props))
    const props = node.props ?? {}
    if (typeof props['data-team-mode-node'] === 'string') nodes.push(props['data-team-mode-node'])
    if (node.type === 'path') paths.push(props)
    walkGraph(props.children)
  }
  walkGraph(view)
  assert.deepEqual(nodes.sort(), ['architect', 'frontend', 'pm', 'qa', 'research'], 'graph must draw every role')
  // three reporting lines (pm, research -> lead; architect -> pm; frontend -> architect; qa -> pm = 4 non-lead roles)
  assert.equal(paths.filter(path => path.stroke !== undefined).length >= 4, true, 'every non-lead role needs a connector')
  const flowing = paths.filter(path => typeof path.strokeDasharray === 'string')
  assert.ok(flowing.length >= 1, 'a member with an in-progress report must animate its connector')
  const { texts, visit } = collector()
  visit(view)
  const joined = texts.join(' | ')
  for (const needle of ['图谱 3/5', '写团队面板', '渲染冒烟测试', '正在干活', '交接 ']) {
    assert.ok(joined.includes(needle), `graph is missing ${needle}`)
  }
  // the lead is drawn explicitly, so "who handed this down" is on screen
  const lead = []
  const collectLead = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collectLead)
    if (typeof node.type === 'function') return collectLead(node.type(node.props))
    const props = node.props ?? {}
    if (props['data-team-mode-lead'] === 'true') lead.push(props)
    collectLead(props.children)
  }
  collectLead(view)
  assert.equal(lead.length, 1, 'the graph must draw the lead every root reports to')
  const arrows = paths.filter(path => typeof path.markerEnd === 'string')
  assert.equal(arrows.length, 5, 'every reporting line must point from the superior to the subordinate')
  // the working member is highlighted, the idle ones are not
  const working = []
  const collectWorking = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collectWorking)
    if (typeof node.type === 'function') return collectWorking(node.type(node.props))
    const props = node.props ?? {}
    if (typeof props['data-team-mode-node'] === 'string' && props['data-team-mode-working'] === 'true') working.push(props['data-team-mode-node'])
    collectWorking(props.children)
  }
  collectWorking(view)
  assert.deepEqual(working, ['architect', 'frontend'], 'a live child Session or an in-progress report must pulse')
  // every node is clickable, so the detail pane can be opened from the graph
  const clickable = []
  const collectClicks = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collectClicks)
    if (typeof node.type === 'function') return collectClicks(node.type(node.props))
    const props = node.props ?? {}
    if (typeof props['data-team-mode-node'] === 'string' && typeof props.onClick === 'function') clickable.push(props['data-team-mode-node'])
    collectClicks(props.children)
  }
  collectClicks(view)
  assert.equal(clickable.length, 5, 'every graph node must open its detail pane')
  console.log('graph   ok:', nodes.join(','), '| connectors:', paths.filter(path => path.stroke !== undefined).length, '| working:', working.join(','))
  hooks.viewInitial = 'list'

  // click-through detail: the selected role's charter, tasks and last reports
  hooks.viewInitial = 'graph'
  hooks.nullInitial = 'qa'
  {
    const { view: detailTree } = render()
    const detail = collector()
    detail.visit(detailTree)
    const text = detail.texts.join(' | ')
    for (const needle of ['角色详情 · 质量与缺陷', '职责：', '验证与回归', '交付物：', '测试报告', '写入范围：', 'packages/team-mode/test/', '渲染冒烟测试', '阻塞：GUI 需要鉴权 token', '收起详情']) {
      assert.ok(text.includes(needle), `detail pane is missing ${needle}`)
    }
    const panes = []
    const findPane = node => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(findPane)
      if (typeof node.type === 'function') return findPane(node.type(node.props))
      const props = node.props ?? {}
      if (typeof props['data-team-mode-detail'] === 'string') panes.push(props['data-team-mode-detail'])
      findPane(props.children)
    }
    findPane(detailTree)
    assert.deepEqual(panes, ['qa'], 'the detail pane must open for the selected node only')
    console.log('detail  ok:', text.slice(text.indexOf('角色详情'), text.indexOf('角色详情') + 120), '…')
  }
  hooks.nullInitial = null
}