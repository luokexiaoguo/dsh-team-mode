# 团队模式 / Team Mode

简体中文 | [English](README.en.md)

把 DSH 从「一个 Agent 干活」变成「一个团队分工干活」：确定目标后自动分配角色与职责，各角色作为独立子代理并行执行，再按汇报线把结果收回 lead（主对话）。

- **自动组队**：一句话说清目标，lead 直接调用 `team_form` 按内置模板建编制并上岗，不需要你点名成员。
- **真分工**：每个角色是一个独立子代理，有自己的会话、职责、交付物和写入范围，避免所有活压在一个 Agent 身上。
- **有汇报线**：角色之间 `reportsTo` 成树，成员用 `team_report` 提交结构化汇报（状态/结论/证据/阻塞/下一步），lead 用 `team_status` 汇总。
- **看得见**：顶部「对话 / 轨迹 / 上下文 / **团队**」里点「团队」，整页展示组织架构、任务板、最近动向；输入框左侧有团队开关。

## 安装

DSH 的插件是「装进 profile 的 bundle」，不是命令行工具。推荐让 agent 代劳（一步完成安装 + 启用）：

```
plugin_manager install_bundle target=dsh-team-mode registry=https://registry.npmjs.org
```

等价的手工做法（compliance 更直观）：

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add dsh-team-mode --registry https://registry.npmjs.org
# 再把 dsh-team-mode 加进该 profile package.json 的 dsh.profile.bundles，然后重启 DSH
```

本地开发想直接链接仓库目录：`plugin_manager install_bundle target=<仓库绝对路径>`（会以 `link:` 方式装进来，改代码后重载 bundle 即生效）。

装好后 bundle id 是 `team-mode`（`cordis.patch.yml` 里的 patch id），npm 包名 `dsh-team-mode`；重载方式：`plugin_manager set_plugin target=include:team-mode enabled=false` → `enabled=true`。

要求 DSH `>=0.2.2-rc.1 <0.4.0-0`、Node `>=20`。

## 快速开始

1. 打开一个会话，直接说要做的事，例如「做一个团队模式插件的官网落地页」。
2. 需要多专长时，lead 会自动 `team_form` 组队并上岗；你也可以显式要求：「用市场调研模板组个队」。
3. 成员并行开工，边做边用 `team_report` 汇报；全部收工后 lead 汇总成一次答复。
4. 简单任务不想组队：点输入框左侧的「👥 团队」按钮，或发 `/team off`。

## 开关

| 操作 | 效果 |
| --- | --- |
| 输入框左侧「👥 团队 · 自动/开/关」按钮 | 一键切换（等同 `/team on`、`/team off`） |
| `/team off` | 当前会话不再自动组队，简单任务 lead 自己做 |
| `/team on` | 恢复按需自动组队 |
| `/team status` | 打印当前编制、上岗数、汇报数 |

输入框左侧那个按钮有三种显示，看一眼就知道现在的状态：`团队 · 自动`（跟随默认值）、`团队 · 开 3/7`、`团队 · 关`。有草稿时点它不会覆盖你正在打的字，只把 `/team on`、`/team off` 插进输入框，回车才发送；空草稿时才直接提交。

面板标题旁的状态徽标（`自动`、`开`、`关`）也是按钮，点一下同样能切换；标题行右端的小圆点是心跳：黄=有成员在干活，红=有任务被阻塞，不亮=空闲。

开关是**按会话**存的（写进会话日志，可重放、可分叉）；`cordis.patch.yml` 里的 `auto` 只是所有会话的默认值。

## 四个工具

| 工具 | 谁用 | 作用 |
| --- | --- | --- |
| `team_form` | lead | 按模板或显式角色建/改编制，默认顺带把未上岗角色全部上岗 |
| `team_staff` | lead | 给指定角色补上岗（或重新上岗） |
| `team_report` | 成员 | 提交结构化汇报：`status` / `summary` / `evidence` / `blockers` / `next` |
| `team_status` | lead | 汇总编制、任务板、成员汇报（含尚未收工成员的最新汇报） |

`team_form` 的 `template`：`software`（软件研发）、`video`（视频制作）、`research`（调研分析）、`content`（内容运营）、`generic`（通用项目）。也可以直接传 `roles` 自定义编制。

## 面板

团队是对话页的一个 View：顶部「对话 / 轨迹 / 上下文 / **团队** / 编队」那一排点「团队」，
整块区域就是团队面板。包含：

> 这个座位是会话级正式 View，所以随会话切换自动跟着走，不缓存数据，也不依赖任何浮层或会话头部是否挂载。没有编制时页面会说明怎么组队（以及输入框左侧的开关在哪），而不是一片空白。

- **目标 / 开关状态 / 进度**：进行中、已完成任务数、待上岗角色数。
- **组织**：按汇报线缩进的树，每个角色显示职责、上岗名、最近一条汇报的状态点与摘要。
- **任务板**：共享任务板（复用 DSH Agent Teams），显示状态与负责人。
- **最近动向**：成员的汇报流水（时间、角色、状态、结论、证据、阻塞、下一步）。

面板有两个视图，标题行右侧切换：

- **列表**：组织树（缩进 + 职责 + 上岗名 + 最近汇报 + 各自任务）+ 任务板 + 最近动向。
- **图谱**：SVG 节点图。最上面是 `lead（你）` 横条，往下是角色节点（按汇报层级排布），箭头连线 = 汇报线，节点下方的小卡片 = 派给它的任务。成员正在干活时节点呼吸高亮、连线变流动虚线，线上还标着「交接 N 单」。
  - **谁在干活**：子会话 `running` 为真（成员真的在跑），或最近一条汇报是 `in_progress`、或名下有进行中的任务——满足任一条节点就呼吸高亮，图上方列出「正在干活：xxx」。没人干活时那里给一句提示，不会空着。
  - **点节点看详情**：点任意节点展开「角色详情」——职责、交付物、写入范围、成员名、派给它的全部任务、最近两条汇报（含证据/阻塞/下一步）。再点一次或「收起详情」关闭。角色自己的完整对话在会话头部的成员菜单里，详情里也给了提示。

面板数据全部来自会话投影（`teamMode`、`agentTeam`），不缓存、不额外同步，刷新或切换会话都不会错位。

想离线看一眼效果（不打开 GUI）：

```bash
node tools/preview-graph.mjs --view graph   # → preview/panel-graph.html
node tools/preview-graph.mjs --view list    # → preview/panel-list.html
node tools/preview-graph.mjs --view graph --select qa   # → preview/panel-graph-qa.html（带角色详情）
```

## 容量

- 同时活跃子代理上限：**8**（DSH `maxActiveSubagents` 默认值，超出会提示等待空闲）。
- 委派深度默认 **1** 层：成员不能再 spawn 孙代，保证团队结构扁平可控。
- 插件自身 `maxMembers` 默认 8，超过时 `team_form` 会明确报错。

## 配置（`cordis.patch.yml`）

```yaml
config:
  maxMembers: 8    # 一个编制最多几个角色
  auto: true       # 默认情况下，根会话是否允许按需自动组队
  autoStaff: true  # team_form 建完编制后是否自动上岗
