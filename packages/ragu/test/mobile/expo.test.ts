import { describe, expect, it } from "bun:test"
import { Expo } from "@/mobile/expo"

describe("Expo.exec timeout handling", () => {
  it("kills child process on timeout without leaving unhandled rejections", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => {
      unhandled.push(error)
    }
    process.on("unhandledRejection", onUnhandled)

    let childPid = 0
    let caughtError: Error | undefined

    try {
      await Expo._internalExec([], {
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeout: 100,
        onSpawn: (proc) => {
          childPid = proc.pid
        },
      })
    } catch (error) {
      caughtError = error as Error
    }

    expect(caughtError).toBeDefined()
    expect(caughtError!.message).toContain("timed out after 100ms")
    expect(childPid).toBeGreaterThan(0)

    // Wait for kill and reaper to complete
    const deadline = Date.now() + 3000
    let alive = true
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0)
        await Bun.sleep(50)
      } catch {
        alive = false
        break
      }
    }

    expect(alive).toBe(false)
    // Wait a brief window to ensure no late rejection was emitted from run()
    await Bun.sleep(100)
    expect(unhandled).toHaveLength(0)

    process.off("unhandledRejection", onUnhandled)
  }, 10_000)
})
