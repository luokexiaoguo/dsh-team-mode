# 审查回复（对应 REVIEW-RELEASE.md）

结论：**P0 1 条、P1 7 条已全部修复；P2 8 条中 5 条已修复，3 条记入已知边界。**

验证：`node --check index.js|client.js|schema.js` 通过；`test/projection.test.mjs` 29/29；`test/render-smoke.mjs` 通过；`test/panel-cycle.mjs` 通过（成环不再抛 RangeError）。

## P0

| 编号 | 处理 |
| --- | --- |
| P0-1 `replace:true` 不停旧成员 | 已修。`team_form` 在写 roster 记录前调用 `retireMembers()`，对旧 `staffed` 的每个 `childId` 调 `subagents.interrupt(childId, {kind:'user'})`；失败信息并入 `staffing.warning`（「旧成员没停下：…」），不会静默。 |

## P1

| 编号 | 处理 |
| --- | --- |
| P1-1 分叉会话幻影团队 | 已修（首次工具调用时收敛）。新增 `reconcileMembers()`：用 `subagents.listDescendants()` 校验每个 `staffed.childId` 是否在本会话树里，缺失则写 `staff` 记录的 `{roleId, retired:true}`；折叠分支支持 `retired` 删除成员。`team_status` 与 `/team status` 都会先执行；`team_form`/`team_staff` 之后的读取也基于收敛后的状态。文档已同步为「分叉后首次 team_status/`/team status` 会清理」。 |
| P1-2 上岗记录只在全部成功后写一次 | 已修。`runStaffing()` 每成功启动一个成员就写一条 `staff` 记录并 flush；写失败只记录 warning，已启动的成员不会因为后续失败而丢失。 |
| P1-3 `GraphView.assign` 无环保护 | 已修。`assign()` 增加 `walked` 集合与「跳过已访问子节点」，成环时未定位节点退化为不渲染，而不是 `RangeError`；`panel-cycle.mjs` 断言面板仍渲染。 |
| P1-4 输入框开关覆盖草稿 | 已修。`TeamChip` 通过 `props.useInput(s => s.draft)` 读草稿：草稿为空才 `setDraft + submit`（一键切换）；草稿非空时改用 `insertText(' /team off ')` 追加，由用户按 Enter 发送，绝不覆盖正文与引用 chip。 |
| P1-5 镜像去重键含 role | 已修。去重键改为 `${at}|${summary}`（同一条汇报的 role 可能来自成员路径或自报，时间戳+摘要才是身份）。 |
| P1-6 模块解析只覆盖 app.asar | 已修（覆盖更多布局）。候选路径新增：从 `process.argv[1]`、`process.cwd()`、`process.execPath` 各自向上走 5 层找 `node_modules/@deepseek-ai/dsh-session`；仍保留 `DSH_INSTALL_DIR`、`app.asar` 推导、`TEAM_MODE_DSH_SESSION` 覆盖。全部失败时报错会列出尝试过的路径。 |
| P1-7 并发上岗无锁 | 已修。`staffingLocks` 按会话 id 串行化，并发调用直接报错「上一次上岗还没跑完」。 |

## P2

| 编号 | 处理 |
| --- | --- |
| P2-1 `/team status` 无 try/catch | 已修。整个 handler 包 try/catch，异常返回 `{kind:'error'}`；`describeTeam` 变 async 并容错。 |
| P2-2 `constructor` 幽灵上岗 | 已修。`validateRoster` 拒绝与 `Object.prototype` 同名的角色 id；`staffed` 改为 null-prototype 对象，`'constructor'` 之类不再命中原型链。 |
| P2-3 投影 fold 不校验环/悬空 | 部分修。写入侧由 `validateRoster` 强校验；读取侧保持宽容（旧日志/手改日志不能毒化面板，F3 的行为），客户端 `orderRoles`/`assign` 双保险。文档里已注明「fold 不做校验，校验在写入侧与渲染侧」。 |
| P2-4 热重载重复注册 | 已修（部分）。`systemPrompt.context` 注册包 try/catch，重名不再导致激活失败；命令注册仍依赖 `ctx.inject`，如遇重名会由 registry 自身报错。 |
| P2-5 文档与实现不一致 | 已修。README/DETAIL 中分叉、高亮判据、开关行为、记录类型均已更新。 |
| P2-6 测试缺口 | 部分修。新增/改写覆盖：成环渲染（panel-cycle）、running 高亮、详情卡、`/team` 三态、镜像去重、null 角色、replace 清理。仍缺：并发上岗、interrupt 调用、retired 折叠的单测（在 `docs/DETAIL.md` 列为待补）。 |
| P2-7 发布元数据 | 已修。`package.json` 增加 `engines.dsh` 与 optional `peerDependencies`（dsh-session / dsh-subagent / dsh-tools）；`@local/team-mode` 名字属于本地 profile，对外发布前应改 scope。 |
| P2-8 `running` 依赖内部 store 形状 | 记录为已知边界。`runningNamesOf()` 读 `sessions.items[].running` 与 `projectionsBySession[].values.subagentCatalog`，任何异常结构返回空字符串（面板退化为「无高亮」而不是崩溃）；DSH 升级若改动这两个形状，需要同步这里。 |

## 已知边界（发布说明里应保留）

1. 面板不能跳转子会话：会话级 slot 只有读接口，点击节点展开的是面板内详情；完整对话在头部成员菜单里。
2. 客户端不支持 import：全部组件手写 `React.createElement`，不引第三方库。
3. 高亮依赖 `SessionSummary.running`；若宿主改名，降级为不亮（不影响功能）。
4. 分叉会话的幻影成员在首次 `team_status`/`/team status` 后清理，面板在此之前可能显示旧名字。
