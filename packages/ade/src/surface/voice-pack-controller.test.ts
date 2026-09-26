import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { InstallProgress, PackState } from "@nikcli-ai/voice"
import { createPackController, followInstall, installCancelled, type VoicePackHost } from "./voice-pack-controller"

const MB = 1024 * 1024

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return { provider: "kokoro", running: true, files_done: 0, files_total: 3, bytes_done: 0, bytes_total: 192 * MB, cancelled: false, error: null, ...overrides }
}

/** A watch that reads once, at once, as a tick would, and records the stop. */
function onceWatch(log: string[]) {
  return (read: () => Promise<InstallProgress | undefined>, onProgress: (p: InstallProgress) => void) => {
    log.push("watch")
    void read().then((p) => p && onProgress(p))
    return () => log.push("stop")
  }
}

function controller(host: VoicePackHost | undefined, log: string[] = [], sizeBytes?: number) {
  let state: PackState = {}
  const seen: PackState[] = []
  const pack = createPackController({
    provider: "kokoro",
    host: async () => host,
    get: () => state,
    set: (next) => {
      state = next
      seen.push(next)
    },
    fallback: "non riuscito",
    watch: onceWatch(log),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  })
  return { pack, state: () => state, seen }
}

describe("the Kokoro pack, driven from the panel", () => {
  test("a host without Kokoro's commands is a pack that is not available", async () => {
    const { pack, state } = controller({})
    await pack.refresh()
    expect(state().status).toBeUndefined()
    const failing = controller({ ttsLocalStatus: async () => Promise.reject(new Error("command tts_local_status not found")) })
    await failing.pack.refresh()
    expect(failing.state().status).toBeUndefined()
  })

  test("K4b's status says only whether it is there: the size is the known one, and no delete", async () => {
    const { pack, state } = controller({ ttsLocalStatus: async () => ({ installed: false }) }, [], 209 * MB)
    await pack.refresh()
    expect(state().status).toEqual({ installed: false, sizeBytes: 209 * MB })
    expect(state().removable).toBe(false)
    const deleting = controller({ ttsLocalStatus: async () => ({ installed: true }), ttsLocalDelete: async () => {} })
    await deleting.pack.refresh()
    expect(deleting.state().removable).toBe(true)
  })

  test("install: watched while it runs, then asked again what is there", async () => {
    const log: string[] = []
    let installed = false
    const host: VoicePackHost = {
      ttsLocalStatus: async () => ({ installed, sizeBytes: 192 * MB }),
      ttsInstallStatus: async () => progress({ running: !installed, bytes_done: installed ? 192 * MB : 50 * MB }),
      ttsLocalInstall: async (provider) => {
        log.push("install:" + provider)
        await Promise.resolve()
        installed = true
      },
    }
    const { pack, state, seen } = controller(host, log)
    await pack.refresh()
    await pack.install()
    expect(log).toEqual(["watch", "install:kokoro", "stop"])
    expect(seen.some((s) => s.busy === "install")).toBe(true)
    expect(state().busy).toBeUndefined()
    expect(state().status?.installed).toBe(true)
    expect(state().error).toBeUndefined()
  })

  test("a failed install says why; a cancelled one is not a failure", async () => {
    const failing = controller({
      ttsLocalStatus: async () => ({ installed: false }),
      ttsInstallStatus: async () => progress({ running: false, error: "Il file scaricato non corrisponde a quello atteso: scartato." }),
      ttsLocalInstall: async () => Promise.reject(new Error("Il file scaricato non corrisponde a quello atteso: scartato.")),
    })
    await failing.pack.install()
    expect(failing.state().error).toContain("non corrisponde")
    const cancelled = controller({
      ttsLocalStatus: async () => ({ installed: false }),
      ttsInstallStatus: async () => progress({ running: false, cancelled: true, error: "Installazione annullata." }),
      ttsLocalInstall: async () => Promise.reject(new Error("Installazione annullata.")),
    })
    await cancelled.pack.install()
    expect(cancelled.state().error).toBeUndefined()
    expect(cancelled.state().progress?.cancelled).toBe(true)
  })

  test("cancel and delete reach the host by provider", async () => {
    const calls: string[] = []
    let installed = true
    const { pack, state } = controller({
      ttsLocalStatus: async () => ({ installed }),
      ttsInstallCancel: async (provider) => {
        calls.push("cancel:" + provider)
        return { cancelled: true }
      },
      ttsLocalDelete: async (provider) => {
        calls.push("delete:" + provider)
        installed = false
      },
    })
    await pack.cancel()
    await pack.remove()
    expect(calls).toEqual(["cancel:kokoro", "delete:kokoro"])
    expect(state().status?.installed).toBe(false)
    expect(state().busy).toBeUndefined()
  })

  test("a cancelled Piper download is told apart from a failed one", async () => {
    expect(await installCancelled({ ttsInstallStatus: async () => progress({ provider: "piper", running: false, cancelled: true }) }, "piper")).toBe(true)
    expect(await installCancelled({ ttsInstallStatus: async () => progress({ provider: "piper", running: false, error: "rete" }) }, "piper")).toBe(false)
    expect(await installCancelled({ ttsInstallStatus: async () => Promise.reject(new Error("no")) }, "piper")).toBe(false)
    expect(await installCancelled(undefined, "piper")).toBe(false)
  })

  test("the Piper download is followed with the same reading, and without one nothing is", () => {
    const log: string[] = []
    const seen: number[] = []
    const stop = followInstall({ ttsInstallStatus: async () => progress({ provider: "piper", bytes_done: 7 }) }, "piper", (p) => seen.push(p.bytes_done), onceWatch(log))
    stop()
    expect(log).toEqual(["watch", "stop"])
    const none = followInstall({}, "piper", () => seen.push(-1), onceWatch(log))
    none()
    expect(log).toEqual(["watch", "stop"])
  })
})

