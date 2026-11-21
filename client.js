/**
 * Two surfaces for one team: a switch in the composer and a panel in the header.
 *
 * - `conversation.input.left` holds the switch, because turning the team on or
 *   off is a per-request decision the user makes while typing (`/team on|off`).
 * - `conversation.session.header.utilities` holds the panel button. The header
 *   clips its entries, so the panel is `position: fixed` and closes on Escape or
 *   an outside click.
 *
 * The panel renders the same data two ways: a readable list (duties, board,
 * activity) and a node graph (reporting tree + tasks flowing down their line).
 * Everything shown comes from projections the host half already writes:
 * `teamMode` for the roster, mirrored reports and the switch state, `agentTeam`
 * for the shared task board. Nothing is cached here, so a reload or a session
 * switch cannot desync the view.
 */
window.__ModuleLoader__.load({
  // Must match package.json "name": the client runner keys bundles by package name.
  id: 'dsh-team-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The interface is zh-CN; the strings stay inline so neither surface needs
    // the locale service and both render identically in any profile.
    const COPY = {
      button: '团队',
      title: '团队模式',
      goal: '目标',
      org: '组织',
      board: '任务板',
      reports: '汇报',
      activity: '最近动向',
      empty: '还没有编制，让 lead 调用 team_form 组建团队',
      closed: '收起团队面板',
      open: '展开团队面板',
      unstaffed: '未上岗',
      noGoal: '（未设置目标）',
      taskCount: (total, done) => `${done}/${total} 完成`,
      blocked: '阻塞',
      next: '下一步',
      evidence: '证据',
      on: '开',
      off: '关',
      auto: '自动',
      chipAuto: '团队 · 自动',
      chipOn: '团队 · 开',
      chipOff: '团队 · 关',
      chipRoster: (staffed, total) => `团队 · 开 ${staffed}/${total}`,
      chipRosterAuto: (staffed, total) => `团队 · 自动 ${staffed}/${total}`,
      switchHint: '点击切换团队模式（等同 /team on、/team off）',
      switchOn: '点一下关掉团队模式',
      switchOff: '点一下打开团队模式',
      switchDraft: '草稿非空：点击只把 /team 命令插进输入框，回车发送',
      leadNode: 'lead（你）',
      leadHint: '团队负责人：派活与验收',
      handoff: count => `交接 ${count} 单`,
      toList: '切换到列表视图',
      toGraph: '切换到图谱视图',
      closePanel: '关闭团队面板',
      progress: (active, done, waiting) => `进行中 ${active} · 完成 ${done} · 待上岗 ${waiting}`,
      noActivity: '成员还没提交汇报；他们的每一步工具调用都在各自会话里。',
      viewList: '列表',
      viewGraph: '图谱',
      graphHint: '节点 = 角色，连线 = 汇报线，节点下方 = 派给它的任务；正在干活的节点会呼吸高亮，点它看详情。',
      unownedTasks: '未认领任务',
      noTasks: '任务板还没有任务（lead 用 team_task_create 派活后会出现在这里）。',
      working: '干活中',
      workingNow: '正在干活',
      idle: '空闲',
      idleHint: '现在没有成员在干活：上岗的成员一旦开始执行，对应节点会亮起并让连线流动。',
      detail: '角色详情',
      member: '成员',
      duty: '职责',
      deliverables: '交付物',
      writeScopes: '写入范围',
      detailTasks: '这件事派给它的任务',
      noDetailTasks: '目前没有派给它的任务。',
      collapse: '收起详情',
      transcriptHint: '它每一步工具调用都在自己的会话里：在会话头部的成员菜单里点这个名字，就能看到它具体在做什么。',
    }

    const STATUS_COLOR = {
      pending: 'var(--dsw-alias-state-idle-primary, #8a8a93)',
      in_progress: 'var(--dsw-alias-state-warn-primary, #d9a441)',
      completed: 'var(--dsw-alias-state-success-primary, #3f9f6f)',
      blocked: 'var(--dsw-alias-state-error-primary, #d9534f)',
      done: 'var(--dsw-alias-state-success-primary, #3f9f6f)',
      note: 'var(--dsw-alias-label-secondary, #9a9aa3)',
    }

    const muted = { color: 'var(--dsw-alias-label-secondary, #9a9aa3)' }
    const STATUS_LABEL = {
      pending: '待办',
      in_progress: '进行中',
      completed: '完成',
      blocked: '阻塞',
      deleted: '已删除',
      done: '完成',
      note: '记录',
    }
    const brand = 'var(--dsw-alias-brand-primary, #6aa1ff)'
    const lineColor = 'var(--dsw-alias-border-l2, rgba(255,255,255,0.14))'

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '26px',
      padding: '0 10px',
      borderRadius: '999px',
      border: `1px solid ${lineColor}`,
      background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))',
      color: 'var(--dsw-alias-label-primary, currentColor)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const panelStyle = {
      position: 'fixed',
      top: '56px',
      right: '18px',
      width: '460px',
      maxWidth: 'calc(100vw - 36px)',
      maxHeight: '78vh',
      overflowY: 'auto',
      zIndex: 40,
      padding: '14px',
      borderRadius: '14px',
      border: `1px solid ${lineColor}`,
      background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #1c1c1f))',
      boxShadow: '0 18px 48px rgba(0,0,0,0.4)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: '12px',
      lineHeight: '1.5',
      textAlign: 'left',
    }

    const sectionStyle = { marginTop: '12px' }
    const sectionTitleStyle = {
      margin: '0 0 6px',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-secondary, #9a9aa3)',
    }

    /** Order roles by reporting line so both views read top-down. */
    function orderRoles(roles) {
      const byId = new Map(roles.map(role => [role.id, role]))
      const children = new Map()
      const roots = []
      for (const role of roles) {
        if (role.reportsTo === 'lead' || !byId.has(role.reportsTo)) roots.push(role)
        else {
          const list = children.get(role.reportsTo) ?? []
          list.push(role)
          children.set(role.reportsTo, list)
        }
      }
      const ordered = []
      const visited = new Set()
      const walk = (role, depth) => {
        // A malformed or cyclic reporting line must not recurse forever: stop at
        // the first repeat so one bad roster cannot crash the whole slot.
        if (visited.has(role.id)) return
        visited.add(role.id)
        ordered.push({ role, depth })
        for (const child of children.get(role.id) ?? []) walk(child, depth + 1)
      }
      for (const root of roots) walk(root, 0)
      for (const role of roles) walk(role, 0)
      return ordered
    }

    /** A small dot marking one status. */
    function dot(status) {
      return h('span', {
        style: {
          display: 'inline-block',
          width: '6px',
          height: '6px',
          marginRight: '6px',
          borderRadius: '50%',
          background: STATUS_COLOR[status] ?? STATUS_COLOR.note,
          flex: '0 0 auto',
        },
      })
    }

    /** `HH:MM` for a millisecond timestamp; empty when the stamp is missing. */
    function clock(at) {
      if (typeof at !== 'number' || at <= 0) return ''
      const date = new Date(at)
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Read the session switch: `null` means "follow the plugin default". */
    function switchState(team) {
      if (team === undefined || team === null) return null
      return typeof team.auto === 'boolean' ? team.auto : null
    }

    /** The latest report per role id or member name. */
    function latestByRole(reports) {
      const latest = new Map()
      for (const report of reports) {
        if (report === null || typeof report !== 'object') continue
        const key = report.role
        if (typeof key !== 'string' || key === '') continue
        latest.set(key, report)
      }
      return latest
    }

    /** Everything the panel needs from one projection pair. */
    function readTeam(props) {
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : null
      const team = useProjection ? useProjection('teamMode') : undefined
      const board = useProjection ? useProjection('agentTeam') : undefined
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : null
      // A live member means its child Session summary says running; that is the
      // only signal that survives a member that never reported. The selector
      // returns a string so the store keeps comparing primitives.
      const runningNames = useSessions === null
        ? ''
        : useSessions(state => runningNamesOf(state, props.sessionId))
      const roles = team !== undefined && team !== null && Array.isArray(team.roles) ? team.roles : []
      const staffed = roles.filter(role => typeof role.name === 'string' && role.name !== '').length
      const reports = team !== undefined && team !== null && Array.isArray(team.reports) ? team.reports : []
      const tasks = board !== undefined && board !== null && Array.isArray(board.tasks) ? board.tasks : []
      return {
        team,
        roles,
        staffed,
        waiting: roles.length - staffed,
        ordered: orderRoles(roles),
        reports,
        latest: latestByRole(reports),
        tasks,
        done: tasks.filter(task => task.status === 'completed').length,
        active: tasks.filter(task => task.status === 'in_progress').length,
        state: switchState(team),
        running: new Set(typeof runningNames === 'string' && runningNames !== '' ? runningNames.split(',') : []),
      }
    }

    /**
     * Names of this session's child members whose Session is running right now,
     * joined for a cheap primitive selector result.
     */
    function runningNamesOf(state, parentId) {
      if (state === undefined || state === null) return ''
      const items = Array.isArray(state.items) ? state.items : []
      const catalog = state.projectionsBySession !== undefined && state.projectionsBySession !== null
        && state.projectionsBySession[parentId] !== undefined
        ? state.projectionsBySession[parentId].values?.subagentCatalog
        : undefined
      if (!Array.isArray(catalog) || !Array.isArray(items)) return ''
      const names = []
      for (const entry of catalog) {
        if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') continue
        const summary = items.find(item => item !== null && typeof item === 'object' && item.sessionId === entry.id)
        if (summary !== undefined && summary.running === true) names.push(entry.name)
      }
      return names.join(',')
    }

    /** Tasks that belong to one role, by member name or role id. */
    function tasksOf(tasks, role) {
      const names = new Set([role.id, role.title, typeof role.name === 'string' ? role.name : ''].filter(Boolean))
      return tasks.filter(task => names.has(task.ownerName) || names.has(task.ownerId))
    }

    /**
     * Flip the session switch through the slash command. The composer is the
     * only write path a slot has, so this is shared by the chip and the panel.
     */
    function requestSwitch(props, next, draft) {
      const actions = props.inputActions
      if (actions === undefined || actions === null) return
      const command = `/team ${next}`
      const typed = typeof draft === 'string' ? draft.trim() : ''
      if (typed !== '') {
        // Anything already typed is the user's own text: append instead of
        // replacing it, and let them press Enter when ready.
        if (typeof actions.insertText === 'function') actions.insertText(` ${command} `)
        else if (typeof actions.setDraft === 'function') actions.setDraft(`${draft} ${command}`)
        return
      }
      if (typeof actions.setDraft === 'function') {
        actions.setDraft(command)
        // Submitting right away makes it a real one-click switch; when the
        // composer cannot submit, the draft stays for Enter.
        if (typeof actions.submit === 'function') actions.submit()
      }
    }

    /** The switch chip in the composer. */
    function TeamChip(props) {
      const { team, roles, staffed, state } = readTeam(props)
      // The draft is the user's own text: never replace it just to flip a switch.
      const draft = typeof props.useInput === 'function'
        ? props.useInput(input => (typeof input?.draft === 'string' ? input.draft : ''))
        : ''
      // Three states have to be distinguishable at a glance, otherwise the user
      // cannot tell "follow the plugin default" from "forced on for this session":
      // 自动 = follow the default, 开 = forced on, 关 = forced off.
      const label = state === false
        ? COPY.chipOff
        : roles.length === 0
          ? (state === true ? COPY.chipOn : COPY.chipAuto)
          : (state === true ? COPY.chipRoster(staffed, roles.length) : COPY.chipRosterAuto(staffed, roles.length))
      const mode = state === false ? 'off' : state === true ? 'on' : 'auto'
      const next = state === false ? 'on' : 'off'
      const hint = state === false ? COPY.switchOff : COPY.switchOn
      const color = state === false ? muted.color : brand
      const busy = typeof draft === 'string' && draft.trim() !== ''

      const toggle = () => requestSwitch(props, next, draft)

      return h(
        'button',
        {
          type: 'button',
          'data-team-mode-switch': 'true',
          'data-team-mode-state': mode,
          title: busy ? COPY.switchDraft : hint,
          'aria-label': `${label}｜${busy ? COPY.switchDraft : hint}`,
          style: { ...buttonStyle, height: '24px', padding: '0 8px', color },
          onClick: toggle,
        },
        h('span', { style: { fontSize: '12px' } }, '👥'),
        h('span', null, label),
      )
    }

    /** The readable view: org list, task board, recent activity. */
    function ListView({ ordered, latest, staffed, roles, tasks, done, feed, tasksById }) {
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: sectionStyle },
          h('h4', { style: sectionTitleStyle }, `${COPY.org} ${staffed}/${roles.length}`),
          ordered.length === 0
            ? h('div', { style: muted }, COPY.empty)
            : ordered.map(({ role, depth }) => {
              const report = latest.get(role.id) ?? latest.get(role.name)
              const own = tasksById(role)
              return h(
                'div',
                {
                  key: role.id,
                  style: {
                    marginLeft: `${depth * 14}px`,
                    padding: '5px 0 5px 8px',
                    borderLeft: '2px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                  report ? dot(report.status) : null,
                  h('span', { style: { fontWeight: 600 } }, role.title),
                  h('span', { style: muted }, role.id),
                  h(
                    'span',
                    {
                      style: {
                        marginLeft: 'auto',
                        padding: '1px 6px',
                        borderRadius: '999px',
                        fontSize: '11px',
                        color: typeof role.name === 'string' && role.name !== '' ? brand : muted.color,
                        border: `1px solid ${lineColor}`,
                      },
                    },
                    typeof role.name === 'string' && role.name !== '' ? role.name : COPY.unstaffed,
                  ),
                ),
                h('div', { style: { marginTop: '2px', ...muted } }, role.duty),
                report ? h('div', { style: { marginTop: '2px' } }, `${clock(report.at)} ${report.summary}`) : null,
                own.length === 0
                  ? null
                  : h(
                    'div',
                    { style: { marginTop: '2px', ...muted } },
                    own.map(task => `${task.status === 'completed' ? '✓' : '·'} ${task.subject}`).join('　'),
                  ),
              )
            }),
        ),
        h(
          'div',
          { style: sectionStyle },
          h('h4', { style: sectionTitleStyle }, `${COPY.board} · ${COPY.taskCount(tasks.length, done)}`),
          tasks.length === 0
            ? h('div', { style: muted }, COPY.noTasks)
            : tasks.slice(0, 8).map(task => h(
              'div',
              { key: String(task.id), style: { display: 'flex', alignItems: 'baseline', gap: '6px', padding: '2px 0' } },
              dot(task.status),
              h('span', { style: { flex: '1 1 auto' } }, task.subject),
              h('span', { style: muted }, task.ownerName || ''),
            )),
        ),
        h(
          'div',
          { style: sectionStyle },
          h('h4', { style: sectionTitleStyle }, COPY.activity),
          feed.length === 0
            ? h('div', { style: muted }, COPY.noActivity)
            : feed.map((report, index) => h(
              'div',
              { key: `${report.at}-${index}`, style: { padding: '4px 0' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
                dot(report.status),
                h('span', { style: { fontWeight: 600 } }, report.role || 'member'),
                h('span', { style: muted }, clock(report.at)),
                h('span', { style: { marginLeft: 'auto', ...muted } }, STATUS_LABEL[report.status] ?? String(report.status ?? '')),
              ),
              h('div', null, report.summary),
              Array.isArray(report.evidence) && report.evidence.length > 0
                ? h('div', { style: { marginTop: '2px', wordBreak: 'break-word', ...muted } }, `${COPY.evidence}：${report.evidence.join('；')}`)
                : null,
              report.blockers ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #d9534f)' } }, `${COPY.blocked}：${report.blockers}`) : null,
              report.next ? h('div', { style: muted }, `${COPY.next}：${report.next}`) : null,
            )),
        ),
      )
    }

    /**
     * The node graph: roles as boxes arranged by reporting depth, a line from
     * each parent to its children, and the tasks assigned to a role hanging
     * below its box. Lines whose child is working animate, so progress reads as
     * flow rather than as a table.
     */
    function GraphView({ ordered, latest, tasks, staffed, roles, selected, onSelect, running }) {
      const live = running instanceof Set ? running : new Set()
      const W = 432
      const nodeW = 112
      const nodeH = 44
      const layerGap = 86
      const chipH = 22
      const chipGap = 4
      // A little inset keeps the outermost node off the SVG edge, where its
      // rounded border used to touch the panel's padding.
      const PAD = 10
      const depthOf = new Map(ordered.map(({ role, depth }) => [role.id, depth]))
      const childrenOf = new Map()
      const roots = []
      for (const { role } of ordered) {
        if (role.reportsTo === 'lead' || !depthOf.has(role.reportsTo)) roots.push(role)
        else {
          const list = childrenOf.get(role.reportsTo) ?? []
          list.push(role)
          childrenOf.set(role.reportsTo, list)
        }
      }

      // Tidy layout: leaves take consecutive columns, a parent sits centred over
      // its children. This keeps every reporting line vertical or gently fanned
      // out, so the diagram reads as a tree instead of a crossed mesh.
      const columns = []
      const slotOf = new Map()
      // A hand-edited log or a legacy roster can still contain a cycle; walking it
      // without a visited set recurses until the stack dies, which kills the whole
      // header slot. Guarded nodes are simply left unpositioned.
      const walked = new Set()
      const assign = role => {
        if (walked.has(role.id)) return slotOf.get(role.id) ?? columns.length
        walked.add(role.id)
        const children = (childrenOf.get(role.id) ?? []).filter(child => !walked.has(child.id))
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
      for (const root of roots) assign(root)
      for (const { role } of ordered) if (!slotOf.has(role.id)) assign(role)

      const total = Math.max(1, columns.length)
      const columnWidth = (W - PAD * 2) / total
      const span = Math.min(nodeW, columnWidth - 6)
      // The lead is a node too: it is the party every root reports to, so drawing
      // it makes "who handed this down" visible instead of implied.
      const leadY = 4
      const leadH = 28
      const leadGap = 30
      const baseY = leadY + leadH + leadGap
      const positions = new Map()
      for (const { role, depth } of ordered) {
        const slot = slotOf.get(role.id)
        if (slot === undefined) continue
        const centre = PAD + columnWidth * (slot + 0.5)
        positions.set(role.id, { x: centre - span / 2, y: baseY + depth * layerGap, role, centre, span })
      }
      const rootCentres = roots.map(role => positions.get(role.id)).filter(pos => pos !== undefined).map(pos => pos.centre)
      const leadCentre = rootCentres.length === 0
        ? W / 2
        : rootCentres.reduce((sum, value) => sum + value, 0) / rootCentres.length
      const leadW = Math.min(132, Math.max(96, columnWidth * Math.max(1, rootCentres.length) - 8))
      const maxDepth = ordered.reduce((max, { depth }) => Math.max(max, depth), 0)
      const mostChips = Math.max(1, ...ordered.map(({ role }) => Math.min(2, tasksOf(tasks, role).length)))
      const unowned = tasks.filter(task => !ordered.some(({ role }) => tasksOf(tasks, role).includes(task)))
      const height = baseY + (maxDepth + 1) * layerGap + mostChips * (chipH + chipGap) + (unowned.length > 0 ? 34 : 8)

      const stateOfRole = role => {
        const report = latest.get(role.id) ?? latest.get(role.name)
        const own = typeof tasksOf === 'function' ? tasksOf(tasks, role) : []
        const busyTask = own.find(task => task.status === 'in_progress')
        const status = report === undefined || report === null ? 'pending' : report.status
        // A live child Session is the strongest signal: the member is mid-turn
        // even when it has not reported yet.
        const live_ = typeof role.name === 'string' && live.has(role.name)
        return { report, own, status, working: live_ || status === 'in_progress' || busyTask !== undefined, busyTask }
      }

      const edges = []
      for (const { role } of ordered) {
        const pos = positions.get(role.id)
        if (pos === undefined) continue
        const parent = positions.get(role.reportsTo)
        const { working } = stateOfRole(role)
        const x1 = parent === undefined ? leadCentre : parent.centre
        const y1 = parent === undefined ? leadY + leadH : parent.y + nodeH
        const x2 = pos.centre
        const y2 = pos.y
        const handed = tasksOf(tasks, role).length
        // Arrow + a "交接 N 单" tag: the number of tasks that reached this role
        // through that line, so the flow of work reads off the diagram.
        const t = 0.6
        const mt = 1 - t
        const labelX = mt * mt * mt * x1 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x2
        const labelY = mt * mt * mt * y1 + 3 * mt * mt * t * (y1 + 26) + 3 * mt * t * t * (y2 - 26) + t * t * t * y2
        edges.push(h('path', {
          key: `edge-${role.id}`,
          d: `M ${x1} ${y1} C ${x1} ${y1 + 26}, ${x2} ${y2 - 26}, ${x2} ${y2}`,
          fill: 'none',
          stroke: working ? brand : lineColor,
          strokeWidth: working ? 2 : 1,
          strokeDasharray: working ? '5 5' : undefined,
          markerEnd: `url(#${working ? 'team-mode-arrow-live' : 'team-mode-arrow'})`,
          style: working ? { animation: 'team-mode-flow 0.9s linear infinite' } : undefined,
        }))
        if (handed > 0) {
          edges.push(h('text', {
            key: `handoff-${role.id}`,
            x: labelX,
            y: labelY,
            textAnchor: 'middle',
            fill: working ? brand : 'var(--dsw-alias-label-secondary, #9a9aa3)',
            fontSize: '9.5',
            stroke: 'var(--dsw-alias-bg-overlay, #1c1c1f)',
            strokeWidth: 3,
            paintOrder: 'stroke',
          }, COPY.handoff(handed)))
        }
      }

      const leadNode = h(
        'g',
        {
          'data-team-mode-lead': 'true',
          role: 'note',
          'aria-label': COPY.leadNode,
        },
        h('rect', {
          x: leadCentre - leadW / 2,
          y: leadY,
          width: leadW,
          height: leadH,
          rx: 14,
          fill: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))',
          stroke: brand,
          strokeWidth: 1.4,
          strokeDasharray: '5 4',
        }),
        h('text', {
          x: leadCentre,
          y: leadY + 12.5,
          textAnchor: 'middle',
          fill: brand,
          fontSize: '11',
          fontWeight: 600,
        }, COPY.leadNode),
        h('text', {
          x: leadCentre,
          y: leadY + 23,
          textAnchor: 'middle',
          fill: 'var(--dsw-alias-label-secondary, #9a9aa3)',
          fontSize: '9',
        }, fitText(COPY.leadHint, leadW - 12, 9, 400)),
      )

      const nodes = ordered.map(({ role }) => {
        const pos = positions.get(role.id)
        if (pos === undefined) return null
        const { status, working, own: allOwn } = stateOfRole(role)
        const isSelected = selected === role.id
        const staffedRole = typeof role.name === 'string' && role.name !== ''
        const own = allOwn.slice(0, 2)
        return h(
          'g',
          {
            key: `node-${role.id}`,
            'data-team-mode-node': role.id,
            'data-team-mode-working': working ? 'true' : 'false',
            'data-team-mode-selected': isSelected ? 'true' : 'false',
            role: 'button',
            tabIndex: 0,
            'aria-label': `${role.title}｜${staffedRole ? role.name : COPY.unstaffed}｜${working ? COPY.working : COPY.idle}`,
            style: { cursor: 'pointer' },
            onClick: () => { if (typeof onSelect === 'function') onSelect(role.id) },
            onKeyDown: event => {
              if (event.key === 'Enter' || event.key === ' ') {
                if (typeof onSelect === 'function') onSelect(role.id)
              }
            },
          },
          // A breathing ring is the "someone is working right now" signal; it is
          // drawn behind the box so the fill stays readable.
          working
            ? h('rect', {
              key: `ring-${role.id}`,
              x: pos.x - 3,
              y: pos.y - 3,
              width: pos.span + 6,
              height: nodeH + 6,
              rx: 11,
              fill: 'none',
              stroke: brand,
              strokeWidth: 2,
              style: { animation: 'team-mode-pulse 1.8s ease-in-out infinite' },
            })
            : null,
          h('rect', {
            x: pos.x,
            y: pos.y,
            width: pos.span,
            height: nodeH,
            rx: 9,
            fill: working
              ? 'var(--dsw-alias-brand-primary, #4a84ff)'
              : isSelected ? 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.1))' : 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))',
            // Brand colour is reserved for "this agent is running right now":
            // a staffed-but-idle node stays neutral so the live one stands out.
            fillOpacity: working ? 0.18 : 1,
            stroke: isSelected || working ? brand : lineColor,
            strokeWidth: isSelected ? 2.4 : working ? 2 : 1,
            strokeDasharray: !isSelected && !working && !staffedRole ? '4 3' : undefined,
          }),
          h('circle', {
            cx: pos.x + 8,
            cy: pos.y + 11,
            r: 3,
            fill: STATUS_COLOR[status] ?? STATUS_COLOR.note,
          }),
          h('text', {
            x: pos.centre,
            y: pos.y + 21,
            textAnchor: 'middle',
            fill: working ? brand : 'var(--dsw-alias-label-primary, currentColor)',
            fontSize: '10.5',
            fontWeight: 600,
          }, fitText(role.title, pos.span - 10, 10.5, 600)),
          h('text', {
            x: pos.centre,
            y: pos.y + 35,
            textAnchor: 'middle',
            fill: staffedRole ? 'var(--dsw-alias-label-secondary, #9a9aa3)' : 'var(--dsw-alias-label-secondary, #6f6f78)',
            fontSize: '10.5',
          }, fitText(staffedRole ? role.name : COPY.unstaffed, pos.span - 12, 10.5, 400)),
          own.map((task, index) => {
            const chipY = pos.y + nodeH + 8 + index * (chipH + chipGap)
            return h(
              'g',
              { key: `task-${role.id}-${String(task.id)}` },
              h('path', {
                d: `M ${pos.centre} ${pos.y + nodeH} L ${pos.centre} ${chipY}`,
                stroke: lineColor,
                strokeWidth: 1,
                fill: 'none',
              }),
              h('rect', {
                x: pos.x,
                y: chipY,
                width: pos.span,
                height: chipH,
                rx: 6,
                fill: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.18))',
                stroke: STATUS_COLOR[task.status] ?? lineColor,
                strokeWidth: 1,
              }),
              h('circle', {
                cx: pos.x + 8,
                cy: chipY + chipH / 2,
                r: 2.5,
                fill: STATUS_COLOR[task.status] ?? STATUS_COLOR.note,
              }),
              h('text', {
                x: pos.x + 16,
                y: chipY + chipH / 2 + 3.5,
                fill: 'var(--dsw-alias-label-secondary, #9a9aa3)',
                fontSize: '10',
              }, fitText(task.subject, pos.span - 22, 10)),
            )
          }),
        )
      })

      const unownedY = baseY + (maxDepth + 1) * layerGap + mostChips * (chipH + chipGap)
      const workingNow = ordered.map(({ role }) => role).filter(role => stateOfRole(role).working)

      return h(
        'div',
        { style: sectionStyle },
        h('h4', { style: sectionTitleStyle }, `${COPY.viewGraph} ${staffed}/${roles.length} · ${COPY.taskCount(tasks.length, tasks.filter(task => task.status === 'completed').length)}`),
        h('div', { style: { ...muted, marginBottom: '6px', fontSize: '11px' } }, COPY.graphHint),
        workingNow.length === 0
          ? h('div', { style: { ...muted, marginBottom: '4px', fontSize: '11px' } }, COPY.idleHint)
          : h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '4px', fontSize: '11px', color: brand } },
            h('span', { style: { fontSize: '13px', lineHeight: 1 } }, '●'),
            h('span', { style: { fontWeight: 600 } }, `${COPY.workingNow}：`),
            h('span', null, workingNow.map(role => role.name || role.title).join('、')),
          ),
        h(
          'svg',
          {
            viewBox: `0 0 ${W} ${height}`,
            width: '100%',
            // No fixed pixel height: the viewBox keeps the aspect ratio, so the
            // drawing scales with the panel instead of being cropped by it.
            preserveAspectRatio: 'xMidYMin meet',
            style: { display: 'block', width: '100%', height: 'auto' },
            role: 'img',
            'aria-label': `${COPY.title} ${COPY.viewGraph}`,
          },
          h('style', null,
            '@keyframes team-mode-flow { to { stroke-dashoffset: -20; } }',
            '@keyframes team-mode-pulse { 0%, 100% { opacity: .25; } 50% { opacity: .9; } }'),
          // Arrow heads are a marker per colour: a marker cannot inherit the
          // stroke of the path it decorates.
          h(
            'defs',
            null,
            h(
              'marker',
              {
                id: 'team-mode-arrow',
                viewBox: '0 0 8 8',
                refX: 7,
                refY: 4,
                markerWidth: 6,
                markerHeight: 6,
                orient: 'auto-start-reverse',
              },
              h('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.22))' }),
            ),
            h(
              'marker',
              {
                id: 'team-mode-arrow-live',
                viewBox: '0 0 8 8',
                refX: 7,
                refY: 4,
                markerWidth: 6,
                markerHeight: 6,
                orient: 'auto-start-reverse',
              },
              h('path', { d: 'M0,0 L8,4 L0,8 z', fill: brand }),
            ),
          ),
          leadNode,
          edges,
          nodes,
          unowned.length === 0
            ? null
            : h(
              'g',
              null,
              h('text', {
                x: 0,
                y: unownedY,
                fill: 'var(--dsw-alias-label-secondary, #9a9aa3)',
                fontSize: '10.5',
              }, COPY.unownedTasks),
              unowned.slice(0, 3).map((task, index) => h('text', {
                key: `unowned-${String(task.id)}`,
                x: 0,
                y: unownedY + 15 + index * 13,
                fill: 'var(--dsw-alias-label-secondary, #9a9aa3)',
                fontSize: '10.5',
              }, `· ${truncate(task.subject, 26)} ${task.ownerName || ''}`)),
            ),
        ),
      )
    }

    /** Keep SVG text inside a node; the full text stays in the list view. */
    function truncate(text, limit) {
      const value = String(text ?? '')
      return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
    }

    /**
     * SVG has no line wrapping, so text has to be cut by measured width rather
     * than by character count. In the browser the width comes from a canvas, so
     * the cut matches what the renderer draws; off the browser (tests, preview)
     * it falls back to a conservative em estimate.
     */
    let measureCanvas
    function measureWidth(text, fontSize, weight) {
      if (measureCanvas === undefined) {
        try {
          measureCanvas = document.createElement('canvas').getContext('2d') ?? null
        } catch {
          measureCanvas = null
        }
      }
      if (measureCanvas === null) {
        let estimated = 0
        for (const char of String(text ?? '')) {
          estimated += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/u.test(char)
            ? fontSize * 1.12
            : fontSize * 0.62
        }
        return estimated
      }
      measureCanvas.font = `${weight ?? 400} ${fontSize}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
      return measureCanvas.measureText(String(text ?? '')).width
    }

    function fitText(text, maxWidth, fontSize, weight) {
      const value = String(text ?? '')
      const limit = Number.isFinite(maxWidth) ? maxWidth : 80
      const size = Number.isFinite(fontSize) ? fontSize : 11
      if (measureWidth(value, size, weight) <= limit) return value
      const chars = [...value]
      let cut = chars.length
      while (cut > 0) {
        const candidate = `${chars.slice(0, cut).join('')}…`
        if (measureWidth(candidate, size, weight) <= limit) return candidate
        cut -= 1
      }
      return '…'
    }

    /**
     * What one role is doing right now: its charter, the tasks it owns and the
     * last couple of reports. This is the click-through from a graph node; the
     * full tool-by-tool trace stays in the member's own session.
     */
    function RoleDetail({ role, reports, tasks, onClose }) {
      const own = tasksOf(tasks, role)
      const staffedRole = typeof role.name === 'string' && role.name !== ''
      const mine = reports
        .filter(report => report.role === role.id || report.role === role.name || report.role === role.title)
        .slice(-2)
        .reverse()
      const row = (label, value) => h(
        'div',
        { style: { display: 'flex', gap: '6px', padding: '1px 0' } },
        h('span', { style: { ...muted, flex: '0 0 auto' } }, `${label}：`),
        h('span', { style: { wordBreak: 'break-word' } }, value),
      )
      return h(
        'div',
        {
          'data-team-mode-detail': role.id,
          style: {
            ...sectionStyle,
            border: `1px solid ${brand}`,
            borderRadius: '10px',
            padding: '8px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
          h('h4', { style: { ...sectionTitleStyle, margin: 0 } }, `${COPY.detail} · ${role.title}`),
          h('span', { style: muted }, role.id),
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, height: '18px', padding: '0 6px', marginLeft: 'auto', fontSize: '10.5px' },
              onClick: () => onClose(),
            },
            COPY.collapse,
          ),
        ),
        row(COPY.member, staffedRole ? role.name : COPY.unstaffed),
        row(COPY.duty, role.duty || '—'),
        Array.isArray(role.deliverables) && role.deliverables.length > 0 ? row(COPY.deliverables, role.deliverables.join('、')) : null,
        Array.isArray(role.writeScopes) && role.writeScopes.length > 0 ? row(COPY.writeScopes, role.writeScopes.join('、')) : null,
        h('div', { style: { marginTop: '4px', ...muted, fontSize: '11px' } }, COPY.detailTasks),
        own.length === 0
          ? h('div', { style: muted }, COPY.noDetailTasks)
          : own.map(task => h(
            'div',
            { key: String(task.id), style: { display: 'flex', alignItems: 'baseline', gap: '6px', padding: '1px 0' } },
            dot(task.status),
            h('span', { style: { flex: '1 1 auto' } }, task.subject),
            h('span', { style: muted }, STATUS_LABEL[task.status] ?? String(task.status ?? '')),
          )),
        mine.length === 0
          ? null
          : h('div', { style: { marginTop: '4px' } },
            mine.map((report, index) => h(
              'div',
              { key: `${report.at}-${index}`, style: { padding: '2px 0' } },
              h('div', null, `${clock(report.at)} ${report.summary}`),
              Array.isArray(report.evidence) && report.evidence.length > 0
                ? h('div', { style: { ...muted, wordBreak: 'break-word' } }, `${COPY.evidence}：${report.evidence.join('；')}`)
                : null,
              report.blockers ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #d9534f)' } }, `${COPY.blocked}：${report.blockers}`) : null,
              report.next ? h('div', { style: muted }, `${COPY.next}：${report.next}`) : null,
            ))),
        h('div', { style: { marginTop: '4px', ...muted, fontSize: '10.5px' } }, COPY.transcriptHint),
      )
    }

    function TeamPanel(props) {
      const { team, roles, staffed, waiting, ordered, latest, tasks, done, active, reports, state, running } = readTeam(props)
      const [ open, setOpen ] = React.useState(false)
      const [ view, setView ] = React.useState('list')
      const [ selected, setSelected ] = React.useState(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointer = event => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-team-mode-panel]') !== null) return
          if (target instanceof Element && target.closest('[data-team-mode-button]') !== null) return
          setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('pointerdown', onPointer, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('pointerdown', onPointer, true)
        }
      }, [ open ])

      if (roles.length === 0) return null
      const feed = reports.slice(-5).reverse()
      const tasksById = role => tasksOf(tasks, role)
      const graph = props.__view === 'graph' || view === 'graph'
      const blocked = tasks.filter(task => task.status === 'blocked').length
      // The header entry is visible without opening anything, so it has to carry
      // the "is anything wrong / is anything moving" signal itself.
      const heartbeat = blocked > 0
        ? 'var(--dsw-alias-state-error-primary, #d9534f)'
        : active > 0 || running.size > 0
          ? 'var(--dsw-alias-state-warn-primary, #d9a441)'
          : null
      const draft = typeof props.useInput === 'function'
        ? props.useInput(input => (typeof input?.draft === 'string' ? input.draft : ''))
        : ''

      const button = h(
        'button',
        {
          type: 'button',
          'data-team-mode-button': 'true',
          'data-team-mode-heartbeat': heartbeat === null ? 'idle' : blocked > 0 ? 'blocked' : 'busy',
          'aria-expanded': open,
          'aria-label': open ? COPY.closed : COPY.open,
          title: `${team.goal || COPY.noGoal} · ${COPY.progress(active, done, waiting)}`,
          style: buttonStyle,
          onClick: () => setOpen(value => !value),
        },
        h('span', { style: { fontSize: '13px' } }, '👥'),
        h('span', null, `${COPY.button} ${staffed}/${roles.length}`),
        heartbeat === null
          ? null
          : h('span', {
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '999px',
              background: heartbeat,
              display: 'inline-block',
            },
          }),
      )

      if (!open) return button

      const toggle = (next) => h(
        'button',
        {
          type: 'button',
          'data-team-mode-view': next,
          'aria-pressed': graph === (next === 'graph'),
          'aria-label': next === 'graph' ? COPY.toGraph : COPY.toList,
          title: next === 'graph' ? COPY.toGraph : COPY.toList,
          style: {
            ...buttonStyle,
            height: '24px',
            padding: '0 8px',
            fontSize: '11px',
            color: graph === (next === 'graph') ? brand : muted.color,
          },
          onClick: () => setView(next),
        },
        next === 'graph' ? COPY.viewGraph : COPY.viewList,
      )

      // The state badge used to look clickable (bordered, "click to switch" in
      // the title) while being a span. It is a real button now, so the promise
      // matches the behaviour.
      const mode = state === false ? 'off' : state === true ? 'on' : 'auto'
      const modeBadge = h(
        'button',
        {
          type: 'button',
          'data-team-mode-mode': mode,
          title: state === false ? COPY.switchOff : COPY.switchOn,
          'aria-label': `${COPY.title}：${mode === 'off' ? COPY.off : mode === 'on' ? COPY.on : COPY.auto}`,
          style: {
            padding: '2px 8px',
            minHeight: '24px',
            borderRadius: '999px',
            fontSize: '11px',
            font: 'inherit',
            cursor: 'pointer',
            color: state === false ? muted.color : brand,
            background: 'transparent',
            border: `1px solid ${lineColor}`,
          },
          onClick: () => requestSwitch(props, state === false ? 'on' : 'off', draft),
        },
        mode === 'off' ? COPY.off : mode === 'on' ? COPY.on : COPY.auto,
      )

      const panel = h(
        'div',
        {
          'data-team-mode-panel': 'true',
          role: 'dialog',
          'aria-label': COPY.title,
          style: panelStyle,
        },
        // Inline styles cannot express :focus-visible, so the keyboard focus ring
        // is declared once here for every control this plugin renders.
        h('style', null,
          '[data-team-mode-panel] button:focus-visible,'
          + ' [data-team-mode-button]:focus-visible,'
          + ' [data-team-mode-switch]:focus-visible {'
          + ' outline: 2px solid var(--dsw-alias-brand-primary, #6aa1ff); outline-offset: 2px; }'
          + ' [data-team-mode-panel] button { min-height: 24px; }'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
          h('strong', { style: { fontSize: '13px' } }, COPY.title),
          h('span', { style: muted }, team.template || 'custom'),
          modeBadge,
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } }, toggle('list'), toggle('graph')),
          h(
            'button',
            {
              type: 'button',
              'data-team-mode-close': 'true',
              'aria-label': COPY.closePanel,
              title: COPY.closePanel,
              style: { ...buttonStyle, height: '24px', padding: '0 8px' },
              onClick: () => setOpen(false),
            },
            '✕',
          ),
        ),
        h(
          'div',
          { style: { marginTop: '6px' } },
          h('span', null, `${COPY.goal}：`),
          h('span', null, team.goal || COPY.noGoal),
        ),
        h('div', { style: { marginTop: '4px', ...muted } }, COPY.progress(active, done, waiting)),
        graph
          ? h(GraphView, { ordered, latest, tasks, staffed, roles, selected, running, onSelect: id => setSelected(current => (current === id ? null : id)) })
          : h(ListView, { ordered, latest, staffed, roles, tasks, done, feed, tasksById }),
        graph && selected !== null && roles.some(role => role.id === selected)
          ? h(RoleDetail, {
            role: roles.find(role => role.id === selected),
            reports,
            tasks,
            onClose: () => setSelected(null),
          })
          : null,
        graph
          ? h(
            'div',
            { style: sectionStyle },
            h('h4', { style: sectionTitleStyle }, COPY.activity),
            feed.length === 0
              ? h('div', { style: muted }, COPY.noActivity)
              : feed.map((report, index) => h(
                'div',
                { key: `${report.at}-${index}`, style: { padding: '2px 0', display: 'flex', gap: '6px', alignItems: 'baseline' } },
                dot(report.status),
                h('span', { style: { fontWeight: 600 } }, report.role || 'member'),
                h('span', { style: { flex: '1 1 auto' } }, report.summary),
                h('span', { style: muted }, clock(report.at)),
              )),
          )
          : null,
      )

      return h(React.Fragment, null, button, panel)
    }

    // The session header is declared by an entry that mounts later than the client half on a
    // cold page load, so an immediate inject can land before the slot exists and stay inactive
    // (the composer chip mounts earlier and is unaffected). Retrying is safe: re-registering the
    // same id replaces our own cell instead of adding a second one.
    function registerSlots(ctx) {
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'team-mode',
        order: 27,
        label: COPY.button,
      }, TeamPanel))
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'team-mode-chip',
        order: 30,
        label: '团队开关',
      }, TeamChip))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        registerSlots(ctx)
        let alive = true
        const timers = [1200, 4000, 9000].map(delay => setTimeout(() => {
          if (!alive) return
          try { registerSlots(ctx) } catch (error) { console.warn('[team-mode] slot re-register failed', error) }
        }, delay))
        const stop = () => { alive = false; for (const timer of timers) clearTimeout(timer) }
        if (typeof ctx.on === 'function') ctx.on('dispose', stop)
        return stop
      },
    }
  },
})
