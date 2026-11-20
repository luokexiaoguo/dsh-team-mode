# 团队模式（team-mode）验收用例与缺陷报告

> 角色：QA（质量与缺陷）｜任务：task-2 验证 team-mode 插件（冒烟 + 宿主侧代码审查）
> 结论速览：4 条工具链主路径（组队 / 上岗 / 汇报 / 汇总）在宿主侧全部可跑通；团队面板渲染冒烟通过。
> 但存在 **1 个高severity 崩溃缺陷**（汇报线成环 → 面板 `RangeError`，`team_form` 却放行）和 3 个中severity 的数据/可移植性缺陷，详见下文。
> 真机（DSH 桌面版 GUI）尚未验收：当前 GUI 需要 `dsh web` 认证 URL，且运行中的插件仍是旧 bundle（工具 schema 无 `staff` 参数），需 lead 重载后再做一次端到端复核。

## 1. 被测版本（快照 pin）

| 文件 | 大小 | SHA-256 | 说明 |
| --- | --- | --- | --- |
| `index.js` | 53 169 B / 1301 行 | `F88100A434AD0CB21F139A55A21319CC8AC92766771721F6C7E39FE6AB630747` | 2026-11-19 21:12:08 的工作区版本 |
| `client.js` | 11 443 B / 299 行 | `CEAF1729CE7C99620E314DE910DAF4B7513BF79D6978F1B93F9C2386E092F964` | 与 20:59 快照一致 |
| `schema.js` | 5 291 B / 143 行 | `6E98CC89CD949860356B4D7EA0360167DEF89ABFD25060B1E426A49F341674E6` | 未变 |
| `package.json` | 862 B | `760501F28DF7E685557F953325060DF1DA03CF8746C3F12469AE76D9CF0B223A` | 未变 |
| `cordis.patch.yml` | 902 B | `B3B5A155D69B7A804F919B401310AC50AC55BBCF92E671C17D6F90F416C0EFB8` | 未变 |

> ⚠️ 冻结漂移：lead 在 m00463 宣布冻结的版本是 `e64af28b…`（1281 行），本报告实测时工作区已是
> `F88100A4…`（1301 行，21:12:08 又改过：新增 `team/*` 旧记录兼容、`tools/session-repair.mjs`）。
> 本报告与测试针对 **F881 版本**；若再改源码，请重跑第 2 节的命令并更新本节 hash。

测试机：Windows，Node v24.13.0；DSH 安装目录 `D:\dsh\resources\app.asar\dsh`；插件以 link 方式挂在
`C:\Users\luoke\.dsh\profiles\desktop`。

## 2. 测试资产与运行方式

| 文件 | 用途 | 命令 | 结果 |
| --- | --- | --- | --- |
| `test/projection.test.mjs` | 宿主侧 25 条用例：团队投影 + 四个工具 + 系统提示词 + schema + 写入失败路径 | `cd packages/team-mode; node test/projection.test.mjs` | **25/25 checks passed**，退出码 0 |
| `test/panel-cycle.mjs` | 复现汇报线成环导致面板崩溃（加载真实 `client.js` + React 桩） | `node test/panel-cycle.mjs` | 确认抛出 `RangeError`，退出码 0（=缺陷仍在） |
| `test/render-smoke.mjs` | 面板开/关/空态/缩进冒烟 | `node test/render-smoke.mjs` | all render smoke checks passed |
| `test/fixtures/dsh-install/…` | `@deepseek-ai/dsh-session` 的测试替身（`Session` + `appendPluginRecord`），放在 `DSH_INSTALL_DIR` 后面，验证插件确实走 appendPluginRecord | 由 `projection.test.mjs` 自动加载 | — |

测试替身的边界（重要）：替身只证明「插件解析到了 writer、并按 `appendPluginRecord(session, type, data)`
写入、且写入的事件带 `ignorable:true`」，**不证明 DSH 真实实现的格式校验 / 会话重放行为**。真机行为需第 7 节复核。

## 3. 缺陷清单

