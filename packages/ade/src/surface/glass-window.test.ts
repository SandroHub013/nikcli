import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { checkNativeGlassStatus, applyNativeGlass, isTauriEnvironment } from "./glass-window"

describe("glass-window bridge", () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    // Ensure clean non-Tauri environment in test
    delete (globalThis as any).__TAURI_INTERNALS__
    delete (globalThis as any).__TAURI__
  })

  afterEach(() => {
    delete (globalThis as any).__TAURI_INTERNALS__
    delete (globalThis as any).__TAURI__
  })

  test("detects non-Tauri browser environment", () => {
    expect(isTauriEnvironment()).toBe(false)
  })

  test("detects Tauri environment when __TAURI_INTERNALS__ is present", () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    expect(isTauriEnvironment()).toBe(true)
  })

  test("checkNativeGlassStatus returns unsupported with null reason outside Tauri", async () => {
    const status = await checkNativeGlassStatus()
    expect(status.supported).toBe(false)
    expect(status.effect).toBe("none")
    expect(status.reason).toBeNull()
  })

  test("applyNativeGlass returns null outside Tauri without leaking import error", async () => {
    const err = await applyNativeGlass(true)
    expect(err).toBeNull()
  })
})
