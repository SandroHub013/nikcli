import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { DialogHeader, useDialog } from "../../ui/dialog"
import { FooterHint } from "../../ui/footer-hints"
import { Clipboard } from "../../util/clipboard"
import { friendlyErrorMessage } from "../../util/error-message"
import { useScrollAcceleration } from "../../util/scroll"

export type BtwEntry = {
  id: number
  sessionID: string
  question: string
  status: "pending" | "done" | "error"
  startedAt: number
  text?: string
  error?: string
  /** Milliseconds the request took, once it settled. */
  elapsed?: number
  agent?: string
  model?: { providerID: string; modelID: string }
  finish?: string
}

export type BtwActions = {
  entries: (sessionID: string) => BtwEntry[]
  retry: (entry: BtwEntry) => void
  discard: (entry: BtwEntry) => void
  /** Asks a new question; `from` is where the prompt's back arrow returns. */
  ask: (from: BtwEntry) => void
  fork: (entry: BtwEntry) => Promise<void>
}

function seconds(ms: number) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}

/**
 * One side answer at a time, from the session's `/btw` history.
 *
 * Header: title, position in the history, close. Then the question, the
 * answer (scrollable, sized to its content up to half the terminal), a status
 * line saying who answered and how long it took, and the actions that apply
 * to the entry's state. Every action has a key and is clickable.
 */
