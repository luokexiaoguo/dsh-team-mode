# team-mode 发布前代码审查（REVIEW-RELEASE）

审查范围：`packages/team-mode/` 的 `index.js`（1523 行）、`client.js`（927 行）、`schema.js`（143 行）、三个测试与 README/DETAIL。
审查方式：逐段阅读 + 对照 DSH 实际实现（解包 `D:\dsh\resources\app.asar` 核对 `dsh-session`、`dsh-session-projection`、`dsh-subagent`、`dsh-system-prompt`、`dsh-commands`、`dsh-client-ui-*` 的契约）+ 在临时目录写替身复现。
结论：**P0 1 条、P1 7 条、P2 8 条**。现有测试（`projection.test.mjs` 29/29、`render-smoke.mjs`、`panel-cycle.mjs`）全部通过，但没有覆盖下面 P0/P1 的主要触发路径，通过测试不能作为可发布的证据。

> 快照说明：审查期间 `client.js` 从 869 行被改到 927 行（新增"成员正在运行"的 `running`/`useSessions` 逻辑），本报告的行号以 **2026-11-19 22:37 的 client.js、22:16 的 index.js** 为准。若文件继续被改动，请按函数名（`staffRoles`、`team_form`、`GraphView.assign` 等）重新对行号。

---

## P0 会导致故障

### P0-1 `replace:true` 会清空上岗记录，但不会停掉旧成员；默认 `autoStaff` 再 spawn 一套

**文件:行号**
- `index.js:594-595`（`replaced ? [] : state.roles.slice()`）、`index.js:624`（`staffed: replaced ? {} : staffed`）
- `index.js:834-837`（`existing !== undefined && !respawn` 才复用）、`index.js:842-867`（重名重试后以 `<id>-2` 另起）
- `index.js:1052-1054`（`team_form` 默认 `autoStaff` 时立刻 `staffRoles`）、`index.js:1029-1035`（roster 先落盘）

**问题**
`team_form` 的 `replace:true` 在投影里把 `staffed` 整个清空（624），但旧成员的子代理**没有被停止**——插件没有任何停止/回收路径，`startActivation` 返回的 `dispose` 也没有保存（`index.js:844-866` 只留了 `childId`）。随后 `team_form` 默认 `wantStaff=true`（1052），`staffRoles` 看到的 `state.staffed` 已是空对象，于是把每个角色重新 spawn 一遍；同名子代理冲突后重试 3 次，成功时名字变成 `architect-2`、`qa-2`（842-867）。

结果：
1. 旧成员仍在运行、仍在往 lead 会话镜像 `team_report`，但 `staffed` 里已经没有它们，面板/提示词显示"未上岗"；
2. 同一 role 同时有两个成员，`writeScopes` 完全相同，lead 若把同一任务重新派给新成员，就是两个 agent 并发改同一批文件；
3. 面板按 `role.id` 只显示新成员的名字，旧成员的报告 `role` 可能已不在新编制里，连"最近汇报"都归不到组织树节点；
4. `replace:false` 不受影响（`staffed` 保留），但用户"改一下编制"通常就是走 `replace:true`。

**触发条件**
已经上岗过的团队，再次调用 `team_form` 并带 `replace:true`（或在模板重建时用 `replace`），且未显式 `staff:false`。这是 README 里"建/改编制"的常规用法。

**建议改法**
按"replace = 换角色清单，不是开除所有人"处理：roster 折叠只丢弃**已被移出编制**的 `roleId`，保留仍在 `roles` 里的上岗记录；这样 `staffRoles` 的复用分支（834-837）会自然命中，不会重复 spawn。

```js
// index.js:614-626 — 只清理被删掉的 roleId
const kept = new Set(next.map(role => role.id))
const leftover = {}
for (const [roleId, entry] of Object.entries(state.staffed)) {
  if (kept.has(roleId)) leftover[roleId] = entry
}
return { ...state, roles: next, staffed: leftover, /* ... */ }
```

如果确实要让某个角色用新 charter 重启，应走显式的 `team_staff { respawn: true }`，并在 `team_form` 的 `replace:true` 且 `state.staffed` 非空时，于返回值/文案里提示"旧成员仍在运行，改 charter 需要 respawn"。长期看应把 `startActivation` 的 `dispose` 存进进程内 `Map<childId, dispose>`，在 replace/删除角色时显式停止（不能进会话日志，因为函数不可序列化），否则"停止成员"这个能力永远缺失。

