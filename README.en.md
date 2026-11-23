# Team Mode

[简体中文](README.md) | English

Turn DSH from "one agent does everything" into "a team splits the work": give it a goal and it
assigns roles with their own duties, each role runs as an independent subagent in parallel, and the
results come back to the lead along a reporting line.

- **Automatic rosters** — state the goal; the lead calls `team_form` with a built-in template and staffs
  the roles. You never have to name team members.
- **Real division of labour** — every role is a separate subagent with its own session, duties,
  deliverables and write scope, so one agent is not carrying the whole task.
- **A reporting line** — roles form a tree via `reportsTo`; members submit structured reports with
  `team_report` (status / summary / evidence / blockers / next) and the lead aggregates them with
  `team_status`.
- **Visible** — the **团队** tab next to 对话 / 轨迹 / 上下文 shows the roster, the shared task board and the
  latest activity; a team switch sits in the composer.

## Install

DSH plugins are bundles installed into a *profile*, not command-line tools. Let the agent do it
(installs and enables in one step):

```
plugin_manager install_bundle target=dsh-team-mode registry=https://registry.npmjs.org
```

The equivalent manual route:

```bash
cd ~/.dsh/profiles/<your profile>
pnpm add dsh-team-mode --registry https://registry.npmjs.org
# add dsh-team-mode to dsh.profile.bundles in that profile's package.json, then restart DSH
```

For local development against a checkout: `plugin_manager install_bundle target=<absolute repo path>`
(installs a `link:` so code changes apply after reloading the bundle).

The bundle id is `team-mode` (the patch id in `cordis.patch.yml`); the npm package is `dsh-team-mode`.
Reload with `plugin_manager set_plugin target=include:team-mode enabled=false`, then `enabled=true`.

Requires DSH `>=0.2.2-rc.1 <0.4.0-0` and Node `>=20`.

## Quick start

1. Open a session and state the task, e.g. "build a landing page for the team-mode plugin".
2. When the work needs several specialities the lead calls `team_form` on its own and staffs the roles;
   you can also ask explicitly: "put together a team with the market research template".
3. Members work in parallel and report as they go; when everything is done the lead summarises once.
4. For a simple task, skip the team: click the team button left of the composer, or send `/team off`.

## The switch

| Action | Effect |
| --- | --- |
| The `Team · auto/on/off` button left of the composer | One-click toggle (same as `/team on`, `/team off`) |
| `/team off` | This session stops auto-forming teams; simple tasks stay with the lead |
| `/team on` | Restores on-demand team forming |
| `/team status` | Prints the current roster, staffed count and report count |

The composer button shows three states so you can read the mode at a glance: `Team · auto` (follows the
default), `Team · on 3/7`, `Team · off`. When the composer holds a draft, clicking the button does not
overwrite it: it inserts `/team on` or `/team off` into the draft and you press Enter. With an empty
draft it submits directly.

The mode badge next to the panel title (`auto`, `on`, `off`) is also a button and toggles the same way.
The small dot to its right is a heartbeat: amber means a member is working, red means a task is blocked,
dark means idle.

The switch is stored **per session** (in the session log, so it survives replay and forking); `auto` in
`cordis.patch.yml` is only the default for new sessions.

## The four tools

| Tool | Used by | What it does |
| --- | --- | --- |
| `team_form` | lead | Creates or replaces the roster from a template or explicit roles; staffs every unstaffed role by default |
| `team_staff` | lead | Staffs (or re-staffs) specific roles |
| `team_report` | members | Submits a structured report: `status` / `summary` / `evidence` / `blockers` / `next` |
| `team_status` | lead | Aggregates the roster, the task board and member reports (including the latest report from members still working) |

`team_form` templates: `software`, `video`, `research`, `content`, `generic`. You can also pass `roles`
to define a roster yourself.

## The panel

The team is a View of the conversation: pick **团队** in the `对话 / 轨迹 / 上下文 / 团队 / 编队`
row and the whole column becomes the panel. It shows:

> The seat is a session-scoped View, so it follows session switches on its own, caches nothing and
> never depends on a floating layer or on the session header being mounted. With no roster the page
> explains how to form one (and where the composer switch is) instead of staying blank.

- **Goal / switch state / progress** — active and completed task counts, unstaffed roles.
- **Member cards** — one card per role in an adaptive grid. **Every member has its own stable identity
  colour**: the title, border and staffed badge use it while body text stays neutral, so even a long
  roster never blurs into one block. A working member's card glows and sweeps; unstaffed roles get a
  dashed badge.
- **Task queue (three stages)** — `in progress / next up / completed`, each row carrying the member's
  colour bar and name. The queue reorders the moment a task changes (assigned, claimed, finished): it
  reflects the live board, **it is not a fixed layout**.
