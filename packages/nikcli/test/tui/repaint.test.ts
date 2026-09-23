import { describe, expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { forceFullRepaint, scheduleOverlayRepaint } from "@tui/util/repaint"
import { shouldForceOverlayRepaint } from "@nikcli-ai/util/win32"

type FakeRenderer = {
  requestRender: () => void
  forceFullRepaintRequested?: boolean
}

function fakeRenderer(withFlag: boolean) {
  const calls = { render: 0 }
  const renderer: FakeRenderer = {
    requestRender: () => {
      calls.render++
    },
  }
  if (withFlag) renderer.forceFullRepaintRequested = false
  return { renderer: renderer as unknown as CliRenderer, flag: renderer, calls }
}

describe("overlay repaint", () => {
  test("only Windows needs the forced repaint", () => {
    expect(shouldForceOverlayRepaint("win32")).toBe(true)
    expect(shouldForceOverlayRepaint("darwin")).toBe(false)
    expect(shouldForceOverlayRepaint("linux")).toBe(false)
  })

  test("sets the renderer's own full-repaint flag", () => {
    const { renderer, flag, calls } = fakeRenderer(true)
    expect(forceFullRepaint(renderer)).toBe(true)
    expect(flag.forceFullRepaintRequested).toBe(true)
    expect(calls.render).toBe(1)
  })

  test("degrades to a plain render request when OpenTUI drops the flag", () => {
    const { renderer, calls } = fakeRenderer(false)
    expect(forceFullRepaint(renderer)).toBe(false)
    expect(calls.render).toBe(1)
  })

  test("tolerates a missing renderer", () => {
    expect(forceFullRepaint(undefined)).toBe(false)
  })

  test("scheduling returns a cancel that stops the pending repaint", async () => {
    const { renderer, calls } = fakeRenderer(true)
    const cancel = scheduleOverlayRepaint(renderer, 1)
    cancel()
    await Bun.sleep(10)
    // Off Windows scheduling is a no-op anyway; what this pins is that
    // cancelling never leaves a repaint queued behind a closed dialog.
    expect(calls.render).toBe(0)
  })
})