| 编号 | 严重度 | 一句话 | 位置 |
| --- | --- | --- | --- |
| F1 | **高** | 汇报线成环被接受 → 面板渲染 `RangeError`，且面板关闭时也崩 | `index.js:460-472`、`client.js:92-112,157` |
| F2 | 中 | `replace:true` 只清角色不清 `staffed`，旧成员被静默复用 | `index.js:556-568`、`index.js:730-734` |
| F3 | 中 | 投影/`wire.view` 信任畸形数据：`roles:[null]` → `TypeError` | `index.js:552-568`、`index.js:595-603` |
| F4 | 中 | 写会话依赖硬编码 `D:/dsh/...` 路径，换安装位置/打包 profile 后全部工具报错 | `index.js:87-104`、`index.js:637-645` |
| F5 | 低 | `evidence` 写入后无处可读（team_status / 面板都不展示），结构化汇报的证据链断裂 | `index.js:584,1121-1136,1230-1237`、`client.js:261-281` |
| F6 | 低 | `team_form` 在未触发上岗时把已上岗角色渲染成「未上岗」（显示与状态不一致） | `index.js:872-877` |
| F7 | 说明 | 冻结漂移（e64af → F881），RC 版本需 lead 确认 | — |

### F1（高）汇报线成环 → 面板崩溃，`team_form` 却放行

**现象**：`team_form` 接受 `a → b → a` 的编制（`validateRoster` 只查重复 id、悬空 `reportsTo`、
自汇报），随后面板 `orderRoles()` 递归无 visited 集合，渲染时栈溢出：

```
REPRO A2 panel render with a<->b cycle throws RangeError: Maximum call stack size exceeded
RangeError: Maximum call stack size exceeded
    at walk (client.js:108:17)
    at walk (client.js:109:58)   ← 无限递归
    ...
```

**影响**：面板组件在 `client.js:157` 先 `orderRoles(roles)`、之后才判断 `open`，所以即使用户不开面板，
只要该团队有环，头部「团队」按钮的渲染也会抛错（整个 slot 渲染失败），团队面板不可见。
这是验收项「团队面板可见」的直接阻断。

**复现**：
1. `node test/projection.test.mjs` → `REPRO A1` 显示 `team_form` 接受环；
2. `node test/panel-cycle.mjs` → 得到上面的 `RangeError`（脚本退出码 0 表示缺陷仍在）。

**根因**：`index.js:460-472` 缺环检测；`client.js:105-110` 的 `walk` 无 visited/depth 上限。

**建议改法**：
- `validateRoster` 增加 DFS 环检测，报错如「汇报线成环：a → b → a；请把其中一个的 reportsTo 改为 lead」；
- 同时给 `orderRoles` 加 visited 集合（双保险，防止历史会话里已存在的环把面板打挂），
  visited 之外的角色按根节点兜底（现有 `for (const role of roles)` 分支可复用）。

### F2（中）`replace:true` 残留 `staffed`，旧成员被静默复用

**现象**：第一次 `team_form`（默认 autoStaff）上岗 a、b；随后 `team_form({replace:true, roles:[…同 id 新职责…]})`
清空了 `roles` 但 `staffed` 仍是旧成员；再 `team_staff` 全部 `reused:true`，旧 agent（旧章程）继续挂在新角色下，
`team_status` 显示的名字也是旧的。

**证据**：`projection.test.mjs` → `REPRO C`：
`evidence: 重定义角色后 team_staff 全部 reused=true，旧章程的成员继续挂在新角色上`。

**根因**：`index.js:556` 的 `next = data.replace === true ? [] : state.roles.slice()` 只重置角色；
`staffRoles`（`index.js:730-734`）按 roleId 判断 `existing && !respawn`，id 相同即复用。

**建议改法**：`replace:true` 时同时把 `staffed` 清空（或仅保留 `roles` 里仍存在的 id，并提示
「N 个旧成员已解除绑定，用 team_staff 重新上岗」）；如希望保留旧成员，应在 `staffing` 里显式标 `reused` 并说明原因。

### F3（中）投影/`wire.view` 信任畸形数据

**现象**：任何来源写入 `plugin:team-mode/roster` 且 `roles:[null]`（或手工修复/损坏的会话），
`apply` 原样 push（`index.js:557-561` 未校验 role），随后 `wire.view` 的 `state.staffed[role.id]`
在 null 上取 `.id`：

