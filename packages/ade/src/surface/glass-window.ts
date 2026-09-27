/**
 * Bridge between ADE's frontend theme and Tauri's native glass window effects (S49).
 *
 * Calls native Rust commands:
 * - `ade_glass_status`: inspects platform capability (Acrylic / Mica / Vibrancy / Compositor)
 * - `ade_window_set_glass`: enables or disables OS window effect
 */

export interface GlassStatus {
  supported: boolean
  effect: string
  reason?: string | null
}

/**
 * Distinguish running inside the Tauri ADE desktop app from a browser build.
 */
export function isTauriEnvironment(): boolean {
  if (typeof window !== "undefined") {
    return "__TAURI_INTERNALS__" in window || "__TAURI__" in window
  }
  if (typeof globalThis !== "undefined") {
    return "__TAURI_INTERNALS__" in globalThis || "__TAURI__" in globalThis
  }
  return false
}

/**
 * Check whether native glass / transparency is supported on this desktop host.
 * Returns supported: false with clean reason: null when running outside Tauri (browser).
 */
export async function checkNativeGlassStatus(): Promise<GlassStatus> {
  if (!isTauriEnvironment()) {
    return {
      supported: false,
      effect: "none",
      reason: null,
    }
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<GlassStatus>("ade_glass_status")
  } catch (err) {
    return {
      supported: false,
      effect: "none",
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Enable or disable OS-level window transparency and blur (Acrylic / Mica / Vibrancy).
 * Returns null on success or when outside Tauri (clean browser fallback),
 * and the specific failure message only when a native Tauri invocation actually fails.
 */
export async function applyNativeGlass(enabled: boolean): Promise<string | null> {
  if (!isTauriEnvironment()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_set_glass", { enabled })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