describe("K3's progress and cancel have a caller", () => {
  const read = (...path: string[]) => readFileSync(join(import.meta.dir, "..", "..", ...path), "utf8")

  test("the host facade calls the commands Rust registers, by provider", () => {
    const shell = read("src", "host", "shell.ts")
    const lib = read("src-tauri", "src", "lib.rs")
    for (const command of ["tts_install_status", "tts_install_cancel"]) {
      expect(shell).toContain(`"${command}", { provider }`)
      expect(lib).toContain(`tts::${command},`)
    }
  })

  test("the panel's part of the bridge: status with its size, install, delete; the speaking is K4b's", () => {
    const shell = read("src", "host", "shell.ts")
    expect(shell).toContain('invoke<{ supported: boolean; installed: boolean; sizeBytes?: number }>("tts_local_status", { provider })')
    expect(shell).toContain('invoke("tts_local_install", { provider })')
    expect(shell).toContain('invoke("tts_local_delete", { provider })')
    // The speaker's commands come with K4b's bridge, not a second one here.
    expect(shell).not.toContain('"tts_local_speak"')
    expect(shell).not.toContain('"tts_local_stop"')
  })

  test("the host's size wins over the one the panel knows", async () => {
    const { pack, state } = controller({ ttsLocalStatus: async () => ({ installed: false, sizeBytes: 230 * MB }) }, [], 209 * MB)
    await pack.refresh()
    expect(state().status?.sizeBytes).toBe(230 * MB)
  })

  test("the panel is given the progress, the cancel and the Kokoro pack", () => {
    const workbench = read("src", "surface", "workbench.tsx")
    expect(workbench).toContain('stopFollowing = followInstall(host, "piper", setPiperProgress)')
    expect(workbench).toContain("onCancelInstall={(provider) =>")
    expect(workbench).toContain("kokoroPack={kokoroPack()}")
    expect(workbench).toContain("sizeBytes: KOKORO_DOWNLOAD_BYTES,")
    expect(workbench).toContain("onTestVoice={testReplyVoice}")
    // Both ways a Piper download fails ask first whether it was cancelled.
    expect(workbench).toContain('if (!(await installCancelled(host, "piper"))) failNaturalVoice(v, error)')
    expect(workbench).toContain('if (!(await installCancelled(host, "piper"))) failNaturalVoice(voice, problem)')
  })
})