---

## P1 数据/体验错误

### P1-1 分叉会话会继承一份"幻影团队"（staffed 有 childId，但 fork 的子树里没有这些成员）

**文件:行号**：`index.js:596-624`（事件折叠出 `staffed`）、`index.js:834-837`（仅凭 `staffed` 复用）、`README.md:26`、`docs/DETAIL.md:13`（宣称"可分叉，不会错位"）

**问题**
fork 复制会话日志，投影重放出同样的 `staffed`（含 `childId`），但子代理的 activation 树是运行时对象，fork 的 `rootSessionId` 下没有这些 child。于是：
- lead 的提示词/面板显示"已上岗"（`index.js:1504`、`client.js:225`），lead 不会再组队；
- `team_staff` 看到 `existing !== undefined` 直接 `reused`，永远不会真的 spawn（834-837）；
- 成员后续的 `team_report` 镜像通过 `rootOf` 写回**原**会话，不会写进 fork；
- fork 里 `collectMemberReports` 的 `listDescendants(forkId)` 抛错/为空（769-771），`team_status` 查不到这些成员（`memberReports` 通常为空），任务板也通常为空。

用户在 fork 里看到"团队已就绪"，实际没有任何成员在这个分支里工作。这是文档明确承诺的能力，属于发布前必须处理的错误。

**触发条件**：对一个已上岗团队所在会话执行分叉，然后在 fork 里继续派活。

**建议改法**
把"已上岗"的定义改成"`childId` 仍在当前会话的 descendant 列表里"，而不是"`staffed` 里有键"：

```js
// staffRoles：复用前对账（一次调用查一次即可）
let liveIds = null
async function liveChildIds(agent) {
  try {
    const rows = await subagents.listDescendants(agent.session.id)
    return new Set(rows.filter(r => r.kind === 'child' && typeof r.id === 'string').map(r => r.id))
  } catch { return null } // 查询失败时保守地当作 live，避免重复 spawn
}
// ...
const live = await liveChildIds(agent)
if (existing !== undefined && !respawn && (live === null || live.has(existing.childId))) { /* reused */ }
```

`team_status` 同时应输出 `staleStaffed`（在 `staffed` 但不在 descendants 里的 roleId），提示 lead 重新 `team_staff`；或者干脆在 `team_status` 的 roles 里把 stale 的 `name` 置空。若不想做这套对账，至少不要把 `staffed` 写进投影、或在 README/DETAIL 里明确"分叉后团队需要重建"。

### P1-2 上岗记录只在全部 spawn 成功后写一次；写失败只给 warning，重试会重复 spawn

**文件:行号**：`index.js:866-878`（循环里只 `fresh.push`，循环后一次性 `writeRecord(STAFF_EVENT)`，失败只 `warning`）、`index.js:834-837`（下次只认 `staffed`）

**问题**
成员 A、B 已经启动，写 `STAFF_EVENT` 时若 `writeRecord`/`flush` 抛错（模块解析失败、session 正在 append 的重入保护、磁盘/flush 失败），工具只返回一段 `warning`，`state.staffed` 里没有 A、B。用户或模型看到"上岗了成员但记录没写进会话日志"，很可能重试 `team_staff`；重试时 `staffed` 为空，于是再次 spawn，重名触发 `-2` 后缀，又得到一份重复成员。这与 P0-1 是同一类"孤儿成员"后果，只是触发面更窄。

**触发条件**：≥1 个 `startActivation` 成功后写日志失败；或进程在循环结束后、写日志前崩溃（此时连 warning 都没有）。

**建议改法**
每成功启动一个角色就立刻落一条记录（N≤8，flush 成本可接受），把"已经启动"的窗口缩到单个角色；并把 `writeRecord` 失败从"仅 warning"升级为返回值里的结构化字段：

```js
started.push({ roleId, name, childId, reused: false })
try {
  writeRecord(agent.session, STAFF_EVENT, { entries: [{ roleId, title, name, childId, at: Date.now() }] })
  await flush(agent.session)
} catch (error) {
  warning = `成员 ${name} 已启动，但上岗记录写入失败：${msg(error)}。请先 team_status 对账，不要重复 team_staff。`
}
```

