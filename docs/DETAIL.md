# 团队模式 · 实现说明

## 分层

```
host (index.js)                        client (client.js)
├─ 4 个工具 team_form/staff/report/status   ├─ 输入框开关 chip（conversation.input.left）
├─ 投影 teamMode（fold 会话日志）           ├─ 团队页（conversation.view，id "team"）
├─ /team 斜杠命令                          └─ 会话中继（header.utilities，不渲染）
└─ 每会话提示词（systemPrompt.context）
```

Host 只写会话日志，不保存进程内状态；Client 只读投影，不缓存。因此重放、分叉、重启都不会错位。

### 为什么团队页在 `conversation.view`

面板先后试过三个座位，前两个都失败过，记下来免得再踩：

1. `conversation.session.header.utilities`——那一格由 `conversation.session.header`（WC 条目）
   声明，而它在客户端半区装载**之后**才挂载：一次性 `ctx.slots.inject` 落在座位还不存在的时刻，
   格子停在 `inactive`，按钮静默消失（输入框 chip 的座位挂得更早，不受影响）。1.0.4 的
   1.2s/4s/9s 重试只是缓解——重试全在挂载前跑完就仍然失效。
2. `shell.overlay`——根级座位，格子确实 `active: true`，但该层在应用外壳里**不显示**（不显示任何
   条目，包括最简的一行文字）。所以 1.1.0 的浮层按钮与面板都看不见。
3. `conversation.view`——对话页自己的 View 行（「对话 / 轨迹 / 上下文 / 团队 / 编队」），
   **会话级**座位：直接拿到 `sessionId`、`useProjection`、`useSessions`、`useInput`，不需要中继，
   也不会被裁或在冷启动时丢格子。团队页就是这里的一个 tab。

`conversation.session.header.utilities` 的中继组件仍然保留（`TeamProbe`，渲染 `null`），因为它
还是 `/team` 状态的低成本观察点：它把当前会话的视图写进模块级 `panelStore`，供测试与未来的浮层
入口复用；中继不渲染任何东西，所以即使它停在 inactive 也不影响用户看到的界面。

## 会话日志是唯一真相

三种插件记录（`plugin:` 前缀，`ignorable: true`）：

| 记录 | 写入者 | 内容 |
| --- | --- | --- |
| `plugin:team-mode/roster` | `team_form` | 目标、模板、角色数组、是否替换 |
| `plugin:team-mode/staff` | `team_staff` / `team_form` | 角色 → 子代理名、childId |
| `plugin:team-mode/report` | `team_report`（成员）+ 镜像到 lead | 一条结构化汇报 |
| `plugin:team-mode/policy` | `/team on/off` | 本会话是否自动组队 |

为什么必须这样写：DSH 恢复会话时会校验事件类型，未注册且非 `ignorable` 的类型会让会话打不开（`SessionFormatUnsupportedMigrationError`）。`appendPluginRecord` 是唯一会置 `ignorable` 的入口，它来自当前运行的 `@deepseek-ai/dsh-session`；插件用 `createRequire` 解析同一份模块，因此拿到的是同一个 `Session` 类实例（校验 `writer.Session !== session.constructor`）。

`apply` 里用 `recordKind()` 同时识别旧写法 `team/*` 与新写法 `plugin:team-mode/*`，老会话升级后仍能显示编制。

### 写入路径自证（别再退回 `session.append`）

`writeRecord()` 是唯一写入口，它做三件事，任何一件不满足就显式抛错而不是静默降级：

1. 解析当前运行的 `@deepseek-ai/dsh-session`（`createRequire` + 多候选：`TEAM_MODE_DSH_SESSION` → `DSH_INSTALL_DIR/..` → 从 `process.argv`/`execPath` 推 `app.asar` 路径 → 向上 walk `node_modules`）；
2. 校验 `writer.Session === session.constructor`（private brand，不同实例的同名类无法 append）；
3. 调用 `writer.append(session, type, data)`，即 `appendPluginRecord`。它内部 `deepFreeze` 并强制 `ignorable: true`，同时用
   `PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u` 校验类型。

回归保护（`test/projection.test.mjs`）：① 跑完 `team_form`/`team_staff`/`team_report` 后逐条断言落盘事件
`type.startsWith('plugin:') && ignorable === true`，且类型集合恰为 `roster/staff/report`；② 扫描宿主源码断言不存在
`.append('team/...')` 或 `appendPluginRecord(..., 'team/...')` 这类裸写；③ 测试 fixture 的 `appendPluginRecord` 按真实正则
校验类型，非法直接抛错——所以「改回裸 `team/*`」既过不了单测也进不了会话日志。

### 帧结构与逐帧保真

DSH 的 `.zstd` 会话日志是**多帧追加**的（一次写入一帧），不是单个 zstd 流；只解第一帧会丢掉后面所有内容。所以修复工具：

- 按帧结构切帧（帧头 + 块头，`ZSTD_MAGIC = 4247762216`），而不是搜 `28 b5 2f fd`——压缩数据内部可能出现同样的字节序列；
- 每帧独立解压成功才算一帧，末尾撕裂的半帧原样保留在文件尾部；
- 只重压**改过**的帧，未改动的帧用 `buffer.subarray(start, end)` 原字节复制，帧数不变、字节不变；
- 压缩参数与 DSH 一致：`{ params: { [ZSTD_c_checksumFlag]: 1 } }`。

真实文件实测：2646 帧 / 2 条待修（seq 897 `team/roster`、seq 1170 `team/staff`）；`--write` 后
`repaired 2 event(s) in 2 frame(s); 2644 frame(s) untouched`，逐帧比对仅 2 帧变化。

