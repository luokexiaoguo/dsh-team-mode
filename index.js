/**
 * Team mode: turn one working session into a staffed team.
 *
 * The lead first calls `team_form`, which records a roster (goal + roles with
 * duty, deliverables, reporting line and write scopes) as a `team/roster` event
 * in its own session log. `team_staff` then spawns one subagent per role with a
 * charter composed from that roster, recording `team/staff` so the mapping
 * survives replay. Members report back through `team_report` (structured and
 * durable in their own log) and through the normal completion notice their
 * parent already receives; `team_status` gives the lead the current picture.
 *
 * Everything durable is a session event folded by the `teamMode` projection, so
 * a fork or replay reproduces the same team without any extra storage. The
 * client half reads that projection to draw the org panel.
 *
 * @module @local/team-mode
 */

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { defineTool } from './schema.js'
import { LEGACY_EVENT_TYPES, findLegacyLogs } from './tools/session-format.mjs'

export const name = 'team-mode'

export const inject = ['tools', 'sessionProjections']

/**
 * Durable team records are written as DSH *plugin records*
 * (`plugin:<owner>/<name>` with `ignorable: true`). A released v4 session format
 * refuses to restore an event type it does not know unless it is marked
 * ignorable, so writing a bare custom type such as `team/roster` would make
 * every session that used team mode unopenable after a restart.
 */
const RECORD_PREFIX = 'plugin:team-mode/'
/** Session record appending a roster; folded by the `teamMode` projection. */
const ROSTER_EVENT = `${RECORD_PREFIX}roster`
/** Session record mapping a role to its subagent. */
const STAFF_EVENT = `${RECORD_PREFIX}staff`
/** Session record holding one structured report from a member. */
const REPORT_EVENT = `${RECORD_PREFIX}report`
/** Session record overriding whether this session forms teams on its own. */
const POLICY_EVENT = `${RECORD_PREFIX}policy`

/**
 * Guidance injected into every root session that has no roster yet: how the
 * model decides on its own whether this request needs a team. Kept as one
 * constant so the text is stable across turns and stays in the prompt cache.
 */
const AUTO_POLICY = [
  '## 团队模式（Team Mode，按需自动组队）',
  '遇到需要多个专长分工的任务（写软件、做视频、做调研、做内容、跨多个文件的工程改造……），不要先问用户要成员名单：'
    + '直接用 team_form 按内置模板组建团队（默认建完就上岗，一次调用完成组队 + 开工），用 team_task_create 派活；'
    + '成员完成时会把结论带回你这里，最后用 team_status 汇总，再一次性回复用户。',
  '简单任务（一次问答、查一条信息、改一行代码）不要组队，自己做完。',
  '你是 team lead：拆解目标、派活、验收、汇总，不亲自承担某个专家的实现工作；每个成员只做一件事，不要把所有事压给一个 Agent。',
].join('\n')

/**
 * Find session logs that still carry 0.1.x `team/*` events.
 *
 * A log like that fails to open with a bare `unknown event type` error that says
 * nothing about the cure, so the plugin looks for them and names the repair step
 * instead. Only the three types the old build wrote are considered: first-party
 * `team/task`, `team/mode`, `team/member` and `team/message/*` events are valid.
 *
 * @param options - scan caps.
 * @returns findings, newest first (empty when every recent log is clean).
 */
function findLegacySessionLogs(options = {}) {
  return findLegacyLogs({ limit: 6, maxBytes: 8 * 1024 * 1024, ...options })
}

/**
 * Cached scan + the sentence shown to the model, or '' when nothing is broken.
 *
 * Cached per sessions root so a test (or a second profile) does not read a
 * stale verdict.
 *
 * @param options - forwarded caps; `refresh` bypasses the cache.
 * @returns a repair hint, or an empty string.
 */
const legacyScanCache = new Map()
function legacySessionHint(options = {}) {
  const root = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  const cached = legacyScanCache.get(root)
  const now = Date.now()
  if (options.refresh !== true && cached !== undefined && now - cached.at < 60_000) return cached.hint
  let hint = ''
  let findings = []
  try {
    findings = findLegacySessionLogs(options)
  } catch {
    findings = []
  }
  if (findings.length > 0) {
    // One broken log has an exact command; several are better fixed in one sweep,
    // which is what `--all` exists for.
    const command = findings.length > 1
      ? 'node tools/session-repair.mjs --all --write'
      : `node tools/session-repair.mjs --session "${findings[0].file}" --write`
    hint = `⚠ 有 ${findings.length} 个会话日志含旧版 team/* 事件，重开会话时会报 unknown event type 而打不开：`
      + findings.map(item => `${item.session}（${item.types.join('、')} ×${item.count}）`).join('；')
      + `。关闭 DSH 后运行：${command}`
  }
  legacyScanCache.set(root, { at: now, hint, legacyTypes: LEGACY_EVENT_TYPES })
  return hint
}

/**
 * Classify a roster/staff/report record.
 *
 * Builds before 0.2 wrote `team/roster` style events, which DSH's format
 * validator rejects on restore; the current spelling is `plugin:team-mode/*`.
 * Both are folded so a session that used the old build still shows its roster
 * (run `tools/session-repair.mjs` to make that session reopenable).
 * @param type - the event type.
 * @returns `'roster' | 'staff' | 'report' | 'policy' | ''`.
 */
function recordKind(type) {
  if (typeof type !== 'string') return ''
  let tail = ''
  if (type.startsWith(RECORD_PREFIX)) tail = type.slice(RECORD_PREFIX.length)
  else if (type.startsWith('team/')) tail = type.slice('team/'.length)
  else return ''
  return tail === 'roster' || tail === 'staff' || tail === 'report' || tail === 'policy' ? tail : ''
}

/**
 * Resolve DSH's `appendPluginRecord` from the installation that owns this host.
 *
 * A linked profile plugin cannot `import '@deepseek-ai/dsh-session'`: it lives
 * outside the app bundle, so Node's resolver never reaches the asar. Resolving
 * the same package entry with `createRequire` returns the module instance the
 * host already loaded; its `appendPluginRecord` is the only supported way to
 * write an `ignorable` record, because the commit goes through a private
 * Session method bound to that exact class.
 * @returns the writer and the Session class it belongs to, or undefined when unreachable.
 */
