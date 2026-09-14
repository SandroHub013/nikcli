import type { Ghostty, Terminal as Term, FitAddon } from "ghostty-web"
import { ComponentProps, createEffect, createSignal, onCleanup, onMount, splitProps } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { monoFontFamily, useSettings } from "@/context/settings"
import { parseKeybind, matchKeybind } from "@/context/command"
import { SerializeAddon } from "@/addons/serialize"
import { LocalPTY } from "@/context/terminal"
import { resolveThemeVariant, useTheme, withAlpha, type HexColor } from "@nikcli-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { showToast } from "@nikcli-ai/ui/toast"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"

/**
 * How much scrollback `text()` reads.
 *
 * Generous next to the ~60 lines the caller keeps, so wrapped rows and trailing
 * blanks cannot starve it, and still a two-hundredth of the default buffer.
 */
const TERMINAL_READ_ROWS = 400

/** See the comment at the custom key handler below before adding to this. */
const PASS_THROUGH_COMMANDS: ReadonlyArray<{ id: string; fallback: string }> = [
  { id: TOGGLE_TERMINAL_ID, fallback: DEFAULT_TOGGLE_TERMINAL_KEYBIND },
  { id: "terminal.sendToChat", fallback: "mod+shift+u" },
]
/** Reading the live terminal, for callers that want to hand its output on. */
export type TerminalReader = {
  /** What the user has highlighted, or nothing. */
  selection: () => string
  /** The scrollback as text, newest last. */
  text: () => string
}

