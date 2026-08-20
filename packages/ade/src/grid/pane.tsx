import { For, Show } from "solid-js"

/*
 * `provisioning` comes before `working`: the worktree checkout runs for seconds
 * before the process starts, and a card stuck on `waiting` there reads as
 * "needs an answer" — which this session is not asking for.
 */
export type PaneStatus = "provisioning" | "working" | "waiting" | "done" | "error"

/*
 * How faithfully the tree a session runs in matches what the user asked for.
 * Provisioning can degrade without failing, and each degradation changes what
 * the session actually is, so the fidelity is modelled rather than derived:
 *   full    — isolated tree carrying the user's uncommitted work
 *   stale   — isolated tree from the last commit; uncommitted work is absent
 *   no-deps — isolated tree, but dependencies could not be linked
 *   project — no tree at all; the agent edits the project directory itself
 */
export type PaneTreeFidelity = "full" | "stale" | "no-deps" | "project"

/** Where the session is actually running. Absent while provisioning is still deciding. */
export interface PaneTree {
  /** Short branch name, e.g. `ade/agy/s-3f2a`. */
  branch: string
  fidelity: PaneTreeFidelity
  /** The full provisioning note; surfaced through the segment's title. */
  note?: string
}

/*
 * Degradation is status, not error: the words name exactly what is missing and
 * stay Italian like the rest of the chrome. `full` has no word on purpose — the
 * good case is the quiet one, so that across six panes the absence of a mark
 * reads as the all-clear.
 */
const FIDELITY_LABEL: Record<PaneTreeFidelity, string | undefined> = {
  full: undefined,
  stale: "solo l'ultimo commit",
  "no-deps": "senza dipendenze",
  project: "senza isolamento",
}

/** Spoken/inspected form of each fidelity, used when no provisioning note arrives. */
const FIDELITY_TITLE: Record<PaneTreeFidelity, string> = {
  full: "Albero isolato che contiene il lavoro corrente",
  stale: "Albero isolato dall'ultimo commit: le modifiche non salvate non ci sono",
  "no-deps": "Albero isolato senza dipendenze collegate: l'agente può modificare ma non eseguire",
  project: "Nessun albero isolato: l'agente lavora direttamente nel progetto",
}

/* Icons are stroke-based marks on a 16px grid, never emoji: they must survive
   any font the host webview happens to load. */
function BranchGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
    >
      <path d="M4 2v8" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="4" cy="12" r="2" />
      <path d="M12 6a6 6 0 0 1-6 6" />
    </svg>
  )
}

/* A folder stands for the project directory: the one case where the session
   runs without any tree of its own, so it gets a glyph of its own — colour
   alone could not separate it from the milder degradations at a glance. */
function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.7 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export interface TranscriptLine {
  kind: "step" | "shell" | "note"
  text: string
}

/** A per-state affordance: a waiting session asks something, a stopped one offers a retry. */
export interface PaneAction {
  label: string
  tone?: "primary" | "secondary"
  onClick: () => void
}

export interface SessionPaneProps {
  title: string
  status: PaneStatus
  /** What the agent is doing, in the present tense. Empty when it is idle. */
  activity?: string
  elapsed?: string
  tokens?: string
  model?: string
  mode?: string
  lines: TranscriptLine[]
  /** Who is running this session, shown in the footer beside the mode. */
  agent?: string
  /**
   * Where the session actually runs, shown in the footer after the mode.
   * Absent while provisioning is still deciding — the footer holds the slot
   * open so the handover to a real branch never moves the row.
   */
  tree?: PaneTree
  /** Replaces the prompt when the session needs an answer rather than an instruction. */
  actions?: PaneAction[]
  focused?: boolean
  /** Sends a line to whatever the pane is running. Absent when nothing runs. */
  onSubmit?: (line: string) => void
  onClose?: () => void
  onExpand?: () => void
}

