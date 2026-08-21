/**
 * The worktree board: every tree of every project, and who is inside it.
 *
 * Occupancy is the first thing the row says, before branch or status. Two agents
 * editing one tree overwrite each other and nothing warns them — this screen is
 * the warning, and the footer offers the way out rather than only naming the risk.
 *
 * All rules live in `model.ts` and `relocate.ts`; this file only renders them.
 */
import { For, Show, createMemo, type JSX } from "solid-js"
import { conflicts, riskOf, sortForBoard, type Occupant, type Worktree } from "./model"
import { planRelocation } from "./relocate"

export interface WorktreeBoardProps {
  /** Undefined while the trees are still being read, or when git is unreachable. */
  trees: Worktree[] | undefined
  /** True while the read is in flight, so waiting reads differently from absent. */
  loading?: boolean
  /** Why there is nothing to show, when there is nothing to show. */
  emptyReason?: string
  /** Display name per project id; the board groups by project. */
  projectName: (projectId: string) => string
  /** Epoch ms, passed in so the board never reads the clock itself. */
  now: number
  onOpen?: (tree: Worktree) => void
  onRelocate?: (input: { tree: Worktree; occupant: Occupant }) => void
  onCreate?: (projectId: string) => void
}

const RISK_LABEL: Record<string, string> = {
  conflitto: "due agenti nello stesso albero",
  occupato: "occupato",
  libero: "libero",
}

// The occupant dot carries state as shape and colour; the tooltip says it in
// words so the state survives a hover, a screen reader, and colour-blind eyes.
const OCCUPANT_STATE_LABEL: Record<Occupant["state"], string> = {
  working: "al lavoro",
  waiting: "in attesa",
  stopped: "fermo",
}

function elapsed(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return "ora"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}g`
}

export function WorktreeBoard(props: WorktreeBoardProps): JSX.Element {
  const ordered = createMemo(() => sortForBoard(props.trees ?? []))
  const inConflict = createMemo(() => conflicts(props.trees ?? []))

  // Grouped by project, but the order inside each group is the model's, so a
  // conflicted tree stays at the top of its project instead of sorting by name.
  const groups = createMemo(() => {
    const byProject = new Map<string, Worktree[]>()
    for (const tree of ordered()) {
      const list = byProject.get(tree.projectId)
      if (list) list.push(tree)
      else byProject.set(tree.projectId, [tree])
    }
    return [...byProject.entries()]
  })

  const firstPlan = createMemo(() => {
    const tree = inConflict()[0]
    if (!tree) return undefined
    const plan = planRelocation({ tree, allTrees: props.trees ?? [] })
    return plan ? { tree, plan } : undefined
  })

  return (
    <section data-component="worktree-board">
      <header data-slot="wt-bar">
        <span data-slot="wt-title">Alberi di lavoro</span>
        <span data-slot="wt-count">
          {groups().length} progetti · {(props.trees ?? []).length} alberi ·{" "}
          {(props.trees ?? []).reduce((n, tree) => n + tree.occupants.length, 0)} occupati
          <Show when={inConflict().length > 0}>
            <span data-slot="wt-count-conflict"> · {inConflict().length} in conflitto</span>
          </Show>
        </span>
      </header>

      {/* The board owns its own empty state: an emptiness explained elsewhere is
          an emptiness the next caller forgets to explain. */}
      <Show when={props.trees && props.trees.length > 0} fallback={
        <div data-slot="wt-empty">
          <span data-slot="wt-empty-title">
            {props.loading ? "Leggo gli alberi di lavoro…" : "Nessun albero da mostrare"}
          </span>
          <Show when={!props.loading && props.emptyReason}>
            {(reason) => <span data-slot="wt-empty-reason">{reason()}</span>}
          </Show>
        </div>
      }>
      <div data-slot="wt-body">
        <For each={groups()}>
          {([projectId, trees]) => (
            <div data-slot="wt-group">
              <div data-slot="wt-project">
                <span data-slot="wt-project-name">{props.projectName(projectId)}</span>
                <span data-slot="wt-project-rule" aria-hidden="true" />
              </div>

              <div data-slot="wt-grid">
                <For each={trees}>
                  {(tree) => (
                    <button
                      type="button"
                      data-slot="wt-card"
                      data-risk={riskOf(tree)}
                      onClick={() => props.onOpen?.(tree)}
                    >
                      <div data-slot="wt-card-header">
                        <span data-slot="wt-card-title" title={tree.name}>
                          {tree.name}
                        </span>
                        <span data-slot="wt-card-when">{elapsed(tree.updatedAt, props.now)}</span>
                      </div>

                      <div data-slot="wt-card-branch">
                        <span data-slot="wt-branch" title={tree.branch}>
                          {tree.branch}
                        </span>
                        <Show when={tree.ahead > 0}>
                          <span data-slot="wt-ahead">↑{tree.ahead}</span>
                        </Show>
                        <Show when={tree.behind > 0}>
                          <span data-slot="wt-behind">↓{tree.behind}</span>
                        </Show>
                      </div>

                      <div data-slot="wt-card-state" data-dirty={tree.dirty > 0 ? "true" : undefined}>
                        {tree.dirty === 0 ? "pulito" : `${tree.dirty} modificati`}
                      </div>

                      <div data-slot="wt-card-occupants">
                        <For each={tree.occupants}>
                          {(occupant) => (
                            <span
                              data-slot="wt-occupant"
                              data-state={occupant.state}
                              title={`${occupant.agentId} — ${OCCUPANT_STATE_LABEL[occupant.state]}`}
                            >
                              <span data-slot="wt-dot" aria-hidden="true" />
                              {occupant.agentId}
                            </span>
                          )}
                        </For>
                        <Show when={tree.occupants.length === 0}>
                          <span data-slot="wt-free">libero</span>
                        </Show>
                        <Show when={riskOf(tree) === "conflitto"}>
                          <span data-slot="wt-warn">{RISK_LABEL.conflitto}</span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>

                <button type="button" data-slot="wt-new" onClick={() => props.onCreate?.(projectId)}>
                  + Nuovo albero da un branch
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
      </Show>

      {/* Naming the risk without offering the move leaves the user to work out
          the fix themselves, which is the state this screen exists to end. */}
      <Show when={firstPlan()}>
        {(current) => (
          <footer data-slot="wt-alert">
            <span data-slot="wt-alert-text">{current().plan.reason}</span>
            <button
              type="button"
              data-slot="wt-alert-action"
              onClick={() =>
                props.onRelocate?.({ tree: current().tree, occupant: current().plan.move })
              }
            >
              {current().plan.into
                ? `Sposta ${current().plan.move.agentId} in ${current().plan.into?.name}`
                : `Sposta ${current().plan.move.agentId} in un albero nuovo`}
            </button>
          </footer>
        )}
      </Show>
    </section>
  )
}