- **Recent activity** — a timeline with a rail and glowing dots (time, role, status, summary, evidence,
  blockers, next).

Two views, switched from the panel header:

- **List** — a grid of member cards, the three-stage task queue and the activity timeline. Click any
  card to expand that member's details.
- **Graph** — an SVG node graph. A `lead (you)` bar on top, role nodes below it arranged by reporting
  level, arrows as reporting lines, and the tasks assigned to a role as small cards under its node.
  Node strokes, titles, chips, connectors and hand-off labels all use the member's own colour, with a
  colour legend on top. While a member is working, its node pulses and its reporting line turns into a
  flowing dashed line, annotated with the number of hand-offs.
  - **Who is working** — a node pulses when the member's sub-session is `running`, or its latest report
    is `in_progress`, or it owns an active task. The graph lists `working: …` above; when nobody is
    working it says so instead of staying empty.
  - **Click a node for details** — duties, deliverables, write scope, member name, all tasks assigned to
    the role and the two latest reports (with evidence / blockers / next). Click again or "collapse" to
    close. The role's full conversation lives in the member menu in the session header; the detail card
    says so.

Panel data comes entirely from session projections (`teamMode`, `agentTeam`): nothing is cached or
synced separately, so switching sessions never shows stale state.

To look at the panel offline (without opening the GUI):

```bash
node tools/preview-graph.mjs --view graph   # → preview/panel-graph.html
node tools/preview-graph.mjs --view list    # → preview/panel-list.html
node tools/preview-graph.mjs --view graph --select qa   # → preview/panel-graph-qa.html (role detail open)
```

## Capacity

- Concurrent subagents: **8** (DSH `maxActiveSubagents` default; further activations wait for a free slot).
- Delegation depth: **1** level by default, so members cannot spawn grandchildren — the team stays flat.
- The plugin's own `maxMembers` defaults to 8; `team_form` fails loudly above it.

## Configuration (`cordis.patch.yml`)

```yaml
config:
  maxMembers: 8    # maximum roles in one roster
  auto: true       # default: may the root session form teams on demand
  autoStaff: true  # staff roles automatically after team_form builds a roster
```

## Known limits

- Members' step-by-step work (each tool call) stays in their own sessions; the lead only sees what they
  submit with `team_report`.
- Reports are mirrored into the lead's session for the panel; the authoritative record is the member's
  own session.

## Repairing old sessions (0.1.x → plugin records)

Early 0.1.x builds wrote events with `session.append('team/roster' | 'team/staff' | 'team/report')`.
Those type names are not in DSH's `KNOWN_SESSION_EVENT_TYPES` and carried no `ignorable` flag, so the
session **failed to open after a restart** with
`SessionFormatUnsupportedMigrationError: format v4 contains unknown event type "team/roster"`.
Writes now go through `appendPluginRecord` (`plugin:team-mode/*`, where DSH enforces `ignorable: true`).

Convert historical logs with `tools/session-repair.mjs`, **while DSH is closed** (a running process keeps
appending to the same file):

```bash
# Inspect first: frame count, events needing repair, and the harness' own verdict before/after
node tools/session-repair.mjs --session "<session file>"

# Batch: scan recent sessions and repair every legacy log
node tools/session-repair.mjs --all
node tools/session-repair.mjs --all --write

# Single file
node tools/session-repair.mjs --session "<session file>" --write
```

Safeguards: frames are split by the zstd frame structure (not by scanning for magic bytes, so
`28 b5 2f fd` inside compressed data cannot split a frame); only types **this harness does not know** are
rewritten (built-in Agent Teams events such as `team/task`, `team/mode`, `team/member`,
`team/message/*` are preserved byte for byte); untouched frames are copied verbatim so the frame count
never changes; before writing, the result is fed to the harness' own `restoreReleasedV4Artifact` and the
write is refused if verification fails (`--force` overrides only when verification is unavailable).
Backups are written as `*.bak-<timestamp>` and the new file is staged as `<file>.repairing-<pid>` then
renamed.

If the asar modules cannot be found, pass
`--modules <...\app.asar\dsh\node_modules\@deepseek-ai>` (verification needs it). After loading, and on
every `team_status` / `/team status`, the plugin reports remaining legacy logs (session id + event types)
together with the exact command above.

## Tests

```bash
node test/projection.test.mjs      # tool contracts, projection folding, prompt, switch, write-path proof, legacy-log hint
node test/render-smoke.mjs         # real rendering of the panel and the switch (stub React)
node test/panel-cycle.mjs          # a cyclic reporting line does not crash
node test/session-repair.test.mjs  # D6: a multi-frame log is rejected before repair and accepted after
```