### 自愈提示

插件不会在用户打开坏会话撞上 `unknown event type` 之后才说话：

- `apply` 末尾 `setTimeout(1500).unref()` 异步扫一次最近的会话日志（深度 ≤3、按 mtime 倒序、单文件上限 8 MiB），有命中就
  `logger.warn`；
- `team_status` 的输出带 `legacyWarning` 字段、`/team status` 末尾贴同样的段落，点名会话 id、实际类型与**可直接复制执行的命令**；
- 扫描用的是同一个 `findLegacyLogs()`，只把「本 harness 不认识」的类型算作待修（`team/task`、`team/mode`、`team/member`、
  `team/message/*` 是内置 Agent Teams 的合法类型，不能误报）。

## 投影 `teamMode`

```
state: { goal, template, roles[], staffed{}, reports[], policy{}, updatedAt }
wire : { goal, template, auto: boolean|null, updatedAt, roles[{...role, name}], reports[-20..] }
```

- `auto` 为 `null` 表示跟随插件默认；`true/false` 是本会话显式开关。
- `roles[].name` 由 `staffed` 派生，面板据此显示「已上岗 / 未上岗」。
- 畸形记录（`null` 角色、重复 id、成环汇报线）在折叠和渲染两侧都有防御，不会毒化整个 slot。

## 提示词注入

`ctx.systemPrompt.context({ name: 'team-mode:roster', order: 125, text: ({ agent }) => ... })`：

- 无编制 + 根会话 + 开关打开 → 注入「按需自动组队」策略（什么时候组队、什么时候自己做）。
- 有编制 → 注入目标、角色树、已/未上岗、派活与汇报约定。
- 子代理（`namesOf(agent).parent !== undefined`）或开关关闭 → 返回 `''`，零 token 成本。
- 文案是常量，跨轮稳定，不会破坏提示词缓存。

## 上岗

`team_staff` 对每个未上岗角色调用：

```js
ctx.subagents.startActivation({
  provider: 'spawn',
  label: role.title,
  name: memberName(role.id, attempt),  // 冲突时 pm → pm-2、pm-3
  prompt: [{ type: 'text', text: charter }],
  parent: agent,
  signal,
  delivery: 'parent',
})
```

charter 由 host 生成：角色身份、职责、交付物、汇报线、写入范围、团队规则（先认领任务、边做边汇报、别越界写别人的范围）。成员完成时结论自动回到 lead。

## 汇报聚合

成员把汇报写进**自己的**会话。`team_status` 与面板要看到它，有两条路：

1. `team_report` 写完成员会话后，镜像一条到 lead 会话（面板实时可见）。
2. `collectMemberReports()` 用 `subagents.listDescendants()` + `sessions.get(id)` + `handle.stateOf()` 读每个成员会话的权威汇报。

汇总时按 `(at, summary)` 去重，避免镜像与权威记录重复展示。

## 客户端渲染约束

- 不 import 任何 harness 客户端包；用注入的 `React.createElement`，样式走 `--dsw-alias-*` token。
- 头部 slot 会裁剪浮层，所以面板 `position: fixed`，并在 Escape / 外部点击时关闭。
- 输入框 slot 内的按钮不 portal；草稿为空时用 `inputActions.setDraft('/team off') + submit()` 一键切换，草稿非空时改为
  `insertText()` 追加而不提交（不吞用户正在打的字）。
- 汇报线渲染与图谱布局都带 `visited/walked` 集合，成环只渲染一次，不递归崩溃。
- 「谁在干活」的信号是 `SessionSummary.running`（`useSessions(state => ...)` 里按 `subagentCatalog` 把 childId 映射成角色名，
  selector 返回**逗号拼接字符串**以保证 primitive 比较）；节点标题/成员名用 canvas `measureText` 按像素截断并居中。
- 图谱节点可点击：面板内 `RoleDetail` 展示职责/交付物/写入范围/任务/最近汇报；客户端 slot 没有「打开子会话」的写接口，
  详情底部只能指路「会话头部的成员菜单」。
- 开关的三种显示由投影的 `auto` 推出：`null` = 自动、`true` = 开、`false` = 关；有草稿时只把 `/team …` 插进输入框，
  空草稿才 `setDraft + submit`（`requestSwitch()` 统一处理，chip 与面板徽标都走它）。
- 图谱尺寸交给 `viewBox` + `width:100%; height:auto`，不写死像素高度；否则面板较窄时右侧节点会被裁掉。
  节点标题按 `pos.span - 10` 量、字号 10.5，绘制字号必须与测量字号一致，否则仍会溢出。
- 交互元素统一 `min-height:24px` + `aria-label`/`title`，focus 环由面板内的一段 `<style>` 提供（`:focus-visible`）。

## 修复旧会话

```bash
node tools/session-repair.mjs --session "<.../session.v4.jsonl.zstd>"          # dry run，含 before/after 自检
node tools/session-repair.mjs --session "<.../session.v4.jsonl.zstd>" --write  # 关闭 DSH 后执行
node tools/session-repair.mjs --all                                            # dry run，扫最近会话
node tools/session-repair.mjs --all --write                                    # 关闭 DSH 后批量修复
```

日志是多帧 zstd；工具按帧结构切帧、只重压改过的帧（未改帧原字节、帧数不变），逐行把**未知**类型改写为
`plugin:team-mode/*` 并补 `ignorable`，落盘前用 harness 自己的 `restoreReleasedV4Artifact` 自检，不通过拒绝写。
细节见上文「写入路径自证 / 帧结构与逐帧保真 / 自愈提示」。