/**
 * One agent session, as it appears inside the grid.
 *
 * The pane is deliberately the same shape whatever the session is doing: header,
 * transcript, status, prompt. A grid whose cells rearrange themselves per state
 * cannot be scanned — and scanning is the entire reason several sessions are on
 * screen at once.
 */
export function SessionPane(props: SessionPaneProps) {
  return (
    <article data-component="session-pane" data-status={props.status} data-focused={props.focused ? "true" : undefined}>
      <header data-slot="pane-header">
        <span data-slot="pane-dot" aria-hidden="true" />
        <h2 data-slot="pane-title" title={props.title}>
          {props.title}
        </h2>
        <Show when={props.tokens}>
          <span data-slot="pane-tokens">{props.tokens}</span>
        </Show>
        <div data-slot="pane-actions">
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label="Espandi">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M1 4.5V1h3.5M11 7.5V11H7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label="Chiudi">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="pane-transcript">
        <For each={props.lines}>
          {(line) => (
            <div data-slot="pane-line" data-kind={line.kind}>
              <Show when={line.kind === "step"}>
                <span data-slot="pane-bullet" aria-hidden="true" />
              </Show>
              <Show when={line.kind === "shell"}>
                <span data-slot="pane-elbow" aria-hidden="true">
                  └
                </span>
              </Show>
              <span data-slot="pane-text">{line.text}</span>
            </div>
          )}
        </For>
      </div>

      {/* A session that is asking something needs an answer, not an instruction:
          the buttons take the prompt's place rather than sitting beside it. */}
      <Show
        when={props.actions && props.actions.length > 0}
        fallback={
          <div data-slot="pane-prompt">
            <span data-slot="pane-caret" aria-hidden="true">
              ›
            </span>
            <input
              type="text"
              data-slot="pane-input"
              placeholder={props.onSubmit ? "" : "nessun processo in ascolto"}
              disabled={!props.onSubmit}
              spellcheck={false}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                const field = event.currentTarget
                const line = field.value
                if (line.trim().length === 0) return
                props.onSubmit?.(line)
                field.value = ""
              }}
            />
          </div>
        }
      >
        <div data-slot="pane-answers">
          <For each={props.actions}>
            {(action) => (
              <button
                type="button"
                data-slot="pane-answer"
                data-tone={action.tone ?? "secondary"}
                onClick={() => action.onClick()}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <footer data-slot="pane-footer">
        <span data-slot="pane-who">
          <Show when={props.agent}>{(agent) => <span data-slot="pane-agent">{agent()}</span>}</Show>
          <Show when={props.mode}>
            <span data-slot="pane-mode">{props.mode}</span>
          </Show>
          {/* The tree lives in the footer's identity group, not the transcript:
              a note line scrolls away after three messages, the footer does not.
              While provisioning decides, the same slot holds a placeholder so
              the row's shape — and therefore the grid's — never changes. */}
          <Show
            when={props.tree}
            fallback={
              <Show when={props.status === "provisioning"}>
                <span data-slot="pane-tree" data-fidelity="pending">
                  <BranchGlyph />
                  <span data-slot="pane-tree-branch">preparazione albero…</span>
                </span>
              </Show>
            }
          >
            {(tree) => (
              <span
                data-slot="pane-tree"
                data-fidelity={tree().fidelity}
                title={tree().note ?? FIDELITY_TITLE[tree().fidelity]}
              >
                {tree().fidelity === "project" ? <FolderGlyph /> : <BranchGlyph />}
                <span data-slot="pane-tree-branch">{tree().branch}</span>
                <Show when={FIDELITY_LABEL[tree().fidelity]}>
                  {(label) => <span data-slot="pane-tree-note">{label()}</span>}
                </Show>
              </span>
            )}
          </Show>
        </span>
        <span data-slot="pane-state">
          <Show when={props.activity}>{(activity) => <span>{activity()}</span>}</Show>
          <Show when={props.elapsed}>
            <span data-slot="pane-meta">{props.elapsed}</span>
          </Show>
        </span>
      </footer>
    </article>
  )
}