另外 `team_staff` 在复用判断前，可以用 `listDescendants` 对账一次（见 P1-1），这样即使日志丢了也不会重复 spawn。

### P1-3 汇报线成环时 `GraphView.assign` 无限递归，面板静默消失

**文件:行号**：`client.js:436-447`（`const assign = role => { ... const slots = children.map(assign) ... }`，无 visited）、`client.js:448-449`（roots + 兜底都调用 `assign`）；对照 `client.js:143-168` 的 `orderRoles` 是带 visited 的。

**问题**
`orderRoles` 能安全处理环（160-161 的 visited），但 `GraphView` 重新构建 `childrenOf` 后，`assign` 没有任何环保护。`a → b → a` 时：`roots` 为空，`assign(a) → assign(b) → assign(a) …` 直到 `RangeError: Maximum call stack size exceeded`。`TeamPanel` 的 render 抛出后，`dsh-client-ui-renderer` 的 `SlotErrorBoundary`（scoped-slots.tsx 444-469）会吞掉异常并渲染一个空 div——**整个"团队"面板从头部消失**，用户只看到控制台里一条 `slot entry crashed`，且刷新后依旧。

**触发条件**
- 从旧版本升级：v1 的 `validateRoster` 不拒环（`test/REVIEW.md` 的 F1 就是当时的复现），`stateVersion` 从 1 升到 2 后 DSH 会丢弃旧 checkpoint、从日志重放，环会被原样折叠进 `state.roles`；
- 手改/第三方写入的 `plugin:team-mode/roster` 事件带环或悬空 `reportsTo`（fold 不校验，见 P2-3）。

注意：`team_form` 现在会拒绝新造的环（`validateRoster`），所以这条不是"新用户第一次用就炸"，但升级用户会中招，而 README:95/DETAIL:82 声称"成环只渲染一次，不递归崩溃"。

**复现（临时目录，未入库）**
`C:\Users\luoke\AppData\Local\Temp\team-mode-review\graph-cycle2.mjs`：用替身 React 强制 `open=true`、`__view='graph'`，把 `TeamPanel → GraphView` 递归渲染出来，得到：

```
GraphView CAUGHT: RangeError: Maximum call stack size exceeded
    at assign (client.js:443)
```

**建议改法**
布局复用 `orderRoles` 已经算好的 `depth`：把指向同级或更浅节点的边当作回边丢掉，环就被切断成一棵树，且所有节点仍落在原来的层上（2 环时 a 在上、b 在下，不会重叠）。

```js
// client.js:419 已有 depthOf；在 assign 里过滤回边
const assign = role => {
  const children = (childrenOf.get(role.id) ?? [])
    .filter(child => (depthOf.get(child.id) ?? 0) > (depthOf.get(role.id) ?? 0))
  if (children.length === 0) {
    slotOf.set(role.id, columns.length)
    columns.push(role.id)
    return slotOf.get(role.id)
  }
  const slots = children.map(assign)
  const slot = (slots[0] + slots[slots.length - 1]) / 2
  slotOf.set(role.id, slot)
  return slot
}
```

另一条路是给 `assign` 加一个递归路径 `Set`：`children` 里若出现路径中的祖先，就把它当叶子处理（给它独立的一列）而不是继续递归；这也保证 `map` 永远拿得到数字，不会返回 `undefined`。

### P1-4 输入框开关会覆盖用户正在写的草稿（`setDraft` 是整段替换）

**文件:行号**：`client.js:280-288`（`actions.setDraft('/team ' + next)` + `actions.submit()`）；契约见 `dsh-client-ui-conversation/src/client/contract/input.ts:281-282`：`/** Replace the whole draft with plain text, removing inline reference chips. */ setDraft(text: string): void`

**问题**
用户正在输入框里写一段话（或插入了文件/引用 chip），点一下输入框左侧的"团队"开关，`setDraft('/team off')` 会把整段草稿**替换掉**，引用 chip 被移除；随后 `submit()` 直接把命令发出去。用户的正文没有任何恢复路径。如果当时正在跑一轮、`submit` 被拒绝，草稿里也只剩 `/team off`，用户原来的内容同样没了。

**触发条件**：草稿非空时点击输入框左侧的团队开关（这是这个 chip 最主要的用法）。