```

## 已知边界

- 成员的详细过程（每次工具调用）在各成员自己的会话里；lead 这边只能看到他们主动 `team_report` 的内容。
- 汇报会镜像一份到 lead 会话用于面板展示；权威记录始终在成员自己的会话。

## 旧会话修复（0.1.x → plugin 记录）

0.1.x 早期构建用 `session.append('team/roster' | 'team/staff' | 'team/report')` 写事件，这几种类型不在 DSH 的
`KNOWN_SESSION_EVENT_TYPES` 里且没有 `ignorable` 标记，于是**重启后打不开该会话**，报
`SessionFormatUnsupportedMigrationError: format v4 contains unknown event type "team/roster"`。
现在的写入一律走 `appendPluginRecord`（`plugin:team-mode/*`，DSH 强制 `ignorable: true`）。

历史日志用 `tools/session-repair.mjs` 转换，**必须在 DSH 关闭时**执行（运行中的进程还在往同一文件追加）：

```bash
# 先看：帧数、待修事件、修复前/后的真实恢复器判定
node tools/session-repair.mjs --session "<会话文件>"

# 批量：扫描最近会话，一次修完所有遗留日志
node tools/session-repair.mjs --all
node tools/session-repair.mjs --all --write

# 单个修复
node tools/session-repair.mjs --session "<会话文件>" --write
```

工具的安全线：按 zstd 帧结构切帧（不再用 magic 扫，压缩数据里的 `28 b5 2f fd` 不会切错）；只改写**本 harness 不认识**的类型
（内置 Agent Teams 的 `team/task`、`team/mode`、`team/member`、`team/message/*` 原样保留）；未改动的帧按原字节复制、帧数不变；
落盘前把结果喂给 harness 自己的 `restoreReleasedV4Artifact` 自检，不通过就拒绝写（`--force` 才能在自检不可用时强写）。
写前备份为 `*.bak-<时间戳>`，写入用 `<file>.repairing-<pid>` + rename。

找不到 asar 里的模块时用 `--modules <...\app.asar\dsh\node_modules\@deepseek-ai>`（自检需要它）。插件加载后 1.5s、
以及每次 `team_status` / `/team status`，都会提示仍然存在的旧日志（会话 id + 类型），给出的正是上面的命令。

## 测试

```bash
node test/projection.test.mjs      # 工具契约、投影折叠、提示词、开关、写入路径自证、旧日志提示
node test/render-smoke.mjs         # 面板与开关的真实渲染（替身 React）
node test/panel-cycle.mjs          # 汇报线成环不崩
node test/session-repair.test.mjs  # D6：多帧日志修复前 REJECTED、修复后 ACCEPTED
```