function resolvePluginRecordWriter() {
  const candidates = []
  const addCandidate = base => {
    if (typeof base !== 'string' || base === '') return
    candidates.push(path.join(base, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json'))
  }
  // Explicit override first: covers installations we cannot infer.
  const override = process.env.TEAM_MODE_DSH_SESSION
  if (typeof override === 'string' && override !== '') {
    candidates.push(path.join(override, 'package.json'))
  }
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir !== '') {
    // <asar>/dsh/node_modules/@deepseek-ai/dsh -> sibling dsh-session.
    candidates.push(path.join(installDir, '..', 'dsh-session', 'package.json'))
    addCandidate(path.join(installDir, '..', '..', '..'))
  }
  // The app root can be inferred from an `app.asar` argument or from the binary.
  for (const arg of process.argv) {
    const match = /^(.*[\\/]app\.asar)[\\/]dsh[\\/]/u.exec(arg)
    if (match !== null) addCandidate(match[1])
  }
  for (const exe of [process.execPath, process.env.DSH_NODE_EXECUTABLE]) {
    if (typeof exe !== 'string' || exe === '') continue
    addCandidate(path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh'))
  }
  // npm CLI / unpacked installs: the package sits under some ancestor's
  // node_modules, so walk up from the entry script, the cwd and the executable.
  const walkUp = start => {
    let dir = start
    for (let hop = 0; hop < 5 && typeof dir === 'string' && dir !== ''; hop += 1) {
      addCandidate(dir)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') walkUp(path.dirname(process.argv[1]))
  walkUp(process.cwd())
  walkUp(path.dirname(process.execPath))
  // Last resort: the desktop install location this build ships from.
  addCandidate('D:/dsh/resources/app.asar/dsh')
  for (const candidate of candidates) {
    try {
      const require = createRequire(candidate)
      const mod = require('@deepseek-ai/dsh-session')
      if (typeof mod?.appendPluginRecord === 'function' && typeof mod?.Session === 'function') {
        return { append: mod.appendPluginRecord, Session: mod.Session, candidate }
      }
    } catch {
      // Try the next candidate: an unreachable installation is not fatal here.
    }
  }
  return { candidates }
}

const DEFAULT_MAX_MEMBERS = 8

/** Reports carry at most this many evidence lines; keeps the log and panel readable. */
const MAX_EVIDENCE = 8

/** One role may not be smaller than this; a one-person "team" is the thing this plugin avoids. */
const MIN_ROLES = 2

/** Role ids are agent-name safe: they become subagent names. */
const ROLE_ID = /^[a-z][a-z0-9-]{0,30}$/

/** The built-in rosters. Every role names the role it reports to, or `lead`. */
const TEMPLATES = Object.freeze({
  software: {
    title: '软件研发',
    roles: [
      {
        id: 'pm',
        title: '产品经理',
        duty: '澄清需求与边界，定义验收标准，排优先级，对"做什么、做到什么程度"负责。',
        deliverables: ['需求说明（目标 / 范围 / 不做的事）', '验收清单'],
        reportsTo: 'lead',
        writeScopes: ['docs/'],
      },
      {
        id: 'research',
        title: '市场与用户调研',
        duty: '收集竞品与用户证据，判断需求是否值得做，指出被忽略的替代方案。',
        deliverables: ['调研摘要（结论 + 证据链接）'],
        reportsTo: 'lead',
        writeScopes: ['research/'],
      },
      {
        id: 'architect',
        title: '架构与方案',
        duty: '技术选型、模块划分、接口契约与数据流；把需求拆成可并行实现的边界。',
        deliverables: ['方案文档（模块 / 接口 / 目录约定）'],
        reportsTo: 'pm',
        writeScopes: ['docs/architecture/'],
      },
      {
        id: 'frontend',
        title: '前端实现',
        duty: '界面与交互实现，按架构契约对接接口，保证可用与可访问。',
        deliverables: ['可运行的前端代码'],
        reportsTo: 'architect',
        writeScopes: ['src/web/'],
      },
      {
        id: 'backend',
        title: '后端与数据',
        duty: '接口、数据模型、持久化与业务逻辑实现，按契约提供稳定服务。',
        deliverables: ['可运行的后端代码'],
        reportsTo: 'architect',
        writeScopes: ['src/server/'],
      },
      {
        id: 'qa',
        title: '质量与缺陷',
        duty: '按验收清单设计用例，实际运行并复现缺陷，给出可验证的失败证据。',
        deliverables: ['用例与缺陷报告（复现步骤）'],
        reportsTo: 'pm',
        writeScopes: ['tests/'],
      },
      {
        id: 'devops',
        title: '构建与部署',
        duty: '构建脚本、环境配置、部署与回滚，保证别人能一条命令跑起来。',
        deliverables: ['部署说明与构建配置'],
        reportsTo: 'architect',
        writeScopes: ['scripts/', 'deploy/'],
      },
    ],
  },
  video: {
    title: '视频制作',
    roles: [
      {
        id: 'producer',
        title: '策划与制片',
        duty: '定选题、定受众、定调性与时长，排出各环节顺序与截止点。',
        deliverables: ['策划案（选题 / 受众 / 结构 / 时长）'],
        reportsTo: 'lead',
        writeScopes: ['video/plan/'],
      },
      {
        id: 'writer',
        title: '脚本与文案',
        duty: '写分场脚本、口播稿与标题文案，控制节奏与信息密度。',
        deliverables: ['脚本文件'],
        reportsTo: 'producer',
        writeScopes: ['video/script/'],
      },
      {
        id: 'storyboard',
        title: '分镜与视觉',
        duty: '把脚本拆成分镜，定义画面构图、色调与镜头运动，产出可执行的画面描述。',
        deliverables: ['分镜表'],
        reportsTo: 'producer',
        writeScopes: ['video/storyboard/'],
      },
      {
        id: 'assets',
        title: '素材与配乐',
        duty: '按分镜准备画面素材、音效与配乐，标注来源与授权。',
        deliverables: ['素材清单（路径 / 来源 / 授权）'],
        reportsTo: 'storyboard',
        writeScopes: ['video/assets/'],
      },
      {
        id: 'editor',
        title: '剪辑与合成',
        duty: '按分镜完成时间线、转场、字幕与混音，输出成片或可复现的剪辑指令。',
        deliverables: ['成片或剪辑工程'],
        reportsTo: 'producer',
        writeScopes: ['video/edit/'],
      },
      {
        id: 'voice',
        title: '配音与字幕',
        duty: '配音（或生成配音指令）与字幕校对，保证与画面对齐。',
        deliverables: ['配音文件与字幕文件'],
        reportsTo: 'editor',
        writeScopes: ['video/voice/'],
      },
      {
        id: 'reviewer',
        title: '审核与发布',
        duty: '成片审看：事实、版权、节奏、平台规范；给出通过或返修清单。',
        deliverables: ['审核结论 + 发布文案'],
        reportsTo: 'producer',
        writeScopes: ['video/review/'],
      },
    ],
  },
  research: {
    title: '调研分析',
    roles: [
      {
        id: 'questioner',
        title: '研究问题',
        duty: '把模糊问题变成可回答的子问题，定证据标准与判断口径。',
        deliverables: ['研究框架与问题清单'],
        reportsTo: 'lead',
        writeScopes: ['research/frame/'],
      },
      {
        id: 'collector',
        title: '资料采集',
        duty: '按问题清单取一手/二手资料，逐条记录来源与日期。',
        deliverables: ['资料清单（链接 + 摘录）'],
        reportsTo: 'questioner',
        writeScopes: ['research/sources/'],
      },
      {
        id: 'analyst',
        title: '分析与建模',
        duty: '交叉验证证据、做定量或定性分析，给出带置信度的结论。',
        deliverables: ['分析结论与数据'],
        reportsTo: 'questioner',
        writeScopes: ['research/analysis/'],
      },
      {
        id: 'writer',
        title: '报告撰写',
        duty: '把结论写成可决策的报告：先结论、后证据、标注不确定性。',
        deliverables: ['报告正文'],
        reportsTo: 'questioner',
        writeScopes: ['research/report/'],
      },
      {
        id: 'checker',
        title: '事实核查',
        duty: '逐条核对数字与引文，删掉无法溯源的断言。',
        deliverables: ['核查记录'],
        reportsTo: 'writer',
        writeScopes: ['research/review/'],
      },
    ],
  },
  content: {
    title: '内容运营',
    roles: [
      {
        id: 'strategist',
        title: '选题与策略',
        duty: '定人群、定选题池、定内容形式与发布节奏。',
        deliverables: ['内容策略与选题表'],
        reportsTo: 'lead',
        writeScopes: ['content/plan/'],
      },
      {
        id: 'copywriter',
        title: '文案撰写',
        duty: '按策略写正文、标题与互动话术，保持同一口径。',
        deliverables: ['成稿'],
        reportsTo: 'strategist',
        writeScopes: ['content/copy/'],
      },
      {
        id: 'designer',
        title: '视觉与排版',
        duty: '配图、封面与排版，保证与文案气质一致。',
        deliverables: ['视觉稿件'],
        reportsTo: 'strategist',
        writeScopes: ['content/visual/'],
      },
      {
        id: 'operator',
        title: '渠道运营',
        duty: '发布、置顶、评论维护与分发节奏执行。',
        deliverables: ['发布记录'],
        reportsTo: 'strategist',
        writeScopes: ['content/publish/'],
      },
      {
        id: 'reviewer',
        title: '数据复盘',
        duty: '发布后看数据，给出可复用的经验与下一轮调整。',
        deliverables: ['复盘报告'],
        reportsTo: 'strategist',
        writeScopes: ['content/review/'],
      },
    ],
  },
  generic: {
    title: '通用项目',
    roles: [
      {
        id: 'planner',
        title: '规划与拆解',
        duty: '把目标拆成可独立推进的几块，定义每块的完成标准。',
        deliverables: ['拆解清单与完成标准'],
        reportsTo: 'lead',
        writeScopes: ['plan/'],
      },
      {
        id: 'builder',
        title: '主实现',
        duty: '承担工作量最大的那部分实现，产出可直接使用的成果。',
        deliverables: ['主力成果'],
        reportsTo: 'planner',
        writeScopes: ['build/'],
      },
      {
        id: 'helper',
        title: '并行支援',
        duty: '接走可与主实现并行的那部分，避免主线阻塞。',
        deliverables: ['支援成果'],
        reportsTo: 'planner',
        writeScopes: ['support/'],
      },
      {
        id: 'reviewer',
        title: '验收与复盘',
        duty: '按完成标准实测，指出返修项并记录经验。',
        deliverables: ['验收结论'],
        reportsTo: 'planner',
        writeScopes: ['review/'],
      },
    ],
  },
})

const TEMPLATE_KEYS = Object.keys(TEMPLATES)

/** The wire (and state) shape of the `teamMode` projection. */
function emptyState() {
  return { goal: '', template: '', roles: [], staffed: {}, reports: [], policy: {}, updatedAt: 0 }
}

/**
 * Coerce one configured number into a positive integer bound.
 * @param value - configured value.
 * @param fallback - value used when the configuration is missing or invalid.
 * @returns a positive integer.
 */
function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Trim a string field, tolerating non-strings from the model.
 * @param value - raw value.
 * @returns the trimmed string, or ''.
 */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read a string list, dropping blanks and duplicates.
 * @param value - raw value.
 * @param limit - maximum entries kept.
 * @returns the cleaned list.
 */
function strList(value, limit) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const text = str(entry)
    if (text !== '' && !out.includes(text)) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Normalize one role, defaulting the reporting line to `lead`.
 * @param raw - model or template supplied role.
 * @returns the canonical role.
 * @throws when the role cannot be identified or carries no duty.
 */
function normalizeRole(raw) {
  const id = str(raw?.id).toLowerCase()
  if (!ROLE_ID.test(id)) {
    throw new Error(`角色 id ${JSON.stringify(str(raw?.id))} 不合法：只能用小写字母开头的 a-z、0-9、-，最长 31 位（它会成为子代理名字）`)
  }
  const title = str(raw?.title) || id
  const duty = str(raw?.duty)
  if (duty === '') throw new Error(`角色 ${id} 缺少 duty（职责）`)
  return {
    id,
    title,
    duty,
    deliverables: strList(raw?.deliverables, 6),
    reportsTo: str(raw?.reportsTo) || 'lead',
    writeScopes: strList(raw?.writeScopes, 6),
  }
}

/**
 * Merge extra roles over a template roster by id, keeping template order.
 * @param base - template roles (may be empty).
 * @param extra - roles supplied by the caller.
 * @returns the merged roster.
 */
function mergeRoles(base, extra) {
  const merged = base.map(role => ({ ...role, deliverables: [...role.deliverables], writeScopes: [...role.writeScopes] }))
  for (const raw of extra) {
    const role = normalizeRole(raw)
    const index = merged.findIndex(entry => entry.id === role.id)
    if (index >= 0) merged[index] = role
    else merged.push(role)
  }
  return merged
}

/**
 * Reject rosters that cannot work as a team (duplicate ids, dangling reporting lines).
 * @param roles - the roster to check.
 */
function validateRoster(roles) {
  const ids = new Set()
  for (const role of roles) {
    // A role id is also a key in the staffed map and a subagent name; names like
    // `constructor` would hit Object.prototype and never resolve to a member.
    if (Object.prototype.hasOwnProperty.call(Object.prototype, role.id)) {
      throw new Error(`角色 id「${role.id}」与 JavaScript 内置属性重名，换一个（例如 ${role.id}-role）`)
    }
    if (ids.has(role.id)) throw new Error(`角色 id 重复：${role.id}`)
    ids.add(role.id)
  }
  for (const role of roles) {
    if (role.reportsTo !== 'lead' && !ids.has(role.reportsTo)) {
      throw new Error(`角色 ${role.id} 的 reportsTo 指向不存在的角色 ${role.reportsTo}（上级角色必须也在编制里，或写 lead）`)
    }
    if (role.reportsTo === role.id) throw new Error(`角色 ${role.id} 不能向自己汇报`)
  }
  // A reporting cycle makes the org chart unwalkable (the panel recurses), so
  // reject it here instead of letting the client crash on render.
  const byId = new Map(roles.map(role => [role.id, role]))
  for (const role of roles) {
    const seen = new Set([role.id])
    let current = role
    while (current.reportsTo !== 'lead') {
      if (seen.has(current.reportsTo)) {
        throw new Error(`汇报线成环：${[...seen].join(' → ')} → ${current.reportsTo}；请让每条线最终回到 lead`)
      }
      seen.add(current.reportsTo)
      current = byId.get(current.reportsTo)
      if (current === undefined) break
    }
  }
}

/**
 * Compose the charter one member receives as its first instruction.
 * @param input - team goal, template title, the member's role and the rest of the roster.
 * @returns the charter text.
 */
function charterFor(input) {
  const { goal, teamTitle, role, roles, leadName } = input
  const superior = role.reportsTo === 'lead' ? leadName : (roles.find(entry => entry.id === role.reportsTo)?.title ?? leadName)
  const lines = [
    `你是这支 AI 团队的「${role.title}」（id: ${role.id}），团队类型：${teamTitle || 'custom'}。团队目标：${goal}`,
    '',
    `你的职责：${role.duty}`,
  ]
  if (role.deliverables.length > 0) lines.push(`你的交付物：${role.deliverables.join('；')}。`)
  lines.push(`汇报线：你向「${superior}」汇报。`)
  if (role.writeScopes.length > 0) {
    lines.push(`写入范围：只在 ${role.writeScopes.join('、')} 下创建或修改文件；需要改动别人的范围时先在汇报里提出。`)
  } else {
    lines.push('写入范围：你没有专属目录，默认只读；产物放在临时位置并在汇报里给出路径。')
  }
  lines.push('')
  lines.push('团队规则：')
  lines.push('1. 只承担上面这一份职责，不要替其他角色做决定，也不要重复别人的工作；信息不足时把缺口写进 blocker，而不是自己补假设。')
  lines.push(`2. 团队模式下用 team_task_create 建任务、team_task_update 更新状态（先 list 认领，写清楚写入范围，避免和别人抢同一批文件）。`)
  lines.push('3. 不要自己再 spawn 子代理；需要别人配合时用 send_message 找 lead 说明要什么。')
  lines.push(`4. 每完成一段或遇到阻塞，调用 team_report 记录：{status: in_progress|done|blocked|note, summary, evidence, blockers, next}。`)
  lines.push('5. 结束时给出简洁结论：做了什么、证据在哪（文件路径 / 命令输出）、还有什么没做。不要把整段过程复述一遍。')
  return lines.join('\n')
}

/**
 * Turn a role id into an agent name, adding a suffix when the plain name is taken.
 * @param roleId - the role whose name is wanted.
 * @param attempt - 0 for the plain name, 1+ for a numeric suffix.
 * @returns a name matching the agent-name grammar.
 */
function memberName(roleId, attempt) {
  const base = roleId === 'lead' ? 'member' : roleId
  const suffixed = attempt === 0 ? base : `${base}-${attempt + 1}`
  return suffixed.slice(0, 32)
}

/**
 * Render the roster as the model-facing summary, with staffing state.
 * @param state - current projection state.
 * @returns the text block list.
 */
function rosterText(state) {
  const texts = [`团队目标：${state.goal || '（未设置）'}`, `模板：${state.template}｜角色数：${state.roles.length}`]
  for (const role of state.roles) {
    const staff = state.staffed[role.id]
    const superior = role.reportsTo === 'lead' ? 'lead' : role.reportsTo
    texts.push(
      `- ${role.title} (${role.id}) → 上级 ${superior}${staff ? `｜已上岗：${staff.name}` : '｜未上岗'}`
      + `\n    ${role.duty}`
      + (role.deliverables.length > 0 ? `\n    交付：${role.deliverables.join('；')}` : '')
      + (role.writeScopes.length > 0 ? `\n    写入：${role.writeScopes.join('、')}` : ''),
    )
  }
  return [{ type: 'text', text: texts.join('\n') }]
}

/**
 * Register the team projection and the four team tools.
 * @param ctx - registrant context.
 * @param config - deployment configuration (`maxMembers`).
 * @returns when the plugin is ready.
 */
export async function apply(ctx, config) {
  const maxMembers = positiveInteger(config?.maxMembers, DEFAULT_MAX_MEMBERS)
  const autoStaff = config?.autoStaff !== false
  const auto = config?.auto !== false
  const writer = resolvePluginRecordWriter()
  // One staffing pass per session at a time: two parallel calls would spawn the
  // same role twice and write conflicting records.
  const staffingLocks = new Set()

  const handle = await ctx.sessionProjections.register({
    key: 'teamMode',
    stateSchema: { parse: value => value },
    init: () => emptyState(),
    apply: (state, event) => {
      const kind = recordKind(event.type)
      if (kind === 'roster') {
        const data = event.data ?? {}
        const replaced = data.replace === true
        const next = replaced ? [] : state.roles.slice()
        for (const raw of Array.isArray(data.roles) ? data.roles : []) {
          // A hand-edited or third-party log can carry junk here; one bad entry
          // must not poison the whole projection (wire.view would throw).
          if (raw === null || typeof raw !== 'object' || str(raw.id) === '') continue
          const role = {
            id: str(raw.id),
            title: str(raw.title) || str(raw.id),
            duty: str(raw.duty),
            deliverables: strList(raw.deliverables, 12),
            reportsTo: str(raw.reportsTo) || 'lead',
            writeScopes: strList(raw.writeScopes, 12),
          }
          const index = next.findIndex(entry => entry.id === role.id)
          if (index >= 0) next[index] = role
          else next.push(role)
        }
        // Replacing the roster retires the old members: keeping their staffed
        // entries would silently reuse a role that may no longer exist.
        const kept = new Set(next.map(role => role.id))
        const staffed = Object.create(null)
        for (const [roleId, member] of Object.entries(state.staffed)) {
          if (kept.has(roleId)) staffed[roleId] = member
        }
        return {
          ...state,
          goal: str(data.goal) || state.goal,
          template: str(data.template) || state.template,
          roles: next,
          staffed: replaced ? Object.create(null) : staffed,
          updatedAt: Date.now(),
        }
      }
      if (kind === 'staff') {
        const staffed = Object.assign(Object.create(null), state.staffed)
        for (const entry of Array.isArray(event.data?.entries) ? event.data.entries : []) {
          const roleId = str(entry?.roleId)
          if (roleId === '') continue
          // `retired` drops a member that no longer exists in this session's tree
          // (forked sessions inherit staffed entries they never spawned).
          if (entry?.retired === true) {
            delete staffed[roleId]
            continue
          }
          if (str(entry?.name) === '') continue
          staffed[roleId] = { name: entry.name, title: str(entry.title), childId: str(entry.childId), at: entry.at ?? 0 }
        }
        return { ...state, staffed, updatedAt: Date.now() }
      }
      if (kind === 'policy') {
        const data = event.data ?? {}
        const policy = { ...state.policy }
        if (typeof data.auto === 'boolean') policy.auto = data.auto
        return { ...state, policy, updatedAt: Date.now() }
      }
      if (kind === 'report') {
        const data = event.data ?? {}
        const report = {
          role: str(data.role),
          status: str(data.status) || 'note',
          summary: str(data.summary),
          evidence: strList(data.evidence, MAX_EVIDENCE),
          blockers: str(data.blockers),
          next: str(data.next),
          at: typeof data.at === 'number' ? data.at : 0,
        }
        return { ...state, reports: [...state.reports, report].slice(-40), updatedAt: Date.now() }
      }
      return state
    },
    wire: {
      viewSchema: { parse: value => value },
      view: state => ({
        goal: state.goal,
        template: state.template,
        // null means "follow the plugin default"; true/false is this session's
        // explicit override set through the `/team on|off` command.
        auto: typeof state.policy.auto === 'boolean' ? state.policy.auto : null,
        updatedAt: state.updatedAt,
        roles: state.roles.map(role => ({
          ...role,
          name: state.staffed[role.id]?.name ?? '',
        })),
        reports: state.reports.slice(-20),
      }),
      summary: false,
    },
    stateVersion: 2,
  })

  /**
   * Fold a freshly appended event into the projection before the next tool reads it.
   * @param session - the session whose log just grew.
   * @returns when the session is flushed.
   */
  async function flush(session) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.flush !== 'function') return
    await sessions.flush(session)
  }

  /**
   * Read the current team state of one session.
   * @param agent - the calling agent.
   * @returns the projection state.
   */
  function stateOf(agent) {
    return handle.stateOf(agent.session) ?? emptyState()
  }

  /**
   * Append one ignorable team record to a session log.
   * @param session - the session whose log receives the record.
   * @param type - one of the `RECORD_*` types.
   * @param data - JSON payload folded by the `teamMode` projection.
   * @returns when the record is committed.
   */
  function writeRecord(session, type, data) {
    if (writer.append === undefined) {
      throw new Error(
        '团队模式写不进会话日志：找不到 DSH 的 dsh-session 模块（appendPluginRecord 不可用）。'
        + `已尝试：${writer.candidates.join('、')}。`
        + '若 DSH 装在别处，请把 @deepseek-ai/dsh-session 的目录设为环境变量 TEAM_MODE_DSH_SESSION 后重启。',
      )
    }
    if (writer.Session !== session.constructor) {
      throw new Error(
        '团队模式写不进会话日志：解析到的 dsh-session 与当前会话的 Session 类不一致'
        + `（来自 ${writer.candidate}）；通常是同时安装了多个 DSH 版本，请用 TEAM_MODE_DSH_SESSION 指向正在运行的那一份。`,
      )
    }
    writer.append(session, type, data)
  }

  /**
   * Mirror a member report into the lead's log.
   *
   * The panel and `team_status` read the lead session's projection, but a member
   * reports into its own session. Writing a copy under the lead means the panel
   * shows live progress without polling every descendant; the member's own log
   * keeps the authoritative record.
   * @param agent - the reporting agent.
   * @param report - the normalized report payload.
   * @returns nothing; failures are swallowed because a mirror is a convenience.
   */
  function mirrorReportToLead(agent, report) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || typeof subagents.rootOf !== 'function') return
    let root
    try {
      root = subagents.rootOf(agent)
    } catch {
      return
    }
    if (root === undefined || root === null || root.session === agent.session) return
    try {
      writeRecord(root.session, REPORT_EVENT, { ...report, mirrored: true })
    } catch {
      // The lead's log may be read-only or belong to another DSH instance; the
      // report itself is already durable in the member session.
    }
  }

  /**
   * Collect the reports members wrote in their own sessions.
   *
   * A member's `team_report` lands in the member's log, never in the lead's, so
   * the lead projection alone cannot see it. Descendant discovery supplies the
   * child session ids; each child's own `teamMode` projection carries the
   * reports that member filed.
   * @param agent - the lead agent.
   * @param signal - cancellation signal, forwarded to the catalog reads.
   * @returns the member reports, oldest first, at most 20.
   */
  async function collectMemberReports(agent, signal) {
    const sessions = ctx.get('sessions')
    const subagents = ctx.get('subagents')
    if (sessions === undefined || typeof sessions.get !== 'function') return []
    if (subagents === undefined || typeof subagents.listDescendants !== 'function') return []
    let descendants = []
    try {
      descendants = await subagents.listDescendants(agent.session.id, signal)
    } catch {
      return []
    }
    const collected = []
    for (const entry of descendants) {
      const id = entry?.id
      if (id === undefined || id === null) continue
      let session
      try {
        session = sessions.get(id)
      } catch {
        continue
      }
      if (session === undefined || session === null) continue
      let childState
      try {
        childState = handle.stateOf(session)
      } catch {
        continue
      }
      const reporter = str(entry.path) || str(entry.name) || str(entry.label)
      for (const report of Array.isArray(childState?.reports) ? childState.reports : []) {
        collected.push({
          role: reporter || str(report.role) || 'member',
          status: str(report.status) || 'note',
          summary: str(report.summary),
          evidence: strList(report.evidence, MAX_EVIDENCE),
          blockers: str(report.blockers),
          next: str(report.next),
          at: typeof report.at === 'number' ? report.at : 0,
        })
      }
    }
    collected.sort((left, right) => left.at - right.at)
    return collected.slice(-20)
  }

  /**
   * Give roster roles a subagent of their own and record the durable staffing event.
   * Shared by team_form (form-and-start in one call) and team_staff (staff later).
   * @param agent - the team lead agent.
   * @param state - the current team state.
   * @param options - roles to staff (empty means every role), respawn flag, provider name.
   * @param exec - tool execution context carrying the cancellation signal.
   * @returns the staffing summary both tools report back.
   */
  async function staffRoles(agent, state, options, exec) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || typeof subagents.startActivation !== 'function') {
      throw new Error('子代理服务不可用，无法上岗')
    }
    const lockKey = String(agent.session?.id ?? 'session')
    if (staffingLocks.has(lockKey)) {
      throw new Error('上一次上岗还没跑完：等它结束再调用 team_staff（并发上岗会给同一个角色启两个成员）')
    }
    staffingLocks.add(lockKey)
    try {
      return await runStaffing(agent, state, options, exec, subagents)
    } finally {
      staffingLocks.delete(lockKey)
    }
  }

  /**
   * Staff the requested roles, writing one durable record per launched member.
   * @param agent - the team lead agent.
   * @param state - the team state read before staffing.
   * @param options - roles to staff, respawn flag, provider name.
   * @param exec - tool execution context carrying the cancellation signal.
   * @param subagents - the subagent service.
   * @returns the staffing summary both tools report back.
   */
  async function runStaffing(agent, state, options, exec, subagents) {
    const provider = str(options?.provider) || 'spawn'
    const wanted = Array.isArray(options?.roles) && options.roles.length > 0
      ? options.roles.map(id => str(id)).filter(id => id !== '')
      : state.roles.map(role => role.id)
    const respawn = options?.respawn === true
    const started = []
    const failed = []
    const warnings = []
    for (const roleId of wanted) {
      const role = state.roles.find(entry => entry.id === roleId)
      if (role === undefined) {
        failed.push({ roleId, error: '编制里没有这个角色（先用 team_form 加入）' })
        continue
      }
      const existing = state.staffed[roleId]
      if (existing !== undefined && !respawn) {
        started.push({ roleId, title: role.title, name: existing.name, childId: existing.childId ?? '', reused: true })
        continue
      }
      const text = charterFor({ goal: state.goal, teamTitle: state.template, role, roles: state.roles, leadName: 'lead' })
      let instance
      let lastError = ''
      for (let attempt = 0; attempt < 3 && instance === undefined; attempt += 1) {
        try {
          instance = await subagents.startActivation({
            provider,
            label: role.title,
            name: memberName(role.id, attempt),
            prompt: [{ type: 'text', text }],
            parent: agent,
            signal: exec?.signal,
            delivery: 'parent',
          })
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          // A full child quota will not clear by retrying the same role; the
          // remaining roles should fail fast with the real message instead.
          if (error?.code === 'ACTIVATION_LIMIT_REACHED') break
        }
      }
      if (instance === undefined) {
        failed.push({ roleId, error: lastError })
        continue
      }
      const name = instance.name ?? memberName(role.id, 0)
      const childId = String(instance.childId ?? '')
      // Record each member as soon as it exists: a later failure must not hide
      // the ones already running, and a retry must not spawn them again.
      try {
        writeRecord(agent.session, STAFF_EVENT, { entries: [{ roleId, title: role.title, name, childId, at: Date.now() }] })
        await flush(agent.session)
      } catch (error) {
        warnings.push(`成员 ${name} 已启动，但上岗记录没写进会话日志：${error instanceof Error ? error.message : String(error)}`)
      }
      started.push({ roleId, title: role.title, name, childId, reused: false })
    }
    const next = stateOf(agent)
    return {
      provider,
      started,
      failed,
      warning: warnings.join('；'),
      staffedCount: next.roles.filter(role => next.staffed[role.id] !== undefined).length,
      totalCount: next.roles.length,
    }
  }

  /**
   * Stop the members that a roster replacement is about to drop.
   *
   * The projection cannot do this (folds stay pure), so `team_form` calls it when
   * `replace:true` would otherwise leave the old members running next to the new
   * ones — two agents writing the same scopes.
   * @param agent - the team lead agent.
   * @param staffed - the staffed entries of the old roster.
   * @returns the interrupted child ids and the failures.
   */
  function retireMembers(agent, staffed) {
    const subagents = ctx.get('subagents')
    const stopped = []
    const failed = []
    if (subagents === undefined || typeof subagents.interrupt !== 'function') {
      return { stopped, failed }
    }
    for (const [roleId, member] of Object.entries(staffed ?? {})) {
      const childId = str(member?.childId)
      if (childId === '') continue
      try {
        subagents.interrupt(childId, { kind: 'user' })
        stopped.push(roleId)
      } catch (error) {
        failed.push(`${roleId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { stopped, failed }
  }

  /**
   * Drop staffed entries whose member session is not in this session's tree.
   *
   * A forked session inherits the parent's staffing records but not the members
   * themselves, so the panel would show members that cannot report. The first
   * tool call in that session reconciles the records with reality.
   * @param agent - the team lead agent.
   * @param state - the current team state.
   * @param signal - cancellation signal for the catalog read.
   * @returns the reconciled state (unchanged when nothing is stale).
   */
  async function reconcileMembers(agent, state, signal) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || typeof subagents.listDescendants !== 'function') return state
    const stale = Object.entries(state.staffed)
      .filter(([, member]) => str(member?.childId) !== '')
    if (stale.length === 0) return state
    let descendants
    try {
      descendants = await subagents.listDescendants(agent.session.id, signal)
    } catch {
      return state
    }
    const live = new Set(descendants.map(entry => String(entry?.id ?? '')))
    const retired = stale.filter(([, member]) => !live.has(str(member.childId))).map(([roleId]) => roleId)
    if (retired.length === 0) return state
    try {
      writeRecord(agent.session, STAFF_EVENT, { entries: retired.map(roleId => ({ roleId, retired: true })) })
      await flush(agent.session)
    } catch {
      return state
    }
    return stateOf(agent)
  }

  ctx.tools.register(defineTool({
    name: 'team_form',
    description:
      '组建或调整一支 AI 团队：写入团队目标与角色编制（每个角色的职责、交付物、汇报线、写入范围）。'
      + '当任务需要多个不同专长的人分工协作时（做产品、做视频、做调研、做运营……）调用本工具定编制；'
      + '默认建完编制就立刻给所有角色上岗（staff:true），一次调用完成「组队 + 开工」。'
      + '之后用 team_task_create 派活、等成员汇报、用 team_status 汇总。'
      + '内置模板：software（软件研发：产品/调研/架构/前端/后端/测试/部署）、video（视频制作：策划/脚本/分镜/素材/剪辑/配音/审核）、'
      + 'research（调研分析）、content（内容运营）、generic（通用项目）。也可以用 roles 自定义角色，或用 roles 覆盖模板里的某个角色。'
      + '团队至少 2 个角色：一个人干完所有事正是要避免的。',
    parameters: {
      goal: { type: 'string', required: true, description: '这次要做成什么，一句话说清目标与验收口径。' },
      template: {
        type: 'string',
        description: `内置团队模板：${TEMPLATE_KEYS.join(' | ')}。省略时按 roles 自定义。`,
        enum: TEMPLATE_KEYS,
      },
      roles: {
        type: 'array',
        description: '自定义角色，或覆盖模板中同 id 的角色。模板里没有的角色会被追加。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '小写字母开头的 a-z、0-9、-，最长 31 位，会成为子代理名字。' },
            title: { type: 'string', description: '角色名，例如「产品经理」「剪辑」。' },
            duty: { type: 'string', required: true, description: '这个角色负责什么、不负责什么。' },
            deliverables: { type: 'array', items: { type: 'string' }, description: '交付物。' },
            reportsTo: { type: 'string', description: '上级角色 id，或 lead（默认 lead）。' },
            writeScopes: { type: 'array', items: { type: 'string' }, description: '允许写的目录前缀，避免多人抢同一批文件。' },
          },
        },
      },
      replace: { type: 'boolean', description: 'true 时清空原有编制重建；默认按 id 合并。' },
      staff: { type: 'boolean', description: 'true 时建完编制立刻让所有角色上岗（一次调用完成「组队 + 开工」）；默认跟随插件配置 autoStaff（默认开启）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', required: true },
          template: { type: 'string', required: true },
          memberCount: { type: 'integer', required: true },
          staffing: {
            type: 'object',
            additionalProperties: false,
            properties: {
              staffedCount: { type: 'integer', required: true },
              totalCount: { type: 'integer', required: true },
              warning: { type: 'string', required: true },
              started: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    roleId: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    reused: { type: 'boolean', required: true },
                  },
                },
              },
              failed: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    roleId: { type: 'string', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          roles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                duty: { type: 'string', required: true },
                reportsTo: { type: 'string', required: true },
                name: { type: 'string', required: true },
                deliverables: { type: 'array', required: true, items: { type: 'string' } },
                writeScopes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // Staffing state comes from the roster itself, so a form call that did
        // not staff still shows which roles were already staffed.
        const staffed = {}
        for (const role of value.roles) {
          if (role.name !== '') staffed[role.id] = { name: role.name }
        }
        const blocks = rosterText({ goal: value.goal, template: value.template, roles: value.roles, staffed })
        if (value.staffing === undefined) {
          return [...blocks, { type: 'text', text: '下一步：用 team_staff 给角色上岗（或直接调用 team_task_create 派活）。' }]
        }
        const lines = []
        for (const entry of value.staffing.started) {
          lines.push(`- ${entry.title} (${entry.roleId}) → 子代理 ${entry.name}${entry.reused ? '（沿用）' : ''}`)
        }
        for (const entry of value.staffing.failed) lines.push(`- ${entry.roleId} 上岗失败：${entry.error}`)
        lines.push(`已上岗 ${value.staffing.staffedCount}/${value.staffing.totalCount}。成员完成时会自动汇报；用 team_status 汇总进度。`)
        return [...blocks, { type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_form 需要在会话内运行')
      const goal = str(args.goal)
      if (goal === '') throw new Error('team_form 需要 goal：一句话说清这次要做成什么')
      const templateKey = str(args.template)
      const template = templateKey === '' ? undefined : TEMPLATES[templateKey]
      if (templateKey !== '' && template === undefined) {
        throw new Error(`未知模板 ${templateKey}；可用：${TEMPLATE_KEYS.join(', ')}`)
      }
      const extra = Array.isArray(args.roles) ? args.roles : []
      const roles = mergeRoles(template?.roles ?? [], extra)
      if (roles.length === 0) throw new Error('请给出 template，或用 roles 至少列出 2 个角色')
      if (roles.length < MIN_ROLES) {
        throw new Error(`团队至少需要 ${MIN_ROLES} 个角色（现在只有 ${roles.length} 个）；不要把所有事压给一个 Agent`)
      }
      if (roles.length > maxMembers) {
        throw new Error(`角色数 ${roles.length} 超过上限 ${maxMembers}（配置项 maxMembers）；合并相近角色再试`)
      }
      validateRoster(roles)
      // Replacing the roster must also stop the members it drops, or the old and
      // new generations run side by side on the same write scopes.
      let retired = { stopped: [], failed: [] }
      if (args.replace === true) {
        retired = retireMembers(agent, stateOf(agent).staffed)
      }
      writeRecord(agent.session, ROSTER_EVENT, {
        goal,
        template: templateKey === '' ? 'custom' : templateKey,
        roles,
        replace: args.replace === true,
      })
      await flush(agent.session)
      const templateLabel = templateKey === '' ? 'custom' : templateKey
      const current = stateOf(agent)
      const output = {
        goal,
        template: templateLabel,
        memberCount: roles.length,
        roles: roles.map(role => ({
          id: role.id,
          title: role.title,
          duty: role.duty,
          reportsTo: role.reportsTo,
          name: current.staffed[role.id]?.name ?? '',
          deliverables: role.deliverables,
          writeScopes: role.writeScopes,
        })),
      }
      const wantStaff = args.staff === undefined ? autoStaff : args.staff === true
      const retiredNote = retired.failed.length > 0 ? `旧成员没停下：${retired.failed.join('、')}` : ''
      if (wantStaff) {
        const staffing = await staffRoles(agent, stateOf(agent), {}, exec)
        output.staffing = {
          staffedCount: staffing.staffedCount,
          totalCount: staffing.totalCount,
          warning: [staffing.warning, retiredNote].filter(Boolean).join('；'),
          started: staffing.started.map(entry => ({
            roleId: entry.roleId,
            title: entry.title,
            name: entry.name,
            reused: entry.reused,
          })),
          failed: staffing.failed,
        }
        // Staffing runs after the roster output was built, so refresh the names
        // from the projection: render must show 已上岗, not 未上岗.
        await flush(agent.session)
        const staffedNow = stateOf(agent)
        for (const role of output.roles) role.name = staffedNow.staffed[role.id]?.name ?? ''
      }
      return output
    },
    presentCall: args => ({ card: 'generic', title: `组建团队：${str(args.goal).slice(0, 40)}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_staff',
    description:
      '给编制里的角色上岗：为每个还没有子代理的角色启动一个子代理，并把生成的角色章程（职责、交付物、汇报线、写入范围、团队规则）'
      + '作为它的第一条指令。必须先调用 team_form 定好编制。可以只给一部分角色上岗（roles），或让已上岗的角色重新上岗（respawn）。'
      + '上岗后成员并行工作，完成时会自动向你汇报；你也可以用 send_message 追问、用 team_status 看整体进度。',
    parameters: {
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: '只给这些角色 id 上岗；省略表示所有未上岗的角色。',
      },
      respawn: { type: 'boolean', description: 'true 时已上岗的角色也重新启动一个（旧的不动）。' },
      provider: { type: 'string', description: '子代理 provider，默认 spawn。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          started: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                roleId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                name: { type: 'string', required: true },
                childId: { type: 'string', required: true },
                reused: { type: 'boolean', required: true },
              },
            },
          },
          failed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                roleId: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          staffedCount: { type: 'integer', required: true },
          totalCount: { type: 'integer', required: true },
          warning: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        for (const entry of value.started) {
          lines.push(`- ${entry.title} (${entry.roleId}) → 子代理 ${entry.name}${entry.reused ? '（沿用）' : ''}`)
        }
        for (const entry of value.failed) lines.push(`- ${entry.roleId} 上岗失败：${entry.error}`)
        if (value.warning) lines.push(`注意：${value.warning}`)
        lines.push(`已上岗 ${value.staffedCount}/${value.totalCount}。成员完成时会自动汇报；用 team_status 汇总，用 team_task_create 派活。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_staff 需要在会话内运行')
      const state = stateOf(agent)
      if (state.roles.length === 0) throw new Error('还没有编制：先调用 team_form 组建团队')
      return staffRoles(agent, state, { roles: args.roles, respawn: args.respawn, provider: args.provider }, exec)
    },
    presentCall: args => ({ card: 'generic', title: '给角色上岗', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_report',
    description:
      '提交一份结构化汇报（团队成员用）：状态、结论、证据、阻塞、下一步。写在你自己会话的日志里，重放/分叉不会丢，'
      + '面板里能看到。完成或卡住时一定要调用，别只把过程写在正文里。',
    parameters: {
      status: {
        type: 'string',
        required: true,
        enum: ['in_progress', 'done', 'blocked', 'note'],
        description: 'in_progress 进行中 | done 完成 | blocked 阻塞 | note 只是备注。',
      },
      summary: { type: 'string', required: true, description: '一两句话说清结果或当前状态。' },
      role: { type: 'string', description: '你的角色 id；省略时按子代理名字推断。' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: '证据：文件路径、命令、链接、测试输出。没有证据就写你实际做了什么。',
      },
      blockers: { type: 'string', description: '卡在哪、需要谁给什么。' },
      next: { type: 'string', description: '下一步要做什么。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role: { type: 'string', required: true },
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          evidence: { type: 'array', required: true, items: { type: 'string' } },
          blockers: { type: 'string', required: true },
          next: { type: 'string', required: true },
          at: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已记录汇报 [${value.status}] ${value.role || 'member'}：${value.summary}`
          + (value.blockers ? `（阻塞：${value.blockers}）` : ''),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_report 需要在会话内运行')
      const summary = str(args.summary)
      if (summary === '') throw new Error('team_report 需要 summary：一句话说清结果')
      let agentName = ''
      const subagents = ctx.get('subagents')
      if (subagents !== undefined && typeof subagents.namesOf === 'function') {
        try {
          agentName = str(subagents.namesOf(agent).self)
        } catch {
          agentName = ''
        }
      }
      const report = {
        role: str(args.role) || agentName,
        status: str(args.status) || 'note',
        summary,
        evidence: strList(args.evidence, MAX_EVIDENCE),
        blockers: str(args.blockers),
        next: str(args.next),
        at: Date.now(),
      }
      writeRecord(agent.session, REPORT_EVENT, report)
      await flush(agent.session)
      // Mirror the report into the lead's log so the panel (which reads the
      // lead's projection) shows member activity while they are still working.
      // A member's own session keeps the authoritative copy.
      mirrorReportToLead(agent, report)
      return report
    },
    presentCall: args => ({ card: 'generic', title: `团队汇报：${str(args.status)}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_status',
    description:
      '查看团队现状：目标、编制、谁已上岗、成员最近的结构化汇报、以及团队任务板上每条任务的状态与负责人。'
      + '汇总进度、决定下一步派谁、或汇报给用户之前调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', required: true },
          template: { type: 'string', required: true },
          roles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                duty: { type: 'string', required: true },
                reportsTo: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          reports: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                status: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                evidence: { type: 'array', required: true, items: { type: 'string' } },
                blockers: { type: 'string', required: true },
                next: { type: 'string', required: true },
                at: { type: 'integer', required: true },
              },
            },
          },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                status: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                ready: { type: 'boolean', required: true },
              },
            },
          },
          memberReports: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                status: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                evidence: { type: 'array', required: true, items: { type: 'string' } },
                blockers: { type: 'string', required: true },
                next: { type: 'string', required: true },
                at: { type: 'integer', required: true },
              },
            },
          },
          legacyWarning: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`团队目标：${value.goal || '（未设置）'}｜模板：${value.template || 'custom'}`]
        for (const role of value.roles) {
          lines.push(`- ${role.title} (${role.id}) → ${role.reportsTo}${role.name ? `｜${role.name}` : '｜未上岗'}`)
        }
        if (value.reports.length > 0) {
          lines.push('', '最近汇报：')
          for (const report of value.reports.slice(-8)) {
            lines.push(`- [${report.status}] ${report.role || 'member'}：${report.summary}`
              + (report.evidence?.length > 0 ? `（证据：${report.evidence[0]}${report.evidence.length > 1 ? ' 等' : ''}）` : '')
              + (report.blockers ? `（阻塞：${report.blockers}）` : '')
              + (report.next ? `（下一步：${report.next}）` : ''))
          }
        }
        if (value.memberReports.length > 0) {
          lines.push('', '成员汇报（来自成员自己的会话）：')
          for (const report of value.memberReports.slice(-8)) {
            lines.push(`- [${report.status}] ${report.role || 'member'}：${report.summary}`
              + (report.evidence.length > 0 ? `（证据：${report.evidence[0]}${report.evidence.length > 1 ? ' 等' : ''}）` : '')
              + (report.blockers ? `（阻塞：${report.blockers}）` : '')
              + (report.next ? `（下一步：${report.next}）` : ''))
          }
        }
        if (value.tasks.length > 0) {
          lines.push('', '任务板：')
          for (const task of value.tasks) {
            lines.push(`- #${task.id} [${task.status}] ${task.subject}${task.owner ? ` @${task.owner}` : ''}${task.ready ? '' : '（有前置未完成）'}`)
          }
        }
        if (typeof value.legacyWarning === 'string' && value.legacyWarning !== '') {
          lines.push('', value.legacyWarning)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_status 需要在会话内运行')
      // A forked session inherits staffing records it never created; reconcile
      // first so the summary matches the members that can actually report.
      let state = stateOf(agent)
      try {
        state = await reconcileMembers(agent, state, exec.signal)
      } catch {
        state = stateOf(agent)
      }
      const memberReports = await collectMemberReports(agent, exec.signal)
      let tasks = []
      const teams = ctx.get('agentTeams')
      if (teams !== undefined && typeof teams.listTasks === 'function') {
        try {
          tasks = teams.listTasks(agent).map(task => ({
            id: String(task.id),
            subject: str(task.subject),
            status: str(task.status),
            owner: str(task.ownerName),
            ready: task.ready === true,
          }))
        } catch {
          tasks = []
        }
      }
      // Mirrored copies already sit in the lead's own projection; showing them
      // again under "member reports" would read as two submissions.
      const flatReports = state.reports.slice(-20).map(report => ({
        role: report.role,
        status: report.status,
        summary: report.summary,
        evidence: report.evidence,
        blockers: report.blockers,
        next: report.next,
        at: report.at,
      }))
      // A mirrored copy is the same submission under a possibly different label
      // (member path vs self-reported role), so identity is timestamp + summary.
      const mirrored = new Set(flatReports.map(report => `${report.at}|${report.summary}`))
      const uniqueMemberReports = memberReports.filter(report => !mirrored.has(`${report.at}|${report.summary}`))
      return {
        goal: state.goal,
        template: state.template,
        roles: state.roles.map(role => ({
          id: role.id,
          title: role.title,
          duty: role.duty,
          reportsTo: role.reportsTo,
          name: state.staffed[role.id]?.name ?? '',
        })),
        reports: flatReports,
        tasks,
        memberReports: uniqueMemberReports,
        legacyWarning: legacySessionHint(),
      }
    },
    presentCall: () => ({ card: 'generic', title: '团队进度', kind: 'other', rawInput: {} }),
  }))

  // The workflow reaches the model through its operational context rather than a
  // system-prompt section: this hook is evaluated per agent, so a session with no
  // roster costs nothing, and the guidance never leaks into unrelated sessions.
  /**
   * Render the `/team` status line for one session.
   * @param agent - the session's agent.
   * @returns plain text describing the current team state.
   */
  async function describeTeam(agent) {
    let state
    try {
      state = await reconcileMembers(agent, stateOf(agent))
    } catch {
      state = stateOf(agent)
    }
    const staffedCount = state.roles.filter(role => state.staffed[role.id] !== undefined).length
    const sessionAuto = typeof state.policy?.auto === 'boolean' ? state.policy.auto : auto
    const lines = [
      `团队模式：${sessionAuto ? '开（需要时自动组队）' : '关（简单任务不组队）'}`,
      state.roles.length === 0
        ? '编制：未组建'
        : `编制：${state.template}｜${staffedCount}/${state.roles.length} 已上岗｜目标：${state.goal || '（未设置）'}`,
      `汇报：${state.reports.length} 条`,
    ]
    lines.push('用 /team on 或 /team off 切换；输入框左侧的「团队」按钮是同一个开关。')
    const repairHint = legacySessionHint()
    if (repairHint !== '') lines.push('', repairHint)
    return lines.join('\n')
  }

  /**
   * Register `/team`. Split out so it can run through `ctx.inject` when the
   * command registry loads after this plugin.
   * @param service - the command registry.
   */
  function registerTeamCommand(service) {
    service.register({
      name: 'team',
      description: '团队模式开关与状态：/team on｜/team off｜/team status',
      input: { hint: 'on | off | status' },
      handler: async invocation => {
        try {
          const agent = invocation.agent
          if (agent === undefined || agent === null) return { kind: 'error', text: '团队开关只能在会话内使用' }
          const choice = str(invocation.rawInput).trim().toLowerCase()
          if (choice === '' || choice === 'status') return { kind: 'success', text: await describeTeam(agent) }
          if (choice !== 'on' && choice !== 'off') {
            return { kind: 'error', text: `不认识的参数「${choice}」；可用：/team on、/team off、/team status` }
          }
          const want = choice === 'on'
          writeRecord(agent.session, POLICY_EVENT, { auto: want, at: Date.now() })
          await flush(agent.session)
          return {
            kind: 'success',
            text: want
              ? '已打开团队模式：遇到需要多专长的任务，我会自动组建团队并派活。'
              : '已关闭团队模式：这个会话的简单任务我会自己做，不再自动组队。',
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }

  const commands = ctx.get('commands')
  if (commands !== undefined && commands !== null && typeof commands.register === 'function') {
    registerTeamCommand(commands)
  } else if (typeof ctx.inject === 'function') {
    // The registry may mount after this plugin; wait for it instead of silently
    // losing `/team`. `ctx.inject` runs the callback once the service exists.
    ctx.inject(['commands'], child => {
      const service = typeof child.get === 'function' ? child.get('commands') : child.commands
      if (service !== undefined && service !== null && typeof service.register === 'function') {
        registerTeamCommand(service)
      }
    })
  }

  let systemPrompt
  try {
    systemPrompt = ctx.get('systemPrompt')
  } catch {
    systemPrompt = undefined
  }
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.context === 'function') {
    // A hot reload can re-run `apply` on the same registry; a duplicate context
    // name would otherwise abort activation, so keep the failure harmless.
    try {
      systemPrompt.context({
      name: 'team-mode:roster',
      order: 125,
      interpolate: false,
      text: ({ agent }) => {
        if (agent === undefined || agent === null) return ''
        let state
        try {
          state = stateOf(agent)
        } catch {
          return ''
        }
        try {
          if (state.roles.length === 0) {
          // The session can override the plugin-wide default with `/team off`.
          const sessionAuto = typeof state.policy?.auto === 'boolean' ? state.policy.auto : auto
          if (!sessionAuto) return ''
          let isRoot = true
          const subagents = ctx.get('subagents')
          if (subagents !== undefined && typeof subagents.namesOf === 'function') {
            try {
              isRoot = subagents.namesOf(agent).parent === undefined
            } catch {
              isRoot = true
            }
          }
          return isRoot ? AUTO_POLICY : ''
        }
        const unstaffed = state.roles.filter(role => state.staffed[role.id] === undefined).map(role => role.id)
        const lines = [
          '## 团队模式已启用（Team Mode）',
          `团队目标：${state.goal || '（未设置）'}｜类型：${state.template}｜角色：${state.roles.length} 个`,
        ]
        for (const role of state.roles) {
          const member = state.staffed[role.id]
          lines.push(`- ${role.title} (${role.id}) → ${role.reportsTo}｜${member === undefined ? '未上岗' : `已上岗 ${member.name}`}`)
        }
        lines.push('')
        if (unstaffed.length > 0) {
          lines.push(`还有 ${unstaffed.length} 个角色没上岗（${unstaffed.join('、')}）：用 team_staff 让它们开工，不要自己把这些活全做完。`)
        }
        lines.push('你是 team lead：负责拆解目标、派活、汇总与验收，不承担某个专家的实现工作。')
        lines.push('派活用 team_task_create（写清验收标准与写入范围，避免多人抢同一批文件）；成员用 team_task_update 更新状态、用 team_report 汇报。')
        lines.push('汇总进度用 team_status；成员完成时会带着结论回到这里，全部收工后再用 team_status 汇总一次，然后一次性回复用户。')
        lines.push('用户在看会话头部的「团队」面板，那里显示编制、任务板和汇报。')
        lines.push('用户在输入框左侧也能一键开关团队模式（对应 /team on 与 /team off）。')
        return lines.join('\n')
        } catch {
          // A throwing prompt hook would fail the whole turn; stay silent instead.
          return ''
        }
      },
      })
    } catch (error) {
      // Duplicate name on reload (or an incompatible prompt service): the plugin
      // still works without its guidance section.
      void error
    }
  }

  // Legacy `team/*` logs fail to open with an opaque format error, and the plugin
  // never runs in such a session. Scan recent logs once, after activation, so a
  // healthy session can warn about a sibling that needs `tools/session-repair.mjs`.
  const scan = setTimeout(() => {
    try {
      const hint = legacySessionHint()
      if (hint === '') return
      const logger = typeof ctx.logger === 'function' ? ctx.logger('team-mode') : undefined
      if (logger !== undefined && typeof logger.warn === 'function') logger.warn(hint)
      else console.warn(`[team-mode] ${hint}`)
    } catch {
      // A failed convenience scan must never affect the plugin.
    }
  }, 1500)
  if (typeof scan.unref === 'function') scan.unref()
}