**建议改法**
只在草稿为空时走"写入并提交"的快捷路径；草稿非空时不要动 composer，改为提示（或把开关做成纯命令按钮，让用户自己回车）。`SessionStandardProps` 提供 `useInput`，`InputState.draft` 是当前草稿（contract/input.ts:306-308），可以据此判断：

```js
const input = typeof props.useInput === 'function' ? props.useInput() : undefined
const draft = input?.state?.draft ?? ''   // 具体取法以 useInput 返回的 store 形状为准
if (draft.trim() === '' && typeof actions.setDraft === 'function') {
  actions.setDraft(`/team ${next}`)
  if (typeof actions.submit === 'function') actions.submit()
} else {
  // 不清空用户输入：提示用户先发送或手动输入 /team off
  setHint(`输入框有内容，未自动切换；请先发送，或手动输入 /team ${next}`)
}
```

如果拿不到草稿，宁可去掉 `setDraft` + 自动 `submit`，只保留一个说明性按钮，也不要把"覆盖用户输入"作为默认行为。

### P1-5 `team_status` 的镜像去重键包含 `role`，成员自报 role 与 agent 名不一致时同一条汇报显示两次

**文件:行号**：`index.js:1370-1371`（`new Set(flatReports.map(r => `${r.role}|${r.at}|${r.summary}`))`，再按同样的键过滤 `memberReports`）；`index.js:789-800`（`collectMemberReports` 把 `role` 覆盖成 `entry.path || entry.name`）

**问题**
成员调用 `team_report` 时通常会把 `role` 写成人话（例如 `role:"前端"`），而它在子代理树里的 `path/name` 是 `frontend`。镜像记录（写进 lead 会话）的 `role` 是 `"前端"`，`collectMemberReports` 从成员自己会话读出来的副本 `role` 被改写成 `"frontend"`。两边键不同，去重失效，`team_status` 的"最近汇报"和"成员汇报"里会出现同一句话两次。同理，lead 会话只保留最近 20 条镜像（`index.js:1361` 与 `index.js:670` 的 `slice(-20)`），超过 20 条之后早期成员的汇报也会重新出现在 `memberReports` 里。

**触发条件**
成员在 `team_report` 里传的 `role` 与它的 agent 名/路径不一致（很常见，因为工具描述让模型填"角色 id"，而模型常填标题）；或团队累计汇报超过 20 条。

**建议改法**
去重不要依赖 `role`：`at`（毫秒）+ `summary` 已经足够唯一；需要更稳可以加 `childId`。并且用 `state.reports.slice(-40)`（fold 的实际上限）做镜像集合，而不是工具输出里的 20 条：

```js
const mirrored = new Set(flatReports.map(r => `${r.at}|${r.summary}`))
const unique = memberReports.filter(r => !mirrored.has(`${r.at}|${r.summary}`))
```

更根本的做法是让 `team_report` 在写镜像时把 `role` 归一成 `agentName`（或用 `namesOf(agent).self`），成员自报的展示名放到另一个字段（`label`），这样两份记录的键天然一致。

### P1-6 `writeRecord` 的模块解析只覆盖 app.asar 布局；npm CLI / 非 asar 安装会全功能不可用

**文件:行号**：`index.js:89-129`（候选只有 `TEAM_MODE_DSH_SESSION`、`DSH_INSTALL_DIR`、argv 里的 `app.asar/dsh`、`execPath/resources/app.asar/dsh`、硬编码 `D:/dsh/...`）、`index.js:704-719`（失败文案）

**问题**
`createRequire(candidate)` 的每个候选都假设 dsh-session 在 asar 内的 `node_modules` 或某个固定目录。以下安装方式没有任何候选：
- `dsh` 通过 npm/pnpm 全局安装：`process.execPath` 是 `node`，`argv` 里没有 `app.asar`，只有 `<prefix>/node_modules/@deepseek-ai/dsh/bin/dsh.js` → 全部候选失败；
- 插件装在 profile 目录、由 DSH 从另一处加载：插件自身位置没有被用作解析起点；
- 同时装了两个 DSH 版本：先命中的候选可能不是正在运行的那份，`Session` 类不一致，`index.js:712-716` 直接抛错。

