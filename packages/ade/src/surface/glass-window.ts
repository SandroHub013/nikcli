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
 * Check whether native glass / transparency is supported on this desktop host.
 * Returns supported: false when running in browser or test environments.
 */
export async function checkNativeGlassStatus(): Promise<GlassStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<GlassStatus>("ade_glass_status")
  } catch {
    return {
      supported: false,
      effect: "none",
      reason: null,
    }
  }
}

/**
 * Enable or disable OS-level window transparency and blur (Acrylic / Mica / Vibrancy).
 * Returns null on success or an error message if native effects failed.
 */
export async function applyNativeGlass(enabled: boolean): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_set_glass", { enabled })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