```
TypeError: Cannot read properties of null (reading 'id')
```

**证据**：`projection.test.mjs` → `REPRO D`。

**影响**：历史会话被外部工具改写、或未来两个插件写同一 key 时，整个面板/team_status 读取全部失败；
`stateSchema`/`viewSchema` 只是 `{parse:v=>v}`（`index.js:550,594`），没有兜底。

**建议改法**：`apply` 里对每个 role 做一次形状校验（id 字符串、duty 字符串，非法则跳过并计数）；
`wire.view` 用 `Array.isArray(state.roles) ? … : []` 并跳过非对象项；长期可用 zod 定义 stateSchema。

### F4（中）写会话依赖硬编码安装路径

**现象**：`resolvePluginRecordWriter()` 只尝试两个候选：
`$DSH_INSTALL_DIR/../dsh-session/package.json` 与硬编码 `D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/package.json`。
若 DSH 装在别处（或测试机/别的用户机器），writer 解析不到 → `writeRecord` 抛
「团队模式写不进会话日志：找不到 DSH 的 dsh-session 模块（appendPluginRecord 不可用）」，
`team_form`/`team_staff`/`team_report` 全部不可用（报错信息清晰，但功能整体失效）。

**证据**：`projection.test.mjs` 的子进程用例（清空 `DSH_INSTALL_DIR`）捕获到上述原文。

**建议改法**：候选路径从 `process.execPath` 推导（如
`path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')`），
并保留环境变量覆盖；把 `D:/dsh/...` 从代码里移除（如确需兜底，写成注释里的示例而不是逻辑候选）。
另外建议把「找不到 writer」做成一次性的启动告警（面板/日志），而不是等用户调工具才报错。

### F5（低）`evidence` 写入后无处可读

**现象**：`team_report` 的 `evidence` 被写进投影（`index.js:584`，最多 8 条），但：
- `team_status` 的 output schema（`index.js:1121-1136`）和 execute 映射（`index.js:1230-1237`）都没有 `evidence`；
- `memberReports` 的 schema/渲染也没有（`index.js:688-695, 1152-1167`）；
- 客户端面板只显示 role/status/summary/blockers/next（`client.js:261-281`）。

结果：汇报的「证据」只能在 `team_report` 的当次返回里看到，验收「结构化汇报」时无法从面板/汇总回看证据链。

**建议改法**：`team_status` 输出与渲染各加一列 `evidence`（截断到前 1-2 条），面板里用 `title` 或展开行显示；
其余字段保持不变，避免 schema 破坏。

### F6（低）`team_form` 未上岗时的显示残留

**现象**：`autoStaff:false`（或显式 `staff:false`）时，先 `team_form` → `team_staff` 上岗，再次
`team_form`（同编制、未要求上岗），render 把全部角色显示成「未上岗」，因为 staffed 只从
`value.staffing?.started` 构造（`index.js:872-877`），而投影里的 `staffed` 实际非空。

**证据**：`projection.test.mjs` → `REPRO B`。

**影响**：仅显示层误导，不影响数据；但会让 lead 误判「还要再上岗」。

**建议改法**：`team_form` execute 里在未上岗时也返回一份 `staffing` 快照（`started` 用投影中的
已上岗角色，`reused:true`），render 即可复用同一段逻辑；或在 output 增加 `staffedNames` 字段。

### F7（说明）冻结漂移

lead 冻结的 `e64af28b`（1281 行）不是当前工作区版本；当前是 `F88100A4`（1301 行），新增了
`team/*` 旧记录兼容和 `tools/session-repair.mjs`。两份的选择需 lead 明确，**验收应对同一份 hash 重新跑
第 2 节命令**。本报告按 F881 记录（测试已在该版本上通过）。

## 4. 验收清单对照