失败时用户看到的是工具报错（文案清楚，`/team on|off` 也返回 error），但**四个工具和 `/team` 全部不可用**，且错误发生在第一次调用而不是插件加载时，排查成本高。DETAIL:26 宣称"createRequire 必得同一 Session 实例"，与多安装场景不符。

**触发条件**：非 Electron asar 安装（npm CLI）、profile 安装、机器上有多个 DSH 版本。

**建议改法**
增加"从正在运行的程序位置解析"的候选，并优先用 `require.resolve` 而不是拼路径：

```js
function addFromScript(script) {
  if (typeof script !== 'string' || !path.isAbsolute(script)) return
  try {
    const req = createRequire(path.join(path.dirname(script), 'noop.js'))
    const entry = req.resolve('@deepseek-ai/dsh-session/package.json', { paths: [path.dirname(script)] })
    candidates.push(entry)
  } catch { /* next */ }
}
for (const arg of process.argv.slice(1)) addFromScript(arg)
for (const base of [process.cwd(), path.dirname(process.execPath)]) {
  try {
    const req = createRequire(path.join(base, 'noop.js'))
    candidates.push(req.resolve('@deepseek-ai/dsh-session/package.json'))
  } catch { /* next */ }
}
```

另外：把解析结果在 `apply` 时探测一次，失败就把警告写进插件日志/面板提示，而不是等用户第一次 `team_form` 才炸；README 补一节"TEAM_MODE_DSH_SESSION 指向哪里"（现在只在错误文案里出现）。

### P1-7 `staffRoles` 没有串行化，并发进入会双份 spawn

**文件:行号**：`index.js:815-889`（整个函数无锁）、`index.js:1054`、`index.js:1147`（两个入口都直接调用）

**问题**
`staffRoles` 先读 `stateOf(agent)` 的 `staffed`，再 `await startActivation(...)`。两次调用并发进入时，双方都可能看到 `staffed[roleId] === undefined`，于是各 spawn 一个；后一个遇到重名又走 `-2` 重试。结果与 P0-1 相同：同一角色两个成员。触发方式包括：模型在同一轮发出两个 `team_staff` 工具调用、用户连点两次、`team_form` 与 `team_staff` 同时到达。

**触发条件**：同一会话内 `staffRoles` 并发执行（是否并发取决于 DSH 对同轮多工具调用的调度，但只要有可能就应防御）。

**建议改法**
模块级按会话串行化：

```js
const staffing = new Map() // sessionId -> Promise
function withStaffingLock(sessionId, fn) {
  const prev = staffing.get(sessionId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  staffing.set(sessionId, next.finally(() => { if (staffing.get(sessionId) === next) staffing.delete(sessionId) }))
  return next
}
// staffRoles 内部：return withStaffingLock(agent.session.id, async () => { ... })
```

并在拿到锁之后重新 `stateOf(agent)`，不要用调用方传进来的旧 state（`team_form` 传的 `stateOf(agent)` 是 roster 写入前的快照，这一点在 P0-1 修复后尤其重要）。

---

## P2 建议

### P2-1 `/team status` 没有 try/catch，命令会 reject

`index.js:1426-1427`：`''`/`status` 直接 `return { kind:'success', text: describeTeam(agent) }`，而 `describeTeam` → `stateOf` 可能抛（投影未就绪、handle 失效）。`on/off` 分支有 try/catch，status 没有，失败时用户看到命令执行错误而不是可读文案。建议与 1432-1437 一致地包 try/catch，返回 `{ kind:'error', text: ... }`。

### P2-2 role id `constructor` 会"幽灵上岗"，永远无法真正 spawn

`index.js:666-669`（`state.staffed[role.id]?.name`）、`index.js:834-837`（`existing !== undefined`）、`index.js:1497`（unstaffed 判断）都用普通对象直接索引。`ROLE_ID`（`index.js:140`）允许 `constructor`，此时 `state.staffed['constructor']` 命中 `Object.prototype.constructor`：
- `wire.view` 给出 `name: 'Object'`，面板显示已上岗；
- `team_staff` 把 `Object` 函数当成 `existing`，`existing.name` 是 `'Object'`，直接 `reused` 并 `continue`——**永远不会调用 `startActivation`**；
- 提示词也不会催它上岗。