export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  onSubmit?: () => void
  onCleanup?: (pty: LocalPTY) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
  /**
   * Handed a reader once the terminal is live, and `undefined` when it goes
   * away. The buffer was only ever read on unmount, so nothing outside could
   * see what the user was looking at while they were looking at it.
   */
  onReader?: (reader: TerminalReader | undefined) => void
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "onConnect",
    "onConnectError",
    "onReader",
  ])
  let ws: WebSocket | undefined
  let term: Term | undefined
  let ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let handleTextareaFocus: () => void
  let handleTextareaBlur: () => void
  let disposed = false
  const cleanups: VoidFunction[] = []
  let tail = local.pty.tail ?? ""

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode()
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const [terminalColors, setTerminalColors] = createSignal<TerminalColors>(getTerminalColors())

  createEffect(() => {
    const colors = getTerminalColors()
    setTerminalColors(colors)
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
  })

  createEffect(() => {
    const font = monoFontFamily(settings.appearance.font())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const once = { value: false }

      const url = new URL(sdk.url + `/pty/${local.pty.id}/connect?directory=${encodeURIComponent(sdk.directory)}`)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      if (window.__NIKCLI__?.serverPassword) {
        url.username = "nikcli"
        url.password = window.__NIKCLI__?.serverPassword
      }
      const socket = new WebSocket(url)
      cleanups.push(() => {
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close()
      })
      if (disposed) {
        cleanup()
        return
      }
      ws = socket

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily: monoFontFamily(settings.appearance.font()),
        allowTransparency: true,
        convertEol: true,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      ghostty = g
      term = t

      const copy = () => {
        const selection = t.getSelection()
        if (!selection) return false

        const body = document.body
        if (body) {
          const textarea = document.createElement("textarea")
          textarea.value = selection
          textarea.setAttribute("readonly", "")
          textarea.style.position = "fixed"
          textarea.style.opacity = "0"
          body.appendChild(textarea)
          textarea.select()
          const copied = document.execCommand("copy")
          body.removeChild(textarea)
          if (copied) return true
        }

        const clipboard = navigator.clipboard
        if (clipboard?.writeText) {
          clipboard.writeText(selection).catch(() => {})
          return true
        }

        return false
      }

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          copy()
          return true
        }

        if (event.metaKey && !event.ctrlKey && !event.altKey && key === "c") {
          if (!t.hasSelection()) return true
          copy()
          return true
        }

        // Chords the app keeps for itself while the terminal has focus.
        //
        // Returning false hands the event to ghostty, which encodes it, sends it
        // to the PTY and calls `stopPropagation()` — so the command keymap on
        // `document` never sees it. A shortcut that is not listed here is not
        // merely inert while the terminal is focused: it is typed into the shell.
        // Everything else stays with the terminal on purpose, because Ctrl+C,
        // Ctrl+U and Ctrl+L belong to whatever is running in it.
        return PASS_THROUGH_COMMANDS.some((entry) =>
          matchKeybind(parseKeybind(settings.keybinds.get(entry.id) ?? entry.fallback), event),
        )
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      local.onReader?.({
        selection: () => t.getSelection() ?? "",
        // `serialize` keeps the escape sequences that paint the terminal; they
        // are noise to a reader, so the buffer is walked line by line instead.
        text: () => {
          const buffer = t.buffer.active
          const lines: string[] = []
          // `buffer.length` is the whole scrollback — 10 000 rows by default —
          // and every row costs a wasm crossing plus one allocation per cell,
          // while the caller keeps the last few dozen. Read the tail, with room
          // to spare for the caller's own trimming, and hoist the length out of
          // the loop condition so it is not re-evaluated per row.
          const total = buffer.length
          const first = Math.max(0, total - TERMINAL_READ_ROWS)
          for (let row = first; row < total; row++) {
            const line = buffer.getLine(row)
            const text = line?.translateToString(true) ?? ""
            // A line longer than the terminal is wide occupies several rows, and
            // each row after the first is marked as a continuation. Joining them
            // back means one stack trace counts as one line rather than five —
            // the caller keeps a line budget, and a wrapped row would eat it.
            if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text
            else lines.push(text)
          }
          // Blank rows below the prompt are padding, not content.
          while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
          return lines.join("\n")
        },
      })
      cleanups.push(() => local.onReader?.(undefined))

      t.open(container)

      container.addEventListener("pointerdown", handlePointerDown)
      cleanups.push(() => container.removeEventListener("pointerdown", handlePointerDown))

      container.addEventListener("click", handleLinkClick, { capture: true })
      cleanups.push(() => container.removeEventListener("click", handleLinkClick, { capture: true }))

      handleTextareaFocus = () => {
        t.options.cursorBlink = true
      }
      handleTextareaBlur = () => {
        t.options.cursorBlink = false
      }

      t.textarea?.addEventListener("focus", handleTextareaFocus)
      t.textarea?.addEventListener("blur", handleTextareaBlur)
      cleanups.push(() => t.textarea?.removeEventListener("focus", handleTextareaFocus))
      cleanups.push(() => t.textarea?.removeEventListener("blur", handleTextareaBlur))

      focusTerminal()

      fit.fit()

      if (local.pty.buffer) {
        t.write(local.pty.buffer, () => {
          if (local.pty.scrollY) t.scrollToLine(local.pty.scrollY)
        })
      }

      fit.observeResize()
      handleResize = () => fit.fit()
      window.addEventListener("resize", handleResize)
      cleanups.push(() => window.removeEventListener("resize", handleResize))
      const limit = 16_384
      const min = 32
      const windowMs = 750
      const seed = tail.length > limit ? tail.slice(-limit) : tail
      let sync = seed.length >= min
      let syncUntil = 0
      const stopSync = () => {
        sync = false
        syncUntil = 0
      }

      const overlap = (data: string) => {
        if (!seed) return 0
        const max = Math.min(seed.length, data.length)
        if (max < min) return 0
        for (let i = max; i >= min; i--) {
          if (seed.slice(-i) === data.slice(0, i)) return i
        }
        return 0
      }

      const onResize = t.onResize(async (size) => {
        if (socket.readyState === WebSocket.OPEN) {
          await sdk.client.pty
            .update({
              ptyID: local.pty.id,
              size: {
                cols: size.cols,
                rows: size.rows,
              },
            })
            .catch(() => {})
        }
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (data) stopSync()
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data)
        }
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))
      // t.onScroll((ydisp) => {
      // console.log("Scroll position:", ydisp)
      // })

      const handleOpen = () => {
        local.onConnect?.()
        if (sync) syncUntil = Date.now() + windowMs
        sdk.client.pty
          .update({
            ptyID: local.pty.id,
            size: {
              cols: t.cols,
              rows: t.rows,
            },
          })
          .catch(() => {})
      }
      socket.addEventListener("open", handleOpen)
      cleanups.push(() => socket.removeEventListener("open", handleOpen))

      const handleMessage = (event: MessageEvent) => {
        if (disposed) return
        const data = typeof event.data === "string" ? event.data : ""
        if (!data) return

        const next = (() => {
          if (!sync) return data
          if (syncUntil && Date.now() > syncUntil) {
            stopSync()
            return data
          }
          const n = overlap(data)
          if (!n) {
            stopSync()
            return data
          }
          const trimmed = data.slice(n)
          if (trimmed) stopSync()
          return trimmed
        })()

        if (!next) return

        t.write(next)
        tail = next.length >= limit ? next.slice(-limit) : (tail + next).slice(-limit)
      }
      socket.addEventListener("message", handleMessage)
      cleanups.push(() => socket.removeEventListener("message", handleMessage))

      const handleError = (error: Event) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        console.error("WebSocket error:", error)
        local.onConnectError?.(error)
      }
      socket.addEventListener("error", handleError)
      cleanups.push(() => socket.removeEventListener("error", handleError))

      const handleClose = (event: CloseEvent) => {
        if (disposed) return
        // Normal closure (code 1000) means PTY process exited - server event handles cleanup
        // For other codes (network issues, server restart), trigger error handler
        if (event.code !== 1000) {
          if (once.value) return
          once.value = true
          local.onConnectError?.(new Error(`WebSocket closed abnormally: ${event.code}`))
        }
      }
      socket.addEventListener("close", handleClose)
      cleanups.push(() => socket.removeEventListener("close", handleClose))
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    disposed = true
    const t = term
    if (serializeAddon && props.onCleanup && t) {
      const buffer = (() => {
        try {
          return serializeAddon.serialize()
        } catch {
          return ""
        }
      })()
      props.onCleanup({
        ...local.pty,
        buffer,
        tail,
        rows: t.rows,
        cols: t.cols,
        scrollY: t.getViewportY(),
      })
    }

    cleanup()
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...(local.classList ?? {}),
        "select-text": true,
        "size-full px-6 py-3 font-mono": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
