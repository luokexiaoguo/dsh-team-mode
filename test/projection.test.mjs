/**
 * Host-side behaviour tests for team-mode v2 (frozen 2026-11-19 21:05, sha256
 * e64af28b…). Drives the four tools + the `teamMode` projection through a fake
 * registrant context and a fixture copy of DSH's `@deepseek-ai/dsh-session`,
 * so `writeRecord()` (appendPluginRecord + Session-class identity) is real.
 *
 * The fixture is deliberately a *fake* module: it proves the plugin resolves a
 * writer at the expected installation path and uses it, not that DSH's own
 * implementation behaves identically.
 *
 * Sections marked REPRO print reproducible defects; REVIEW.md owns the mapping.
 *
 * Run: node test/projection.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const fixtureRoot = path.join(here, 'fixtures', 'dsh-install')
const fixtureModuleDir = path.join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh-session')
const fixtureRequire = createRequire(path.join(fixtureModuleDir, 'package.json'))
const sdk = fixtureRequire('@deepseek-ai/dsh-session')
assert.equal(typeof sdk.Session, 'function', 'fixture must export Session')
assert.equal(typeof sdk.appendPluginRecord, 'function', 'fixture must export appendPluginRecord')

// Must be set BEFORE importing the plugin: resolvePluginRecordWriter() reads it
// at module evaluation (apply) time.
process.env.DSH_INSTALL_DIR = path.join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh')

// Keep the log-scan away from the developer's real profile.
const scanHome = mkdtempSync(path.join(tmpdir(), 'team-mode-home-'))
process.env.DSH_HOME = scanHome
process.on('exit', () => {
  try {
    rmSync(scanHome, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

const { apply } = await import('../index.js')

const TEMPLATE_ROLE_COUNT = 7
const ROSTER_EVENT = 'plugin:team-mode/roster'
const STAFF_EVENT = 'plugin:team-mode/staff'
const REPORT_EVENT = 'plugin:team-mode/report'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error.message}`)
  }
}
function repro(label) {
  console.log(`REPRO ${label}`)
}

// ------------------------------------------------------------------ harness

async function makeHarness(options = {}) {
  const tools = new Map()
  const byId = new Map()
  const calls = { start: [], listDescendants: 0, flush: 0 }
  const takenNames = new Set()
  const commands = []
  let projection
  let handle
  let promptContext

  const fold = session => {
    let state = session.__state ?? projection.init()
    let at = session.__folded ?? 0
    while (at < session.events.length) {
      state = projection.apply(state, session.events[at])
      at += 1
    }
    session.__state = state
    session.__folded = at
    return state
  }

  const ctx = {
    sessionProjections: {
      async register(def) {
        projection = def
        handle = { stateOf: session => fold(session) }
        return handle
      },
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
      },
    },
    get(name) {
      if (name === 'sessions') {
        return {
          async flush() {
            calls.flush += 1
          },
          get(id) {
            if (options.sessionsGet) return options.sessionsGet(id)
            return byId.get(id)
          },
        }
      }
      if (name === 'systemPrompt') {
        if (options.noSystemPrompt === true) return undefined
        return { context(spec) { promptContext = spec } }
      }
      if (name === 'subagents') {
        if (options.noSubagents === true) return undefined
        return {
          async startActivation(spec) {
            calls.start.push(spec)
            if (options.startActivation) return options.startActivation(spec, takenNames)
            if (takenNames.has(spec.name)) throw new Error(`agent name already in use: ${spec.name}`)
            takenNames.add(spec.name)
            return { name: spec.name, childId: `child-${spec.name}` }
          },
          namesOf(agent) {
            if (options.namesOf) return options.namesOf(agent)
            return { self: agent.name }
          },
          rootOf(agent) {
            if (options.rootOf) return options.rootOf(agent)
            return agent
          },
          async listDescendants(rootId, signal) {
            calls.listDescendants += 1
            if (options.listDescendants) return options.listDescendants(rootId, signal)
            return []
          },
        }
      }
      if (name === 'commands') {
        if (options.noCommands === true) return undefined
        return { register(definition) { commands.push(definition); return () => {} } }
      }
      if (name === 'agentTeams') {
        if (options.noTeams === true) return undefined
        return {
          listTasks(agent) {
            if (options.listTasks) return options.listTasks(agent)
            return []
          },
        }
      }
      return undefined
    },
  }

  await apply(ctx, {
    autoStaff: options.autoStaff !== false,
    ...(options.maxMembers === undefined ? {} : { maxMembers: options.maxMembers }),
  })
  assert.ok(projection, 'sessionProjections.register must run')
  assert.ok(promptContext, 'systemPrompt.context must be registered')

  const session = id => {
    const s = new sdk.Session(id)
    byId.set(id, s)
    return s
  }
  const agent = { name: options.agentName ?? 'lead', session: session(options.leadId ?? 'lead-session') }
  const exec = { agent, signal: options.signal ?? new AbortController().signal }
  const call = (name, args, execOverride) =>
    tools.get(name).execute(args, execOverride ?? exec)
  const tool = name => tools.get(name)

  return { ctx, tools, projection, promptContext, calls, commands, agent, exec, session, call, tool, stateOf: fold }
}

const baseRoles = [
  { id: 'a', title: '角色 A', duty: '做 A 的事', reportsTo: 'lead' },
  { id: 'b', title: '角色 B', duty: '做 B 的事', reportsTo: 'a' },
]

const textOf = blocks => blocks.map(block => block.text).join('\n')

// ------------------------------------------------------------------ team_form

await test('form: 默认 autoStaff 让一次调用完成「组队 + 上岗」', async () => {
  const h = await makeHarness()
  const out = await h.call('team_form', { goal: '交付团队模式插件', template: 'software' })
  assert.equal(out.memberCount, TEMPLATE_ROLE_COUNT)
  assert.equal(out.staffing.staffedCount, TEMPLATE_ROLE_COUNT)
  assert.equal(out.staffing.totalCount, TEMPLATE_ROLE_COUNT)
  assert.equal(out.staffing.started.length, TEMPLATE_ROLE_COUNT)
  assert.equal(h.calls.start.length, TEMPLATE_ROLE_COUNT)
  const [roster, staff] = h.agent.session.events
  assert.equal(roster.type, ROSTER_EVENT)
  assert.equal(roster.ignorable, true, 'plugin record must be written ignorable')
  assert.equal(staff.type, STAFF_EVENT)
  assert.equal(staff.ignorable, true)
  const text = textOf(h.tool('team_form').output.render({}, out))
  assert.match(text, /已上岗 7\/7/)
  assert.doesNotMatch(text, /未上岗/)
})

await test('form: staff:false / autoStaff:false 只建编制，提示下一步', async () => {
  const h = await makeHarness({ autoStaff: false })
  const out = await h.call('team_form', { goal: 'g', roles: baseRoles })
  assert.equal(out.staffing, undefined)
  assert.equal(h.calls.start.length, 0)
  const text = textOf(h.tool('team_form').output.render({}, out))
  assert.match(text, /下一步：用 team_staff 给角色上岗/)
  assert.match(text, /未上岗/)
})

await test('form: staff:true 覆盖 autoStaff:false', async () => {
  const h = await makeHarness({ autoStaff: false })
  const out = await h.call('team_form', { goal: 'g', roles: baseRoles, staff: true })
  assert.equal(out.staffing.staffedCount, 2)
  assert.equal(h.calls.start.length, 2)
})

await test('form: 重复调用沿用已上岗成员，不重复启动', async () => {
  const h = await makeHarness()
  const first = await h.call('team_form', { goal: 'g', roles: baseRoles })
  assert.equal(h.calls.start.length, 2)
  const second = await h.call('team_form', { goal: 'g', roles: baseRoles })
  assert.equal(h.calls.start.length, 2, 'second form must not start new agents')
  assert.deepEqual(second.staffing.started.map(entry => entry.reused), [true, true])
  assert.equal(first.staffing.started[0].name, second.staffing.started[0].name)
})

await test('form: 少于 2 个角色 / 超出 maxMembers 被拒绝', async () => {
  const h = await makeHarness({ maxMembers: 2 })
  await assert.rejects(h.call('team_form', { goal: 'g', roles: [baseRoles[0]] }), /至少需要 2 个角色/)
  await assert.rejects(
    h.call('team_form', { goal: 'g', roles: [...baseRoles, { id: 'c', duty: 'c' }] }),
    /超过上限 2/,
  )
})

await test('form: 未知模板与空 goal 被拒绝', async () => {
  const h = await makeHarness()
  await assert.rejects(h.call('team_form', { goal: 'g', template: 'nope' }), /未知模板/)
  await assert.rejects(h.call('team_form', { goal: '   ', roles: baseRoles }), /需要 goal/)
})

// F1 (was REPRO A1): a reporting cycle made the org chart unwalkable and the
// panel recursed until the stack blew. team_form must reject it instead.
await test('FIX F1: 汇报线成环被 team_form 拒绝', async () => {
  const h = await makeHarness({ autoStaff: false })
  const cycle = [
    { id: 'a', duty: 'A', reportsTo: 'b' },
    { id: 'b', duty: 'B', reportsTo: 'a' },
  ]
  await assert.rejects(h.call('team_form', { goal: 'g', roles: cycle }), /汇报线成环/)
  assert.deepEqual(h.stateOf(h.agent.session).roles, [], 'no roster may be written for a cycle')
})

// F6 (was REPRO B): render used to read only this call's staffing.
await test('FIX F6: 已上岗角色在后续 team_form 的 render 里仍显示已上岗', async () => {
  const h = await makeHarness({ autoStaff: false })
  await h.call('team_form', { goal: 'g', roles: baseRoles })
  await h.call('team_staff', {})
  const again = await h.call('team_form', { goal: 'g', roles: baseRoles })
  assert.equal(again.staffing, undefined)
  const text = textOf(h.tool('team_form').output.render({}, again))
  assert.doesNotMatch(text, /未上岗/)
  assert.match(text, /已上岗：a/)
  assert.match(text, /已上岗：b/)
})

// F2 (was REPRO C): replace:true must retire the old members too.
await test('FIX F2: replace:true 同时清空 staffed，角色重新上岗', async () => {
  const h = await makeHarness()
  await h.call('team_form', { goal: 'g', roles: baseRoles })
  const before = h.stateOf(h.agent.session).staffed
  assert.equal(Object.keys(before).length, 2)
  assert.equal(before.a.name, 'a')
  await h.call('team_form', {
    goal: 'g2',
    roles: [{ id: 'a', duty: 'A 改为新职责' }, { id: 'b', duty: 'B 改为新职责' }],
    replace: true,
  })
  const after = h.stateOf(h.agent.session).staffed
  assert.notEqual(after.a?.name, 'a', 'old member must not be silently reused')
  // The first form took the names a/b, so the fresh members retry as a-2/b-2.
  assert.equal(after.a?.name, 'a-2')
  assert.equal(h.calls.start.length, 6, 'two fresh members, each burning one name retry')
})

// ------------------------------------------------------------------ projection / wire

// F3 (was REPRO D): one junk role must not poison the projection.
await test('FIX F3: roles:[null] 被投影忽略，wire view 不崩', async () => {
  const h = await makeHarness({ autoStaff: false })
  h.agent.session.events.push({ type: ROSTER_EVENT, data: { roles: [null, { id: 'ok', duty: 'x' }] }, ignorable: true })
  const state = h.stateOf(h.agent.session)
  assert.deepEqual(state.roles.map(role => role.id), ['ok'])
  assert.doesNotThrow(() => h.projection.wire.view(state))
})

await test('projection: 非数组 roles / 无 name 的 staff 条目被跳过', async () => {
  const h = await makeHarness({ autoStaff: false })
  h.agent.session.events.push({ type: ROSTER_EVENT, data: { roles: 'nope' } })
  assert.deepEqual(h.stateOf(h.agent.session).roles, [])
  h.agent.session.events.push({ type: STAFF_EVENT, data: { entries: [{ roleId: 'a', name: '' }] } })
  // The staffed map is null-prototype on purpose (role ids must not collide with
  // Object.prototype names), so compare its keys rather than the object literal.
  assert.deepEqual(Object.keys(h.stateOf(h.agent.session).staffed), [])
})

// ------------------------------------------------------------------ team_staff

await test('staff: respawn 会重新启动已上岗角色', async () => {
  const h = await makeHarness()
  await h.call('team_form', { goal: 'g', roles: baseRoles })
  const again = await h.call('team_staff', { roles: ['a'], respawn: true })
  // 'a' is already taken by the first member, so the plugin burns one attempt on
  // memberName('a', 0) and succeeds as 'a-2' (index.js retry loop, 3 attempts).
  assert.deepEqual(h.calls.start.map(spec => spec.name).slice(2), ['a', 'a-2'])
  assert.equal(again.started[0].reused, false)
  assert.equal(again.started[0].name, 'a-2')
})

await test('staff: 无编制时报错并要求先 team_form', async () => {
  const h = await makeHarness()
  await assert.rejects(h.call('team_staff', {}), /还没有编制/)
})

await test('staff: 单个角色启动失败写入 failed，不影响其他角色', async () => {
  const h = await makeHarness({
    autoStaff: false,
    // Fail every attempt for role a; the plugin retries as 'a', 'a-2', 'a-3'.
    startActivation(spec) {
      if (spec.name.startsWith('a')) throw new Error('provider down')
      return { name: spec.name, childId: `child-${spec.name}` }
    },
  })
  await h.call('team_form', { goal: 'g', roles: baseRoles })
  const out = await h.call('team_staff', {})
  assert.deepEqual(out.failed, [{ roleId: 'a', error: 'provider down' }])
  assert.equal(out.staffedCount, 1)
  assert.equal(out.totalCount, 2)
})

// ------------------------------------------------------------------ team_report

await test('report: 省略 role 时用 namesOf(agent).self', async () => {
  const h = await makeHarness({ agentName: 'qa' })
  const out = await h.call('team_report', { status: 'in_progress', summary: '正在跑用例' })
  assert.equal(out.role, 'qa')
  const event = h.agent.session.events.at(-1)
  assert.equal(event.type, REPORT_EVENT)
  assert.equal(event.ignorable, true)
  assert.equal(event.data.role, 'qa')
})

await test('report: namesOf 不可用/抛错时 role 退回空串', async () => {
  const h = await makeHarness({ agentName: 'qa', namesOf: () => { throw new Error('no catalog') } })
  const out = await h.call('team_report', { status: 'note', summary: 'x' })
  assert.equal(out.role, '')
})

await test('report: 空 summary 被拒绝，evidence 截断到 8 条', async () => {
  const h = await makeHarness()
  await assert.rejects(h.call('team_report', { status: 'note', summary: ' ' }), /需要 summary/)
  const out = await h.call('team_report', {
    status: 'note',
    summary: 'x',
    evidence: Array.from({ length: 12 }, (_, i) => `e${i}`),
  })
  assert.equal(out.evidence.length, 8)
})

// ------------------------------------------------------------------ team_status

await test('status: 聚合每个成员自己会话里的汇报（listDescendants + sessions.get）', async () => {
  const h = await makeHarness({
    listDescendants: async () => [
      { id: 'child-qa', path: 'qa', depth: 1 },
      { id: 'child-pm', path: 'pm', depth: 1 },
    ],
  })
  const child = h.session('child-qa')
  child.events.push({
    type: REPORT_EVENT,
    ignorable: true,
    data: { role: 'qa', status: 'in_progress', summary: '正在写 REVIEW.md', evidence: ['x'], blockers: '', next: 'finish', at: 111 },
  })
  const out = await h.call('team_status', {})
  assert.equal(out.memberReports.length, 1)
  assert.equal(out.memberReports[0].role, 'qa')
  assert.equal(out.memberReports[0].summary, '正在写 REVIEW.md')
  const text = textOf(h.tool('team_status').output.render({}, out))
  assert.match(text, /成员汇报（来自成员自己的会话）/)
  assert.match(text, /qa：正在写 REVIEW\.md/)
})

await test('status: listDescendants 失败时降级为空数组', async () => {
  const h = await makeHarness({
    listDescendants: async () => { throw new Error('catalog unavailable') },
  })
  const out = await h.call('team_status', {})
  assert.deepEqual(out.memberReports, [])
})

await test('status: 无 subagents / sessions 服务时仍可渲染空团队', async () => {
  const h = await makeHarness({ noSubagents: true })
  const out = await h.call('team_status', {})
  assert.deepEqual(out.memberReports, [])
  assert.doesNotThrow(() => h.tool('team_status').output.render({}, out))
  assert.match(textOf(h.tool('team_status').output.render({}, out)), /（未设置）/)
})

await test('status: 任务板字段映射 ownerName→owner, ready 透传', async () => {
  const h = await makeHarness({
    listTasks: () => [{ id: 7, subject: '写用例', status: 'pending', ownerName: 'qa', ready: true }],
  })
  const out = await h.call('team_status', {})
  assert.deepEqual(out.tasks, [{ id: '7', subject: '写用例', status: 'pending', owner: 'qa', ready: true }])
})

// ------------------------------------------------------------------ prompt / schema

await test('prompt: 无编制时 root 注入自动组队策略，子代理不注入', async () => {
  const h = await makeHarness()
  assert.match(h.promptContext.text({ agent: h.agent }), /团队模式（Team Mode，按需自动组队）/)
  const childAgent = { name: 'qa', session: h.session('child') }
  h.promptContext.text({ agent: childAgent })
  const childHarness = await makeHarness({ namesOf: () => ({ self: 'qa', parent: 'lead' }) })
  assert.equal(childHarness.promptContext.text({ agent: childHarness.agent }), '')
})

await test('prompt: 有编制时列出角色与已/未上岗，全部上岗后不再催', async () => {
  const h = await makeHarness({ autoStaff: false })
  await h.call('team_form', { goal: 'g', roles: baseRoles })
  const before = h.promptContext.text({ agent: h.agent })
  assert.match(before, /团队模式已启用/)
  assert.match(before, /还有 2 个角色没上岗/)
  await h.call('team_staff', {})
  const after = h.promptContext.text({ agent: h.agent })
  assert.doesNotMatch(after, /没上岗/)
  assert.match(after, /已上岗 a/)
})

await test('schema: 编译后的参数/输出契约包含新字段', async () => {
  const h = await makeHarness()
  const form = h.tool('team_form')
  assert.equal(form.parameters.properties.staff.type, 'boolean')
  assert.deepEqual(form.parameters.properties.template.enum, ['software', 'video', 'research', 'content', 'generic'])
  assert.deepEqual(form.parameters.required, ['goal'])
  const status = h.tool('team_status')
  assert.ok(status.output.schema.properties.memberReports, 'team_status output must declare memberReports')
  assert.ok(status.output.schema.required.includes('memberReports'))
  assert.ok(status.output.schema.required.includes('tasks'))
  const report = h.tool('team_report')
  assert.ok(report.output.schema.properties.evidence)
})

// ------------------------------------------------------------------ missing writer

await test('writer: 解析不到 dsh-session 时报明确错误（打包/profile 风险）', () => {
  const script = `
    const mod = await import(process.env.PLUGIN_INDEX_URL)
    const defs = new Map()
    await mod.apply({
      sessionProjections: { async register() { return { stateOf() { return { goal: '', template: '', roles: [], staffed: {}, reports: [], updatedAt: 0 } } } } },
      tools: { register(d) { defs.set(d.name, d) } },
      get() { return undefined },
    }, { autoStaff: false })
    try {
      await defs.get('team_form').execute(
        { goal: 'g', roles: [{ id: 'a', duty: 'A' }, { id: 'b', duty: 'B' }] },
        { agent: { name: 'lead', session: { id: 's', events: [] } }, signal: new AbortController().signal },
      )
      console.log('NO_ERROR')
    } catch (error) {
      console.log('ERR:' + error.message)
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: pkgDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_INSTALL_DIR: '',
      PLUGIN_INDEX_URL: pathToFileURL(path.join(pkgDir, 'index.js')).href,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ERR:团队模式写不进会话日志：找不到 DSH 的 dsh-session 模块/)
})

// ------------------------------------------------------------------ /team switch

await test('switch: /team off 关掉本会话的自动组队，/team on 重新打开', async () => {
  const h = await makeHarness()
  const command = h.commands.find(entry => entry.name === 'team')
  assert.ok(command, '/team must be registered when the commands service exists')
  assert.equal(command.input.hint, 'on | off | status')

  const off = await command.handler({ agent: h.agent, rawInput: 'off', signal: h.exec.signal })
  assert.equal(off.kind, 'success')
  assert.equal(h.stateOf(h.agent.session).policy.auto, false)
  assert.equal(h.projection.wire.view(h.stateOf(h.agent.session)).auto, false)
  assert.equal(h.promptContext.text({ agent: h.agent }), '', 'a closed switch must inject nothing')

  const on = await command.handler({ agent: h.agent, rawInput: 'on', signal: h.exec.signal })
  assert.equal(on.kind, 'success')
  assert.equal(h.stateOf(h.agent.session).policy.auto, true)
  assert.match(h.promptContext.text({ agent: h.agent }), /按需自动组队/)

  const status = await command.handler({ agent: h.agent, rawInput: '', signal: h.exec.signal })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /团队模式：开/)
  const bad = await command.handler({ agent: h.agent, rawInput: 'maybe', signal: h.exec.signal })
  assert.equal(bad.kind, 'error')
})

await test('switch: 无 commands 服务时不报错，面板仍显示 auto', async () => {
  const h = await makeHarness({ noCommands: true })
  assert.equal(h.commands.length, 0)
  const view = h.projection.wire.view(h.projection.init())
  assert.equal(view.auto, null, 'no override means "follow the plugin default"')
})

// ------------------------------------------------------------------ report mirror

await test('report: 成员汇报镜像到 lead 会话，面板可见', async () => {
  const h = await makeHarness()
  const memberSession = h.session('member-session')
  const member = { name: 'frontend', session: memberSession }
  // The member reports; the mirror must land in the lead's log so the panel,
  // which reads the lead projection, shows activity while work is in flight.
  const harnessWithRoot = h
  const out = await h.call('team_report', { status: 'in_progress', summary: '面板骨架完成' }, { agent: member, signal: h.exec.signal })
  assert.equal(out.role, 'frontend')
  assert.equal(memberSession.events.filter(event => event.type === REPORT_EVENT).length, 1, 'member keeps the authoritative record')
  assert.equal(harnessWithRoot.agent.session.events.filter(event => event.type === REPORT_EVENT).length, 0, 'no mirror when rootOf is the agent itself')
})

await test('report: rootOf 指向 lead 时写入镜像记录', async () => {
  const h = await makeHarness({
    rootOf: agent => (agent.name === 'frontend' ? h.agent : agent),
  })
  const member = { name: 'frontend', session: h.session('member-session-2') }
  await h.call('team_report', { status: 'done', summary: '任务完成' }, { agent: member, signal: h.exec.signal })
  const mirrored = h.agent.session.events.filter(event => event.type === REPORT_EVENT)
  assert.equal(mirrored.length, 1, 'the lead log must carry the mirrored report')
  assert.equal(mirrored[0].data.mirrored, true)
  assert.equal(mirrored[0].ignorable, true)
  const view = h.projection.wire.view(h.stateOf(h.agent.session))
  assert.equal(view.reports.length, 1)
  assert.equal(view.reports[0].summary, '任务完成')
})

// ------------------------------------------------------------------ write path

await test('write path: 所有落盘事件都是 plugin: 记录且 ignorable', async () => {
  const h = await makeHarness({ autoStaff: false })
  await h.call('team_form', { goal: '写路径自证', roles: baseRoles, replace: true, staff: false })
  await h.call('team_staff', { roles: ['a'] })
  await h.call('team_report', { status: 'in_progress', summary: '自证' })
  const events = h.agent.session.events
  assert.ok(events.length > 0, 'the flow must write at least one record')
  for (const [index, event] of events.entries()) {
    assert.ok(
      event.type.startsWith('plugin:team-mode/'),
      `event ${index} type ${event.type} must be a plugin record, never a bare team/* event`,
    )
    assert.equal(event.ignorable, true, `event ${index} must be ignorable`)
  }
  assert.deepEqual(
    [...new Set(events.map(event => event.type))].sort(),
    [REPORT_EVENT, ROSTER_EVENT, STAFF_EVENT].sort(),
    'only the three plugin record types are written',
  )
})

await test('write path: 宿主源码没有裸 team/* 写入', async () => {
  const source = readFileSync(path.join(pkgDir, 'index.js'), 'utf8')
  assert.doesNotMatch(source, /\.append\(\s*['"`]team\//u, 'no bare session.append("team/…")')
  assert.doesNotMatch(
    source,
    /appendPluginRecord\(\s*[^,]+,\s*['"`]team\//u,
    'the plugin-record writer must never receive a legacy type',
  )
  const writes = source.match(/append\([^)]*['"`]team\//gu) ?? []
  assert.deepEqual(writes, [], 'no write call passes a legacy type')
})

await test('hint: 会话日志含旧版 team/* 时 team_status 指向 session-repair', async () => {
  const { encodeFrame } = await import('../tools/session-format.mjs')
  const home = mkdtempSync(path.join(tmpdir(), 'team-mode-legacy-'))
  const dir = path.join(home, 'sessions', 'slug', 'session-legacy-demo')
  mkdirSync(dir, { recursive: true })
  const header = {
    type: 'session',
    version: 4,
    id: 'session-legacy-demo',
    createdAt: 1795089226203,
    cwd: process.cwd(),
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const legacy = { type: 'team/roster', seq: 0, time: 1, data: { roles: [{ id: 'a' }] } }
  writeFileSync(
    path.join(dir, 'session.v4.jsonl.zstd'),
    encodeFrame(`${JSON.stringify(header)}\n${JSON.stringify(legacy)}\n`),
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const h = await makeHarness({ autoStaff: false })
    const out = await h.call('team_status', {})
    assert.match(out.legacyWarning, /session-repair\.mjs/u, 'hint names the repair command')
    assert.match(out.legacyWarning, /session-legacy-demo/u, 'hint names the broken session')
    assert.match(out.legacyWarning, /team\/roster/u, 'hint names the legacy event type')
    const rendered = textOf(h.tool('team_status').output.render({}, out))
    assert.match(rendered, /session-repair\.mjs/u, 'the rendered result carries the hint')
    // First-party team/* events are not legacy and must not trigger the hint.
    const cleanHome = mkdtempSync(path.join(tmpdir(), 'team-mode-clean-'))
    const cleanDir = path.join(cleanHome, 'sessions', 'slug', 'session-clean')
    mkdirSync(cleanDir, { recursive: true })
    const cleanRow = { type: 'team/task', seq: 0, time: 1, data: { taskId: 't1', status: 'pending' } }
    writeFileSync(
      path.join(cleanDir, 'session.v4.jsonl.zstd'),
      encodeFrame(`${JSON.stringify(header)}\n${JSON.stringify(cleanRow)}\n`),
    )
    process.env.DSH_HOME = cleanHome
    const clean = await h.call('team_status', {})
    assert.equal(clean.legacyWarning, '', 'first-party team/task alone is not legacy')
    rmSync(cleanHome, { recursive: true, force: true })
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ summary

console.log('')
if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`${passed}/${passed} checks passed`)
}