修法：所有 `staffed` 查找改为 `Object.hasOwn(state.staffed, roleId) ? state.staffed[roleId] : undefined`，并在 `emptyState` 里用 `Object.create(null)`；`staff` 折叠赋值前也校验 `Object.hasOwn(roles, roleId)`。顺带把 `__proto__` 事件挡掉。

### P2-3 投影 fold 不校验 `reportsTo`/环/重复 id，与 DETAIL:39 的承诺不符

`index.js:592-635` 的 roster/staff 折叠只做归一化，不调用 `validateRoster`。新写入靠 `team_form` 侧校验（`index.js:1028`），但旧日志重放、手改日志、第三方写事件都会绕过。客户端 `orderRoles` 有 visited 能兜底，`GraphView` 不能（P1-3）。建议在 fold 里做一次轻量校验：丢弃 `reportsTo` 不在 roles 里的角色（改为 `'lead'`）、丢弃自汇报、检测到环时把环边断开（例如把该角色 `reportsTo` 改为 `'lead'`）。注意不能因此让 `apply` 抛错——抛错会传播到触发 append 的调用方。

（`staff` 事件虽然也不校验 `roleId` 是否在 `roles` 里，但 `wire.view`、`describeTeam`、`staffRoles.staffedCount` 都按 `roles` 过滤，未知 id 不会被显示；它只会永久留在日志里，正常情况下无害。）

### P2-4 命令/提示词重复注册会在热重载时激活失败

`index.js:1448-1460` 的 `commands.register` 忽略了返回的 disposer；`dsh-commands` 的 `NamedEntries` 对同名命令直接抛 `command "team" is already registered`。插件热重载/重复 apply 时 `/team` 注册会失败（整个插件激活可能失败）。建议用 `ctx.effect` 或 `ctx.on('dispose', ...)` 持有 disposer；`systemPrompt.context` 同理（重复 name 抛 `prompt context "team-mode:roster" is already registered`，`index.js:1469`）。若无法拿到 disposer，至少先 `commands.has?.('team')` 跳过并记录。

### P2-5 文档与实现不一致（发布前应改文档或改实现）

| 文档 | 声明 | 实际 |
| --- | --- | --- |
| `docs/DETAIL.md:17` | "三种插件记录" | 表里列了 4 种（roster/staff/report/policy） |
| `docs/DETAIL.md:39` | 畸形/成环"折叠和渲染两侧都有防御" | fold 不校验环；`GraphView.assign` 无 visited，成环 RangeError |
| `docs/DETAIL.md:75` | "按 (role, at) 去重" | 实际键是 `role|at|summary`（`index.js:1370-1371`），且 alias 不一致时失效（P1-5） |
| `docs/DETAIL.md:82` | 汇报线渲染带 visited，成环只渲染一次 | `orderRoles` 有 visited，`GraphView` 没有 |
| `README.md:95` | `panel-cycle.mjs` 测"汇报线成环不崩" | 该测试强制 `useState` 返回 `false`，只渲染关闭态面板，根本没进 `GraphView`（见 P2-6） |
| `docs/DETAIL.md:26` | createRequire 必得同一 `Session` 实例 | 多安装/非 asar 场景不成立（P1-6） |

### P2-6 测试缺口与最小用例（按优先级）

现有三条命令在临时快照上均通过：`projection.test.mjs` 29/29、`render-smoke.mjs` all passed、`panel-cycle.mjs` 输出 "FIX A2 verified"。但下面的真实风险没有覆盖：