| 验收点 | 宿主侧结论 | 备注 |
| --- | --- | --- |
| 自动组队（team_form 默认 autoStaff 一次完成组队+上岗） | ✅ 通过 | 默认参数启动 7 个角色、render 显示「已上岗 7/7」；重复调用不重复启动 |
| 分工上岗（charter/角色/写入范围/汇报线） | ✅ 通过 | 章程包含职责、交付物、写入范围、团队规则；`respawn` 会重新启动（名字冲突时按 `a-2` 重试） |
| 结构化汇报（team_report + 聚合到 team_status/面板） | ⚠️ 部分 | 写入/聚合逻辑单测通过（成员会话 → `collectMemberReports`）；`evidence` 不可见（F5）；**真机端到端未验** |
| 团队面板可见 | ⚠️ 部分 | render-smoke 通过；环缺陷可直接打挂面板（F1）；**GUI 视觉未验**（认证门禁 + 旧 bundle） |

## 5. 单测覆盖明细（`projection.test.mjs`，25 条全过）

- `team_form`：默认 autoStaff；`staff:false`/`autoStaff:false`；`staff:true` 覆盖；重复调用复用；角色数上下限；未知模板/空 goal 拒绝；环被接受（REPRO A1）；显示残留（REPRO B）；replace 残留（REPRO C）。
- 投影：`roles:[null]` 毒化 + wire 崩溃（REPRO D）；非数组 roles/缺 name 的 staff 条目被跳过。
- `team_staff`：`respawn`；无编制报错；单角色失败隔离（`failed:[{roleId,error}]`）；部分上岗。
- `team_report`：省略 role 用 `namesOf(agent).self`；namesOf 抛错时 role 为空；空 summary 拒绝；evidence 截断 8 条；写入 `plugin:team-mode/report` 且 `ignorable:true`。
- `team_status`：成员汇报聚合（`listDescendants` + `sessions.get` + 子会话投影）并渲染「成员汇报」段；`listDescendants` 失败降级 `[]`；无 subagents/sessions 时渲染空团队；任务板字段映射。
- 系统提示词：无编制时 root 注入自动组队策略、子代理不注入；有编制时列出已/未上岗并催上岗；全部上岗后不再催。
- schema 编译：`team_form` 的 `staff` 布尔/模板 enum；`team_status` 的 `memberReports` 为 required；`team_report` 的 `evidence`。
- writer 不可用：子进程清空 `DSH_INSTALL_DIR` 得到预期错误文案。

## 6. 未能验证 / 受限项

1. **真机 GUI 面板**：打不开 `http://127.0.0.1:4739`（`dsh web authentication required; reopen the URL printed by dsh web`），
   且当前 127.0.0.1:4739 上加载的仍是旧 bundle（`team_form` 工具 schema 无 `staff` 参数）。
2. **`appendPluginRecord` 真实语义**：fixture 是替身，DSH 真实实现的 `ignorable` 校验、版本迁移、重放行为未验。
3. **`collectMemberReports` 真机**：依赖 `sessions.get(id)` 与 `subagents.listDescendants(rootSessionId)`；
   cordis Service 契约确认存在这两个方法，但「成员汇报出现在 lead 的 team_status/面板」尚未在真机端到端看到。
4. **`tools/session-repair.mjs`**：仅验证了 usage 能打印（`node tools/session-repair.mjs`）；对真实旧会话的
   repair 未跑（需 DSH 停止 + 真实 session 文件，属于发布前手工步骤）。

## 7. 重载后的真机复核清单（给 lead，5 步）

1. 重载 desktop profile，确认 `team_form` 的 schema 出现 `staff` 参数（旧 bundle 没有）。
2. 新会话里 `team_form({goal, template:'software'})`，确认一次调用后 `team_status` 显示 7 个角色均已上岗。
3. 让一个成员调用 `team_report`（带 evidence）→ lead 调 `team_status`，确认出现「成员汇报（来自成员自己的会话）」段且 role 正确。
4. 打开头部「团队」面板，确认组织树/任务板/汇报可见；再构造 a↔b 汇报线，确认面板不再崩溃（F1 修复后）。
5. 重启 DSH 后重开该会话，确认 `plugin:team-mode/*` 记录可正常恢复（不出现 `SessionFormatUnsupportedMigrationError`）。

## 8. 建议修复优先级

1. **F1**（面板崩溃，阻断验收）；
2. **F2/F3**（数据正确性/健壮性）；
3. **F4**（可移植性，发布前必须解决，否则换机器即失效）；
4. **F5/F6**（体验/证据链）；
5. F7 流程：先定 RC hash，再统一复跑。
