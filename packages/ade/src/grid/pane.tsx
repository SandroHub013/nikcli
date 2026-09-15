import { For, Show, Switch, Match, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { parseAnsi, type Span } from "../session/stream"
import { dragCarriesPaths, readDraggedPaths } from "../sidebar/file-drag"
import { focusPane, holdsFocus } from "./focus-input"
import { RENAME_EVENT, commitRename } from "./rename"
import { attachTerminal } from "../terminal/registry"
import { getProviderQuota, type SessionQuotaView } from "../session/quota"

/** The screenshot tray's own drag type. See the drop handler for why. */
const SHOT_MIME = "application/x-ade-shot"
import "@xterm/xterm/css/xterm.css"
import "./pane.css"

export {
  type PaneStatus,
  type PaneState,
  STATE_FULL,
  STATE_SHORT,
  resolvePaneState,
} from "./pane-state"

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
  /** Commit the checkout started from; what the review diffs against. */
  base?: string
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
  /*
   * Quiet too: sessions run in the project on purpose now (see `startProcess`),
   * so marking every pane as a failure was an alarm with nothing to act on.
   * The folder glyph and the title still say where the agent is.
   */
  project: undefined,
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

/*
 * `diff` and `error` were added when the transcript stopped being a list of
 * strings the shell wrote by hand and became the classified output of a real
 * process. They are optional for callers: a line that arrives unclassified
 * still renders, it simply gets no special treatment.
 */
export interface TranscriptLine {
  kind: "step" | "shell" | "note" | "diff" | "error"
  text: string
  /** Consecutive identical lines collapse into one; this is how many. */
  repeat?: number
}

/** A per-state affordance: a waiting session asks something, a stopped one offers a retry. */
export interface PaneAction {
  label: string
  tone?: "primary" | "secondary"
  /** Key that triggers the action, shown as a hint. Purely informative here. */
  hint?: string
  onClick: () => void
}

export interface SessionPaneProps {
  title: string
  status: PaneStatus
  /** Specific 6-state status for S8 dense header. When omitted, derived from status and activity. */
  state?: PaneState
  /** Detailed reason or tool description (e.g. "Edit · pane.css", "Vuole eseguire Bash", "finestra 5h esaurita"). */
  stateDetail?: string
  /** Live quota view for the session's provider. When omitted, derived from agent / quota module. */
  quota?: SessionQuotaView
  /** What the agent is doing, in the present tense. Empty when it is idle. */
  activity?: string
  elapsed?: string
  tokens?: string
  /** Spend so far, already formatted. Shown only when the agent reports one. */
  cost?: string
  model?: string
  mode?: string
  /**
   * The pane's own id, stamped on the element as `data-pane-id`.
   *
   * The composer is uncontrolled — it owns its textarea and clears it itself —
   * so voice dictation reaches it through the DOM. Without an id on the element
   * that lookup has to count panes by position, which silently targets the
   * wrong session the moment one is closed.
   */
  id?: string
  lines: TranscriptLine[]
  /** Who is running this session, shown in the footer beside the mode. */
  agent?: string
  /**
   * The agent's mark, so identity survives at small sizes.
   *
   * A node rather than a character: with six panes open the header glyph is
   * the fastest way to tell which agent is which, and six geometric
   * stand-ins are six things that look alike. The caller passes the drawn
   * mark (`session-new/agent-mark.tsx`); a plain string still works for
   * anything that has no mark of its own.
   */
  glyph?: JSX.Element
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
  onFocus?: () => void
  /**
   * Stores a new title. Absent when the name is not the user's to change,
   * in which case the header offers no way to edit it.
   */
  onRename?: (title: string) => void
  /**
   * The terminal to draw in this pane, when it has one.
   *
   * Absent for a pane whose process never started, or one restored from a
   * previous run: there is nothing live to attach to, and the line transcript
   * that was saved with the session is the honest thing to show instead.
   */
  terminalId?: string
  /** Keystrokes from the terminal, on their way to the process. */
  onInput?: (data: string) => void
  /**
   * Files were dropped on this session: from the project tree, from the
   * screenshot tray, or from the system's own file manager.
   *
   * Paths only, and only when something is listening: dropping a file on a
   * pane whose process has ended would otherwise look like it worked and
   * reach nobody.
   *
   * Plural because a multi-file drop is one gesture, and delivering the
   * first path and discarding the rest is the sort of half-success that
   * takes longer to notice than a refusal.
   */
  onDropPath?: (paths: string[]) => void
  /** The terminal's size in cells, whenever the pane changes shape. */
  onResize?: (cols: number, rows: number) => void
}

/*
 * Terminal colours map to the shell's own palette rather than to sRGB primaries.
 * An agent that prints red on a warm dark ground should look like it belongs in
 * this window, not like a screenshot of a different terminal pasted inside it.
 */
function colorVar(color: Span["color"]): string | undefined {
  if (!color) return undefined
  return `var(--ade-ansi-${color})`
}

/** One transcript line, with the agent's own colours preserved. */
function LineSpans(props: { text: string }) {
  const spans = createMemo(() => parseAnsi(props.text))
  return (
    <For each={spans()}>
      {(span) => (
        <span
          style={{
            color: colorVar(span.color),
            "font-weight": span.bold ? "var(--ade-weight-semibold)" : undefined,
          }}
        >
          {span.text}
        </span>
      )}
    </For>
  )
}

/** Vector icon for each of the 6 states, stroke-based on a 16px grid. */
export function StateIcon(props: { state: PaneState }) {
  return (
    <svg class={`ic ic-${props.state}`} viewBox="0 0 16 16" aria-hidden="true">
      <Switch>
        <Match when={props.state === "work"}>
          <circle cx="8" cy="8" r="5.5" opacity=".28" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
        </Match>
        <Match when={props.state === "perm"}>
          <path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.5-5.2 6.6-3-1.1-5.2-3.5-5.2-6.6V3.9z" />
          <path d="M6.5 6.4a1.6 1.6 0 1 1 2.3 1.4c-.5.3-.8.6-.8 1.1" />
          <circle class="f" cx="8" cy="10.9" r=".85" />
        </Match>
        <Match when={props.state === "ask"}>
          <path d="M2.5 3.2h11v7.3H8.2L5 13v-2.5H2.5z" />
          <circle class="f d1" cx="5.5" cy="6.85" r=".9" />
          <circle class="f d2" cx="8" cy="6.85" r=".9" />
          <circle class="f d3" cx="10.5" cy="6.85" r=".9" />
        </Match>
        <Match when={props.state === "err"}>
          <path d="M5.6 1.8h4.8l3.8 3.8v4.8l-3.8 3.8H5.6l-3.8-3.8V5.6z" />
          <path d="M8 4.9v3.6" />
          <circle class="f" cx="8" cy="11" r=".85" />
        </Match>
        <Match when={props.state === "limit"}>
          <path d="M4 1.8h8M4 14.2h8" />
          <path d="M5 1.8c0 3.2 3 3.9 3 6.2s-3 3-3 6.2M11 1.8c0 3.2-3 3.9-3 6.2s3 3 3 6.2" />
          <path class="f" d="M6.3 13.3 8 11.7l1.7 1.6z" />
        </Match>
        <Match when={props.state === "idle"}>
          <path d="M3.5 4.8 6.7 8l-3.2 3.2" />
          <path d="M8.8 11.4h4" />
        </Match>
      </Switch>
    </svg>
  )
}


/**
 * One agent session, as it appears inside the grid.
 *
 * Proposal A dense header: session title, agent mark, status chip with real tool activity,
 * quota horizon indicator with live countdown/percentage, branch, tokens and window actions.
 */
export function SessionPane(props: SessionPaneProps) {
  let scroller: HTMLDivElement | undefined
  let field: HTMLTextAreaElement | undefined
  let root: HTMLElement | undefined

  /*
   * Following means: new output pulls the view down. It stops the moment the
   * user scrolls up, because reading three screens back while a build streams
   * is impossible if the pane keeps yanking itself to the bottom — and it
   * resumes as soon as they return, so the common case needs no interaction.
   */
  const [following, setFollowing] = createSignal(true)

  const atBottom = (element: HTMLDivElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 24

  const toBottom = () => {
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
    setFollowing(true)
  }

  createEffect(() => {
    // Reading the length is what subscribes this effect to new output.
    props.lines.length
    if (!scroller || !following()) return
    // The DOM node for the line just added does not exist until after this
    // effect's synchronous body would run, so the scroll waits one frame.
    const frame = requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const [dropping, setDropping] = createSignal(false)
  let dragDepth = 0

  /*
   * Whether the pane needs a row under the terminal at all.
   *
   * Answers first: a permission question is a set of exact strings the agent
   * is waiting for, and pressing one is not the same as typing it blind into a
   * redrawing menu. Otherwise the composer earns its row only when there is no
   * emulator to type into — with one attached it wrote to the very same pty,
   * so it was costing every pane a row of terminal to duplicate the keyboard.
   */
  const showDock = () => (props.actions?.length ?? 0) > 0 || !props.terminalId

  /* A textarea that grows with its content, bounded so one long paste cannot
     swallow the transcript it belongs to. */
  const grow = () => {
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${Math.min(field.scrollHeight, 120)}px`
  }

  const send = () => {
    if (!field) return
    const line = field.value
    if (line.trim().length === 0) return
    props.onSubmit?.(line)
    field.value = ""
    grow()
  }

  /*
   * Focus follows the highlight, instead of only looking like it does.
   *
   * Alt+Arrow updates `focusedId`, which moves the border — and nothing moved
   * the DOM focus, so the keys kept arriving at the pane the user had just
   * navigated away from. Typing went to the previous terminal while the
   * highlight sat on the next one, which is the most confusing shape this can
   * take: the interface says one thing and the keyboard does another.
   *
   * The terminal first when there is one, because that is what a session pane
   * is for; otherwise the composer.
   */
  createEffect(() => {
    if (!props.focused || !root) return
    // Already inside this pane — a click, or the focus arriving on its own.
    if (holdsFocus(root, document.activeElement)) return
    focusPane(root)
  })

  /*
   * The title, edited where it is read.
   *
   * A double click on the name swaps it for a field with the same text; Enter
   * or leaving the field keeps what was typed, Escape drops it. The
   * `pane.rename` command arrives as an event on the root, so the palette and
   * its key reach the same field without the workbench holding editing state
   * for every pane.
   *
   * Focus is moved by hand rather than with `autofocus`: the field is born
   * after the page loaded, and the caret must land at the end with the whole
   * name selected, since replacing it is the common edit.
   */
  const [editing, setEditing] = createSignal(false)
  let titleField: HTMLInputElement | undefined

  const beginRename = () => {
    if (!props.onRename || editing()) return
    setEditing(true)
    queueMicrotask(() => {
      titleField?.focus({ preventScroll: true })
      titleField?.select()
    })
  }

  /*
   * `refocus` only from the keyboard. Enter and Escape leave the caret on a
   * field that is about to vanish, so it goes back to the terminal; a blur
   * means the user clicked somewhere else, and taking the caret back from
   * there would undo the click.
   */
  const endRename = (keep: boolean, refocus = false) => {
    if (!editing()) return
    const raw = titleField?.value ?? ""
    setEditing(false)
    if (keep) {
      const next = commitRename(raw, props.title)
      if (next !== undefined) props.onRename?.(next)
    }
    if (refocus) focusPane(root)
  }

  const quota = createMemo<SessionQuotaView | undefined>(() => {
    if (props.quota) return props.quota
    return getProviderQuota(props.agent ?? props.model)
  })

  const state = createMemo<PaneState>(() =>
    resolvePaneState({
      status: props.status,
      state: props.state,
      activity: props.activity,
      quota: quota(),
      hasActions: Boolean(props.actions && props.actions.length > 0),
    }),
  )

  const stateHead = createMemo(() => {
    if (props.stateDetail) return props.stateDetail
    if (props.activity) return props.activity
    const st = state()
    if (st === "limit") return quota()?.countdown ? `finestra ${quota()?.bindingKey} esaurita` : "limite raggiunto"
    if (st === "work") return props.mode ?? "In esecuzione"
    if (st === "perm") return props.actions?.[0]?.label ?? "Permesso"
    if (st === "err") return "Bloccata"
    return STATE_FULL[st]
  })

  const stateDetail = createMemo(() => {
    return props.stateDetail ?? props.activity ?? STATE_FULL[state()]
  })

  const tipAll = createMemo(() => {
    const q = quota()
    const quotaLines = q ? `\n${q.tooltip}` : ""
    const branchLine = props.tree ? `\nBranch ${props.tree.branch}` : ""
    const tokLine = props.tokens ? `\n${props.tokens}` : ""
    return `${props.title}\n${props.agent ?? props.model ?? "Sessione"} · ${STATE_FULL[state()]}\n${stateDetail()}${quotaLines}${branchLine}${tokLine}`
  })

  const tipState = createMemo(() => {
    const elText = props.elapsed ? ` · da ${props.elapsed}` : ""
    return `${STATE_FULL[state()]}\n${stateDetail()}${elText}`
  })

  return (
    <article
      ref={(element) => {
        root = element
        // The listener lives and dies with the element, so nothing to clean up.
        element.addEventListener(RENAME_EVENT, beginRename)
      }}
      data-component="session-pane"
      data-pane-id={props.id}
      data-status={props.status}
      data-st={state()}
      data-focused={props.focused ? "true" : undefined}
      data-dropping={dropping() ? "true" : undefined}
      onPointerDown={() => props.onFocus?.()}
      onFocusIn={() => props.onFocus?.()}
      onDragEnter={(event) => {
        if (!props.onDropPath) return
        const dt = event.dataTransfer
        if (dt) {
          const types = Array.from(dt.types ?? [])
          if (!dragCarriesPaths(dt) && !types.includes(SHOT_MIME)) return
        }
        event.preventDefault()
        dragDepth++
        setDropping(true)
      }}
      onDragOver={(event) => {
        if (!props.onDropPath) return
        const dt = event.dataTransfer
        if (dt) {
          const types = Array.from(dt.types ?? [])
          if (!dragCarriesPaths(dt) && !types.includes(SHOT_MIME)) return
          dt.dropEffect = "copy"
        }
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        dragDepth = Math.max(0, dragDepth - 1)
        if (dragDepth === 0) {
          setDropping(false)
        }
      }}
      onDrop={(event) => {
        dragDepth = 0
        setDropping(false)
        if (!props.onDropPath || !event.dataTransfer) return
        event.preventDefault()

        /*
         * A screenshot first, then anything the file tree or the system file
         * manager put in the drag.
         *
         * The tray's own type is checked on its own because a screenshot is
         * identified by a path ADE wrote and no project owns, so it must not
         * be made relative to the project like a source file is.
         */
        const shot = event.dataTransfer.getData(SHOT_MIME)
        const paths = shot ? [shot] : readDraggedPaths(event.dataTransfer)
        if (paths.length === 0) return

        props.onDropPath(paths)

        /*
         * The caret comes with the file. Explicitly, and not via the effect
         * above.
         *
         * A drag leaves the focus on whatever was dragged — the screenshot in
         * the tray — so after the drop the keyboard is still pointed at the
         * tray and the next thing typed goes nowhere. The `focused` effect
         * cannot fix it: dropping onto the pane you are already working in
         * does not change `focusedId`, so the effect has no reason to re-run,
         * and that is the common case.
         *
         * After the caller, because it writes the path into the terminal, and
         * the caret belongs at the end of what it wrote.
         */
        props.onFocus?.()
        focusPane(root)
      }}
    >
      <header class="pill hA" data-slot="pane-header">
        <span class="logo" data-slot="pane-identity" title={props.agent}>
          {props.glyph ?? (
            <span data-slot="pane-glyph" aria-hidden="true">
              •
            </span>
          )}
        </span>
        <Show
          when={editing()}
          fallback={
            <span
              class="nm"
              data-slot="pane-title"
              data-renamable={props.onRename ? "true" : undefined}
              title={props.onRename ? `${tipAll()}\nDoppio clic per rinominare` : tipAll()}
              data-tip={props.onRename ? `${tipAll()}\nDoppio clic per rinominare` : tipAll()}
              onDblClick={beginRename}
              tabIndex={0}
            >
              {props.title}
            </span>
          }
        >
          <input
            ref={titleField}
            type="text"
            data-slot="pane-title-input"
            aria-label="Nome della sessione"
            value={props.title}
            spellcheck={false}
            onKeyDown={(event) => {
              // Not the pane's key, and not the workbench's: Enter here is a
              // commit, not a turn, and Escape is a cancel, not a palette key.
              event.stopPropagation()
              if (event.key === "Enter") {
                event.preventDefault()
                endRename(true, true)
              } else if (event.key === "Escape") {
                event.preventDefault()
                endRename(false, true)
              }
            }}
            onBlur={() => endRename(true)}
          />
        </Show>

        <button
          type="button"
          class="chip a-state"
          title={tipState()}
          data-tip={tipState()}
          aria-label={`${STATE_FULL[state()]}: ${stateDetail()}`}
        >
          <StateIcon state={state()} />
          <span class="lbl">{STATE_SHORT[state()]}</span>
          <span class="a-det trunc">{stateHead()}</span>
          <Show when={props.elapsed}>
            <span class="a-el mono">{props.elapsed}</span>
          </Show>
        </button>

        <span class="sp"></span>

        <Show when={quota()}>
          {(q) => (
            <span
              class="a-q"
              data-lv={q().level}
              data-urg={state() === "limit" || q().isLimit ? "" : undefined}
              tabIndex={0}
              title={q().tooltip}
              data-tip={q().tooltip}
            >
              <span class="qbar" style={{ "--r": q().remainingRatio }}>
                <i></i>
              </span>
              <span class="qk">{q().bindingKey}</span>
              <b class="qv">{q().displayValue}</b>
              <Show when={q().countdown}>
                {(cd) => <span class="qr">↻ {cd()}</span>}
              </Show>
            </span>
          )}
        </Show>

        <Show when={props.tree}>
          {(tree) => (
            <span
              class="a-br"
              tabIndex={0}
              title={`Branch ${tree().branch}${tree().note ? `\n${tree().note}` : ""}`}
              data-tip={`Branch ${tree().branch}${tree().note ? `\n${tree().note}` : ""}`}
            >
              <BranchGlyph />
              <span class="a-brt trunc">{tree().branch}</span>
            </span>
          )}
        </Show>

        <Show when={props.tokens}>
          <span class="tok">{props.tokens}</span>
        </Show>

        <span class="acts" data-slot="pane-actions">
          <button type="button" class="act" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label="Ingrandisci" title="Ingrandisci">
            <svg class="gi" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" class="act" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label="Chiudi" title="Chiudi">
            <svg class="gi" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </span>
        <button
          type="button"
          class="act more"
          aria-label="Azioni: ingrandisci, chiudi"
          title="Azioni&#10;Ingrandisci · Chiudi"
          data-tip="Azioni&#10;Ingrandisci · Chiudi"
          onClick={() => props.onExpand?.()}
        >
          <svg class="gi" viewBox="0 0 16 16" aria-hidden="true">
            <circle class="f" cx="3.5" cy="8" r="1.2" />
            <circle class="f" cx="8" cy="8" r="1.2" />
            <circle class="f" cx="12.5" cy="8" r="1.2" />
          </svg>
        </button>
      </header>

      {/* The liveness sweep used to be a 2px lane of its own here. It is now
          the pane's own top edge, keyed off `data-status`, which says the same
          thing without taking a row — see `pane.css`. */}

      {/*
        The live session, drawn by a real terminal emulator.

        An agent CLI does not print lines, it paints a screen: it moves the
        cursor, rewrites what it already wrote, opens an alternate buffer for a
        menu. Rendering that as a list of strings shows the user the machinery
        instead of the program. The emulator lives in the registry, not here, so
        scrollback survives collapsing, expanding and re-tiling the pane.
      */}
      <Show when={props.terminalId}>
        <div
          data-slot="pane-terminal"
          ref={(element) => {
            const id = props.terminalId
            if (!id) return
            const detach = attachTerminal(id, element, {
              onInput: (data) => props.onInput?.(data),
              onResize: (cols, rows) => props.onResize?.(cols, rows),
            })
            onCleanup(detach)
          }}
        />
      </Show>

      <div
        data-slot="pane-transcript"
        data-hidden={props.terminalId ? "true" : undefined}
        ref={(element) => (scroller = element)}
        onScroll={(event) => setFollowing(atBottom(event.currentTarget))}
      >
        {/* The inner column pushes short output to the bottom, the way a
            terminal does: the newest line is always next to the prompt, so a
            three-line session does not float in a field of empty card. */}
        <div data-slot="pane-lines">
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
                <span data-slot="pane-text">
                  <LineSpans text={line.text} />
                </span>
                <Show when={line.repeat && line.repeat > 1}>
                  <span data-slot="pane-repeat" title={`Ripetuta ${line.repeat} volte`}>
                    ×{line.repeat}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>

        <Show when={!following()}>
          <button type="button" data-slot="pane-tail" onClick={toBottom}>
            torna in fondo
          </button>
        </Show>
      </div>

      {/*
        The dock appears only when a terminal cannot do the job itself.

        A live emulator already takes typing and sends it to the same pty the
        composer wrote to, so under a running session the composer was a second
        keyboard for the same machine — charged in terminal rows, once per pane,
        in a window built to hold six. It is still the only way to talk to a
        pane that has no terminal, and the answer buttons are still the only way
        to answer a permission question, so those two cases keep the row.
      */}
      <Show when={showDock()}>
        <div data-slot="pane-dock">
          {/* A session that is asking something needs an answer, not an
              instruction: the buttons take the prompt's place. */}
          <Show
            when={props.actions && props.actions.length > 0}
            fallback={
              <div data-slot="pane-prompt" data-disabled={props.onSubmit ? undefined : "true"}>
                <span data-slot="pane-caret" aria-hidden="true">
                  ›
                </span>
                <textarea
                  ref={(element) => (field = element)}
                  rows={1}
                  data-slot="pane-input"
                  placeholder={props.onSubmit ? "Scrivi all'agente…" : "nessun processo in ascolto"}
                  disabled={!props.onSubmit}
                  spellcheck={false}
                  onInput={grow}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return
                    event.preventDefault()
                    send()
                  }}
                />
                <Show when={props.onSubmit}>
                  <span data-slot="pane-send-hint" aria-hidden="true">
                    ⏎
                  </span>
                </Show>
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
                    <Show when={action.hint}>
                      <span data-slot="pane-answer-hint" aria-hidden="true">
                        {action.hint}
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </article>
  )
}
