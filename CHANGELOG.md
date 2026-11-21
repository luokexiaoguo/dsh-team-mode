# Changelog

## v1.0.4 — 2026-11-21

- 修复：冷启动时标题栏「团队」入口可能不出现（`conversation.session.header.utilities`
  在客户端装载时还没挂载，一次性 `inject` 会停在 inactive；输入框 chip 因为挂载更早不受影响）。
  现在注册会重试几次，同 id 重注册只是替换自己的格子，不会产生重复入口

## v1.0.3 — 2026-11-20

- 修复：包改名后客户端 bundle 的模块 id 仍是旧名（`@local/team-mode`），
  客户端按包名装载，导致重启后「团队」按钮与面板不出现（host 侧工具一切正常）
- 新增 `tools/scan-client-ids.mjs`：列出已安装插件 client bundle 注册的模块 id，便于自查约定

## v1.0.2 — 2026-11-20

- 新增英文 README（`README.en.md`），中文 README 顶部可切换
- 仓库描述改中英双语，homepage 指向 npm 页面
- 新增 `tools/open-market-pr.mjs`：一条命令向 `awesome-dsh-plugin` 提交市场收录 PR
- 新增 `tools/upload-release-assets.mjs`：把 npm tarball 附到对应 GitHub Release

## v1.0.1 — 2026-11-20

- 重新发布以修复 v1.0.0 的 npm tarball 缺失（`latest` 指向的包不可安装）
- README 安装章节改写：profile 内 registry 安装 / 本地 `link:` 开发两种路径
- `1.0.0` 与占位版本 `0.0.0-stage` 标记为 deprecated，安装时引导到 1.0.1+

## v1.0.0 — 2026-11-20

首个公开发布版本。

- 四个工具：`team_form`（建/改编制并按需上岗）、`team_staff`（补上岗）、`team_report`（结构化汇报）、
  `team_status`（汇总编制 / 任务板 / 成员汇报）
- 5 套模板：软件研发、视频制作、调研分析、内容运营、通用项目；也支持显式 `roles`
- 会话面板两视图：列表（组织树 + 任务板 + 动向）与图谱（节点图、汇报线箭头、任务卡片、
  干活中的节点呼吸高亮与流动连线、点击看角色详情）
- 输入框团队开关三态（自动/开/关）+ `/team on|off|status` 命令，按会话持久化
- 每次上岗 / 汇报都写入 `plugin:team-mode/*` 会话记录，重开与分叉都不丢编制
- 旧会话日志修复工具（`tools/session-repair.mjs`）：只改写本 harness 不认识的类型，
  逐帧保真、落盘前用 `restoreReleasedV4Artifact` 自检，不通过拒绝写

### 已知问题

- 本版本的 npm tarball 上传失败（`latest` 指向的包不可安装）。请使用 **1.0.1 及以上**。

## v0.1.x — 开发期（未发布）

- 从零实现：投影 `teamMode`（roster / staff / report 三类记录）、per-agent 提示词注入（`AUTO_POLICY`）、
  客户端面板与开关、汇报镜像与成员汇报聚合、`maxMembers` / `auto` / `autoStaff` 配置
- 发布前审查修复：`replace` 不清旧成员、分叉幻影团队、成环导致面板崩溃、草稿被覆盖、
  并发上岗竞争、模块解析只覆盖 app.asar 等
- P0：早期版本用 `session.append('team/...')` 写事件，导致重启后会话打不开；改为
  `appendPluginRecord`（`plugin:team-mode/*` + `ignorable`），并提供批量修复工具与自愈提示
- UX：三态开关、面板心跳、焦点环、图谱 lead 节点与「交接 N 单」标注、文字按像素测量居中
