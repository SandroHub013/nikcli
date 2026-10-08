#!/usr/bin/env bun
import { createSignal, onCleanup, onMount, createEffect } from "solid-js"
import { render, useTerminalDimensions, useRenderer, useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { theme } from "./theme"
import { clamp } from "./types"
import { loadRaguIntel, type IntelSection } from "./ragu-intel"
import { RaguSuiteDashboardView } from "./components/RaguSuiteDashboardView"

function RaguSuiteApp() {
  const dim = useTerminalDimensions()
  const renderer = useRenderer()
  const [snapshot, setSnapshot] = createSignal(loadRaguIntel())
  const [section, setSection] = createSignal<IntelSection>("overview")
  const [scrollOff, setScrollOff] = createSignal(0)
  const [rowIdx, setRowIdx] = createSignal(0)

  const pageHeight = () => Math.max(4, dim().height - 12)

  const rescan = () => {
    setSnapshot(loadRaguIntel())
    setScrollOff(0)
    setRowIdx(0)
  }

  onMount(() => {
    try {
      renderer.setBackgroundColor?.(theme.bg)
    } catch {}
    try {
      renderer.setTerminalTitle?.("ragu suite dashboard")
    } catch {}
  })

  createEffect(() => {
    try {
      renderer.setTerminalTitle?.(`ragu suite · ${section()} · ${snapshot().packageCount} pkgs`)
    } catch {}
  })

  onCleanup(() => {
    process.stdout.write("\x1b[?25h\x1b[0m")
  })

  useKeyboard((evt) => {
    if (evt.name === "q" || (evt.name === "c" && evt.ctrl)) {
      evt.preventDefault()
      renderer.destroy?.()
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      rescan()
      return
    }
    const num = Number(evt.name)
    if (num >= 1 && num <= 6) {
      evt.preventDefault()
      const keys: IntelSection[] = ["overview", "packages", "flows", "structure", "architecture", "agents"]
      setSection(keys[num - 1]!)
      setScrollOff(0)
      setRowIdx(0)
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      setRowIdx((i) => Math.max(0, i - 1))
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      setRowIdx((i) => i + 1)
      return
    }
  })

  return (
    <box
      width={dim().width}
      height={dim().height}
      backgroundColor={theme.bg}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexDirection="row" gap={1} marginBottom={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          RAGU SUITE
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          v{snapshot().rootVersion}
        </text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">
          {dim().width}x{dim().height}
        </text>
      </box>
      <RaguSuiteDashboardView
        snapshot={snapshot()}
        section={section()}
        scrollOff={scrollOff()}
        pageHeight={pageHeight()}
        rowIdx={rowIdx()}
        terminalWidth={dim().width}
        onSelectRow={setRowIdx}
        onScroll={(d) => setScrollOff((o) => clamp(o + d, 0, 9999))}
        onSection={(s) => {
          setSection(s)
          setScrollOff(0)
          setRowIdx(0)
        }}
      />
    </box>
  )
}

export async function runRaguSuiteDashboard(): Promise<number> {
  try {
    await render(() => <RaguSuiteApp />, {
      targetFps: 30,
      exitOnCtrlC: true,
      useMouse: true,
      enableMouseMovement: true,
      autoFocus: true,
      consoleMode: "disabled",
    })
  } catch (e) {
    console.error("FATAL:", e)
    return 1
  }
  return 0
}

if (import.meta.main) {
  const code = await runRaguSuiteDashboard()
  if (code !== 0) process.exit(code)
}