| 风险 | 建议最小用例 |
| --- | --- |
| 成环 + 打开 + 图谱视图（P1-3） | 改 `panel-cycle.mjs` 的替身 `useState` 首次返回 `true`，并用一个会递归渲染函数组件的 walker（现有 graph-cycle2.mjs 的思路）断言 `GraphView` 不抛；或直接断言 `assign` 的 visited 行为 |
| replace + autoStaff 双份（P0-1） | 在 `projection.test.mjs` 里：先 roster+staff 两条事件，再发 `replace:true` 的 roster，断言 `state.staffed` 对保留 id 仍有值；再跑 `team_form` 的替身，断言 `startActivation` 调用次数为 0（复用） |
| 上岗记录写失败（P1-2） | mock `writeRecord` 对 `STAFF_EVENT` 抛错，断言返回 `warning`、`started` 仍列出成员，且第二次 `team_staff` 不会重复 spawn（需要 P1-1 的对账或锁） |
| fork 幻影团队（P1-1） | 构造 `staffed:{architect:{childId:'old'}}` + `listDescendants` 返回空，断言 `team_status` 标 stale / `staffRoles` 重新 spawn |
| 成员 role alias（P1-5） | 让成员报告 `role:'前端'`、path `frontend`，断言 `team_status` 的 `reports`+`memberReports` 合并后只有 1 条 |
| `sessions.get`/`listDescendants` 抛错（已部分覆盖） | 补 `collectMemberReports` 在 `listDescendants` 抛错、`stateOf` 抛错时返回 `[]` 而不 reject |
| `/team status` 抛错（P2-1） | `stateOf` 抛错时断言 handler 返回 `{kind:'error'}` 而不是 reject |
| `constructor` role（P2-2） | roster 里放 `id:'constructor'`，断言 `team_staff` 会真的调用 `startActivation` |
| 草稿覆盖（P1-4） | 替身 `setDraft` 记录调用；`useInput` 返回非空 draft 时断言 `setDraft` 未被调用 |
| `runningNamesOf`（新代码，P2-8） | 用 store 快照替身覆盖 `projectionsBySession[parentId].values.subagentCatalog` 缺失/形状变化，断言返回 `''` 不抛 |

另外 `test/panel-cycle.mjs` 的头注释仍引用旧行号（`client.js:92-112`、`index.js:460-472`）和"orderRoles 无 visited"的旧事实，建议更新，否则下一个人会被误导。

### P2-7 发布元数据与硬编码

- `package.json`：`private: true`、`name: "@local/team-mode"`、`version: "0.1.0"`，没有 `license`/`repository`/`peerDependencies`（DSH 的版本约束应写清楚），发布前需要处理；
- `index.js:116` 硬编码 `'D:/dsh/resources/app.asar/dsh'`：在开发机上可能命中另一个安装，若类不一致会给出"多个 DSH 版本"的误导性错误；建议删掉或只在 `NODE_ENV=development` 时尝试；
- `memberName`（`index.js:548-552`）：31 字符的 role id + `-2` 会被 `slice(0,32)` 截成 `<id>-`，attempt 1 与 2 得到同一个名字，重试必然继续撞名；建议保留后缀、截断主体（例如 `id.slice(0, 30) + '-' + n` 并对 n 做 base36），或直接给 childId 派生名字。

### P2-8 客户端 `running` 新逻辑依赖内部 store 形状

`client.js:213-223` 与 `client.js:248-263`：为了显示"成员正在运行"，`runningNamesOf` 直接读 `state.projectionsBySession[parentId].values.subagentCatalog`，并与 `state.items` 做 `find` 匹配。这属于会话 store 的内部结构，升级 DSH 后一旦改名就会静默失效（`running` 永远为空，图谱不再有呼吸环）；而且 `items.find` 对每个 catalog entry 线性扫描，成员多时是 O(n²)（n≤8，可接受）。建议：把这段读逻辑收敛到一个函数并加一条 store 快照测试；若 DSH 有公开的 `subagentCatalog` 投影读取 API，优先用它。`props.useSessions` 不存在时已经回退为空串（217-223），这一点是好的。

---

## 附：验证记录

- `node --check index.js client.js schema.js`：通过。
- `node test/projection.test.mjs`：`29/29 checks passed`。
- `node test/render-smoke.mjs`：`all render smoke checks passed`。
- `node test/panel-cycle.mjs`：输出 `FIX A2 verified: panel renders a cyclic roster without RangeError`，但只渲染关闭态（P2-6）。
- 成环复现：`C:\Users\luoke\AppData\Local\Temp\team-mode-review\graph-cycle2.mjs` → `RangeError: Maximum call stack size exceeded`（`assign` 在 `client.js:443`）。
- DSH 实现核对基于 `D:\dsh\resources\app.asar` 解包（临时目录），关键点：`appendPluginRecord` 要求 `ignorable` 记录经 `#appendRecord`；投影 `drive` 对每个事件调 `apply` 并对订阅者调 `wire.view`（异常向外传播）；`listDescendants` 返回 `child`/`diagnostic` 混合行；`startActivation` 的 `name` 冲突会抛（team-mode 因此重试出 `-2`）。
