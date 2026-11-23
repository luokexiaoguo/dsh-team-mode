/**
 * Render the real panel bundle to a standalone SVG preview.
 *
 * The GUI needs an auth token we cannot mint, so this script evaluates the same
 * `client.js` with a stub React and serialises the graph the component actually
 * returns. The output is the panel's own geometry, not a hand-drawn mock — handy
 * for reviewing layout without opening DSH.
 *
 * Run: node tools/preview-graph.mjs [--view graph|list]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundle = await readFile(join(root, 'client.js'), 'utf8')
const viewArg = process.argv.indexOf('--view')
const view = viewArg === -1 ? 'graph' : process.argv[viewArg + 1]
const selectArg = process.argv.indexOf('--select')
const select = selectArg === -1 ? '' : process.argv[selectArg + 1]

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
  },
  useState(initial) {
    if (initial === null) return [select === '' ? null : select, () => {}]
    return [typeof initial === 'string' ? view : true, () => {}]
  },
  useEffect() {},
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

let mod
new Function('window', bundle)({
  __ModuleLoader__: {
    load({ factory }) {
      mod = factory(spec => {
        if (spec === 'react') return React
        throw new Error(`unexpected require(${spec})`)
      })
    },
  },
  addEventListener() {},
  removeEventListener() {},
})

const roster = {
  goal: '把「团队模式」插件在 DSH 桌面版落地并验收',
  template: 'software',
  auto: null,
  roles: [
    { id: 'pm', title: '产品经理', duty: '定义目标与验收', reportsTo: 'lead', name: 'pm' },
    { id: 'research', title: '市场与用户调研', duty: '竞品与用户调研', reportsTo: 'lead', name: 'research' },
    { id: 'architect', title: '架构与方案', duty: '技术方案与接口', reportsTo: 'pm', name: 'architect' },
    { id: 'frontend', title: '前端实现', duty: '面板与交互', reportsTo: 'architect', name: 'frontend' },
    { id: 'backend', title: '后端与数据', duty: '宿主与存储', reportsTo: 'architect', name: '' },
    { id: 'qa', title: '质量与缺陷', duty: '验证与回归', reportsTo: 'pm', name: 'qa' },
  ],
  reports: [
    { role: 'qa', status: 'in_progress', summary: '回归 25 条用例，正在补图谱断言', at: Date.now() - 600000 },
    { role: 'frontend', status: 'done', summary: '图谱视图完成，流动连线已生效', at: Date.now() - 300000 },
  ],
}

const board = {
  tasks: [
    { id: 't1', subject: '写团队面板', status: 'completed', ownerName: 'frontend' },
    { id: 't2', subject: '补图谱断言', status: 'in_progress', ownerName: 'qa' },
    { id: 't3', subject: '接口联调', status: 'pending', ownerName: 'backend' },
  ],
}

const captured = []
mod.apply({
  slots: {
    inject: (_name, register) => register(),
    register: (opts, Component) => void captured.push({ opts, Component }),
  },
})

// The panel moved to the root overlay seat: a session half publishes the view,
// then the overlay entry paints it.
const probe = captured.find(entry => entry.opts.name === 'conversation.session.header.utilities')
const overlay = captured.find(entry => entry.opts.name === 'shell.overlay')

const tree = probe.Component({
  useProjection: key => (key === 'teamMode' ? roster : board),
  // Liveness the way the real panel reads it: child Session summaries that are
  // still running, mapped through the parent's subagent catalog.
  useSessions: selector => (typeof selector === 'function'
    ? selector({
      items: [
        { sessionId: 'preview-research', running: true, parentSessionId: 'preview' },
        { sessionId: 'preview-qa', running: true, parentSessionId: 'preview' },
        { sessionId: 'preview-frontend', running: false, parentSessionId: 'preview' },
      ],
      projectionsBySession: {
        preview: {
          values: {
            subagentCatalog: [
              { id: 'preview-research', name: 'research', mode: 'continuable', label: '市场与用户调研' },
              { id: 'preview-qa', name: 'qa', mode: 'continuable', label: '质量与缺陷' },
              { id: 'preview-frontend', name: 'frontend', mode: 'continuable', label: '前端实现' },
            ],
          },
        },
      },
    })
    : undefined),
  __view: view,
  sessionId: 'preview',
})

const overlayTree = overlay.Component({ __view: view })

const flatten = v => String(v ?? '').replace(/var\(--[^,]+,\s*([^)]+)\)/g, '$1')
const ATTRS = {
  strokeDasharray: 'stroke-dasharray',
  strokeWidth: 'stroke-width',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  strokeLinecap: 'stroke-linecap',
  // SVG-only camelCase props: the preview writer has to rename them or the
  // browser ignores them (React would rename them itself in the real app).
  textAnchor: 'text-anchor',
  dominantBaseline: 'dominant-baseline',
  strokeDashoffset: 'stroke-dashoffset',
  strokeOpacity: 'stroke-opacity',
  fillOpacity: 'fill-opacity',
  vectorEffect: 'vector-effect',
  pointerEvents: 'pointer-events',
  // `marker-end` / `paint-order` are kebab-case in SVG, while `refX`,
  // `markerWidth` and `viewBox` really are camelCase and must stay that way.
  markerEnd: 'marker-end',
  paintOrder: 'paint-order',
}
// Inline style objects are the only thing that carries colour, indent and
// spacing in the list view; without this the preview renders unstyled text.
const cssText = style => Object.entries(style)
  .filter(([, value]) => value !== undefined && value !== null)
  .map(([key, value]) => `${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${flatten(value)}`)
  .join(';')
// Raw text children (<style> rules) must not be escaped or wrapped.
const rawText = node => {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(rawText).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return ''
}

const stringify = node => {  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(stringify).join('')
  if (typeof node === 'string' || typeof node === 'number') return flatten(node)
  if (typeof node.type === 'function') return stringify(node.type(node.props))
  const { children, style, ...rest } = node.props ?? {}
  if (style !== undefined && style !== null && typeof style === 'object') rest.style = cssText(style)
  const attrs = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
    .map(([key, value]) => `${ATTRS[key] ?? key}="${String(flatten(value)).replace(/"/g, '&quot;')}"`)
    .join(' ')
  const name = typeof node.type === 'symbol' ? '' : node.type
  if (name === '') return stringify(children)
  // A <style> element must keep its children as raw text, otherwise the rules
  // would be inlined into the panel as visible paragraphs.
  if (name === 'style') return `<style>${rawText(children)}</style>`
  return `<${name}${attrs ? ` ${attrs}` : ''}>${stringify(children)}</${name}>`
}

// The overlay wraps the panel in click-through layers; the preview shows the
// panel itself, so the layers are flattened here and the wrapper styles reset.
const markup = stringify(tree)
const overlayMarkup = stringify(overlayTree)
const suffix = select === '' ? '' : `-${select}`
await mkdir(join(root, 'preview'), { recursive: true })
const html = `<!doctype html><meta charset="utf-8"><title>team-mode ${view}${suffix} preview</title>
<style>
  body { margin: 0; padding: 24px; background: #17171a; color: #e8e8ec;
         font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .panel { width: 460px; box-sizing: border-box; padding: 14px; border-radius: 14px;
           border: 1px solid #34343a; background: #202024; box-shadow: 0 18px 48px rgba(0,0,0,.4); }
  .panel button { color: inherit; background: rgba(255,255,255,.05); border: 1px solid #34343a;
                  border-radius: 999px; height: 20px; padding: 0 8px; font: inherit; font-size: 11px; }
  .panel [style*="position: fixed"] { position: static !important; width: auto !important;
                  max-height: none !important; box-shadow: none !important; border: 0 !important;
                  padding: 0 !important; background: transparent !important; }
  /* The overlay seats are full-frame: flatten them so the panel can be a card. */
  [data-preview-overlay] { position: static !important; inset: auto !important; z-index: auto !important;
                  pointer-events: auto !important; }
</style>
<div id="app">${markup}</div>
<div id="overlay">${overlayMarkup}</div>
<script>
  // The component renders a fixed dialog; in the preview it sits inside a card.
  const dialog = document.querySelector('[data-team-mode-panel]')
  if (dialog) { dialog.removeAttribute('style'); dialog.className = 'panel'; }
  // The overlay draws a floating entry button plus the panel: the preview shows
  // the panel only, in both cases.
  document.querySelectorAll('[data-team-mode-button],[data-team-mode-switch]').forEach(b => b.remove())
  const layer = document.querySelector('#overlay > div')
  if (layer) layer.setAttribute('data-preview-overlay', 'true')
  const inner = layer?.querySelector(':scope > div')
  if (inner) { inner.setAttribute('style', 'display:inline-block'); layer.replaceWith(inner) }
  const overlayPanel = document.querySelector('#overlay [data-team-mode-panel]')
  if (overlayPanel) { overlayPanel.removeAttribute('style'); overlayPanel.className = 'panel' }
</script>`
await writeFile(join(root, 'preview', `panel-${view}${suffix}.html`), html, 'utf8')
console.log(join(root, 'preview', `panel-${view}${suffix}.html`))