export function BtwDialog(props: { sessionID: string; entryID: number; actions: BtwActions }) {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = useScrollAcceleration()

  const list = () => props.actions.entries(props.sessionID)
  const [index, setIndex] = createSignal(
    Math.max(
      0,
      list().findIndex((entry) => entry.id === props.entryID),
    ),
  )
  // A discard shortens the list under the cursor; stay on a real entry.
  createEffect(() => {
    const length = list().length
    if (length > 0 && index() > length - 1) setIndex(length - 1)
  })
  const entry = createMemo(() => list()[index()])

  const maxHeight = createMemo(() => Math.max(3, Math.floor(dimensions().height / 2)))
  const [contentHeight, setContentHeight] = createSignal(1)
  const overflows = () => contentHeight() > maxHeight()
  let scrollbox: ScrollBoxRenderable | undefined
  // The ref outlives the answer view when the entry leaves the done state.
  const scroller = () => (entry()?.status === "done" && scrollbox && !scrollbox.isDestroyed ? scrollbox : undefined)

  const [copied, setCopied] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  const [forking, setForking] = createSignal(false)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  // Ticks only while the shown entry is pending, for the elapsed counter.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (entry()?.status !== "pending") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 200)
    onCleanup(() => clearInterval(timer))
  })

  // Moving to another entry starts it from the top with fresh feedback.
  createEffect(
    on(
      () => entry()?.id,
      () => {
        setCopied(false)
        setNotice(undefined)
        scroller()?.scrollTo(0)
      },
      { defer: true },
    ),
  )

  onMount(() => dialog.setSize("large"))
  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer)
  })

  const move = (delta: number) => {
    const next = index() + delta
    if (next < 0 || next >= list().length) return
    setIndex(next)
  }

  const copy = () => {
    const text = entry()?.text
    if (entry()?.status !== "done" || !text) return
    Clipboard.copy(text)
      .then(() => {
        setNotice(undefined)
        setCopied(true)
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => setCopied(false), 2000)
      })
      .catch((error: unknown) => setNotice(friendlyErrorMessage(error, "Could not copy")))
  }

  const retry = () => {
    const current = entry()
    if (!current || current.status === "pending") return
    props.actions.retry(current)
  }

  const discard = () => {
    const current = entry()
    if (current) props.actions.discard(current)
  }

  const ask = () => {
    const current = entry()
    if (current) props.actions.ask(current)
  }

  const fork = () => {
    const current = entry()
    if (!current || current.status !== "done" || forking()) return
    setForking(true)
    void props.actions.fork(current).finally(() => setForking(false))
  }

  useKeyboard((evt) => {
    if (evt.ctrl || evt.meta) return
    const handled = (() => {
      switch (evt.name) {
        case "c":
          copy()
          return true
        case "r":
          retry()
          return true
        case "f":
          fork()
          return true
        case "n":
          ask()
          return true
        case "x":
          discard()
          return true
        case "left":
          move(-1)
          return true
        case "right":
          move(1)
          return true
      }
      const scroll = scroller()
      if (!scroll) return false
      switch (evt.name) {
        case "up":
          scroll.scrollBy(-1)
          return true
        case "down":
          scroll.scrollBy(1)
          return true
        case "pageup":
          scroll.scrollBy(-maxHeight())
          return true
        case "pagedown":
          scroll.scrollBy(maxHeight())
          return true
        case "home":
          scroll.scrollTo(0)
          return true
        case "end":
          scroll.scrollTo(scroll.scrollHeight)
          return true
      }
      return false
    })()
    if (handled) evt.preventDefault()
  })

  const position = () => (list().length > 1 ? `${index() + 1} of ${list().length}` : undefined)

  const status = createMemo(() => {
    const current = entry()
    if (!current) return undefined
    if (current.status === "pending") return `thinking · ${seconds(now() - current.startedAt)}`
    const parts = [current.model?.modelID, current.agent, current.elapsed !== undefined && seconds(current.elapsed)]
    return parts.filter(Boolean).join(" · ")
  })

  type Action = { keys: string; label: string; run?: () => void; tone?: typeof theme.accent.fg }
  // Only what applies to the entry's state is offered.
  const actionList = createMemo((): Action[] => {
    const current = entry()
    if (!current) return []
    const done = current.status === "done"
    const actions: Action[] = []
    if (done)
      actions.push({
        keys: "c",
        label: copied() ? "copied" : "copy",
        tone: copied() ? theme.status.success.fg : undefined,
        run: copy,
      })
    if (done) actions.push({ keys: "f", label: forking() ? "forking…" : "fork", run: fork })
    if (current.status !== "pending") actions.push({ keys: "r", label: "retry", run: retry })
    actions.push({ keys: "n", label: "new", run: ask })
    actions.push({ keys: "x", label: current.status === "pending" ? "cancel" : "discard", run: discard })
    if (list().length > 1) actions.push({ keys: "←/→", label: "history", run: () => move(index() > 0 ? -1 : 1) })
    if (done && overflows()) actions.push({ keys: "↑/↓", label: "scroll" })
    return actions
  })

  return (
    <Show when={entry()}>
      {(current) => (
        <box gap={1} paddingBottom={1}>
          <box paddingLeft={2} paddingRight={2} gap={1}>
            <DialogHeader title="/btw" subtitle={["side question", position()].filter(Boolean).join(" · ")} />
            <box flexDirection="row" gap={1}>
              <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} flexShrink={0}>
                ❯
              </text>
              <text fg={theme.foreground.default} wrapMode="word">
                {current().question}
              </text>
            </box>
          </box>

          <box border={["top"]} borderColor={theme.border.subtle} marginLeft={2} marginRight={2} />

          <Switch>
            <Match when={current().status === "pending"}>
              <box paddingLeft={2} paddingRight={2}>
                <Spinner color={theme.accent.fg}>Thinking…</Spinner>
                <text fg={theme.foreground.muted} wrapMode="word">
                  Closing keeps it running — you'll be told when the answer is ready.
                </text>
              </box>
            </Match>
            <Match when={current().status === "error"}>
              <box paddingLeft={2} paddingRight={2}>
                <text fg={theme.status.error.fg} wrapMode="word">
                  {current().error}
                </text>
              </box>
            </Match>
            <Match when={current().status === "done"}>
              <scrollbox
                ref={(element: ScrollBoxRenderable) => (scrollbox = element)}
                height={Math.min(contentHeight(), maxHeight())}
                scrollX={false}
                verticalScrollbarOptions={{ visible: overflows() }}
                horizontalScrollbarOptions={{ visible: false }}
                scrollAcceleration={scrollAcceleration()}
                paddingLeft={2}
                paddingRight={2}
              >
                <box
                  onSizeChange={function () {
                    setContentHeight(Math.max(1, this.height))
                  }}
                >
                  <markdown
                    syntaxStyle={syntax()}
                    content={current().text ?? ""}
                    fg={theme.foreground.default}
                    tableOptions={{
                      widthMode: "full",
                      wrapMode: "word",
                      cellPadding: 0,
                      borders: true,
                      outerBorder: false,
                      borderColor: theme.border.subtle,
                    }}
                  />
                </box>
              </scrollbox>
            </Match>
          </Switch>

          <box border={["top"]} borderColor={theme.border.subtle} marginLeft={2} marginRight={2} />

          <box paddingLeft={2} paddingRight={2} gap={1}>
            <box flexDirection="row" justifyContent="space-between" gap={2}>
              <box flexDirection="row" gap={1}>
                <text
                  fg={
                    current().status === "error"
                      ? theme.status.error.fg
                      : current().status === "done"
                        ? theme.status.success.fg
                        : theme.accent.fg
                  }
                  flexShrink={0}
                >
                  {current().status === "error" ? "✗" : current().status === "done" ? "✓" : "◌"}
                </text>
                <text fg={theme.foreground.muted} wrapMode="none">
                  {status()}
                </text>
                <Show when={current().finish === "length"}>
                  <text fg={theme.status.warning.fg} wrapMode="none">
                    · cut off at the output limit
                  </text>
                </Show>
              </box>
              <text fg={theme.foreground.muted} wrapMode="none" flexShrink={0}>
                not in the conversation
              </text>
            </box>
            <Show when={notice()}>
              <text fg={theme.status.error.fg} wrapMode="word">
                {notice()}
              </text>
            </Show>
            <box flexDirection="row" gap={1} alignItems="baseline" flexWrap="wrap">
              <For each={actionList()}>
                {(action, i) => (
                  <>
                    <box onMouseUp={() => action.run?.()}>
                      <FooterHint keys={action.keys} label={action.label} tone={action.tone} />
                    </box>
                    <Show when={i() < actionList().length - 1}>
                      <text fg={theme.border.subtle} wrapMode="none">
                        ·
                      </text>
                    </Show>
                  </>
                )}
              </For>
            </box>
          </box>
        </box>
      )}
    </Show>
  )
}
