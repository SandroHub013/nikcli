import { describe, expect, it } from "bun:test"
import { Rpc } from "@tui/util/rpc"

/**
 * What survives a worker hop.
 *
 * An Effect tagged error can fail with an empty `message` and the reason in one of its own
 * fields (the old updater's `UpgradeFailedError` kept it in `stderr`). The RPC layer used to
 * forward only name, message and stack, so the terminal received a plain `Error` with nothing in
 * it. An `instanceof` check against the original class cannot help: the class does not cross the
 * boundary either.
 */
function fakeWorker() {
  const target = {
    postMessage(_data: string) {},
    onmessage: null as ((ev: MessageEvent<string>) => unknown) | null,
  }
  return {
    target,
    /** Answer the request that was just made, the way `Rpc.listen` would. */
    reply(frame: Record<string, unknown>) {
      target.onmessage?.({ data: JSON.stringify({ id: 0, ...frame }) } as MessageEvent<string>)
    },
  }
}

describe("worker rpc errors", () => {
  it("carries a tagged error's own fields, not just its message", async () => {
    const worker = fakeWorker()
    const client = Rpc.client<{ server: (input: unknown) => Promise<void> }>(worker.target)

    const pending = client.call("server", {})
    worker.reply({
      type: "rpc.error",
      error: { name: "ServerStartError", message: "", data: { stderr: "port 4096 in use" } },
    })

    const error = await pending.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe("ServerStartError")
    // The reason the terminal can show.
    expect((error as { stderr?: string }).stderr).toBe("port 4096 in use")
  })

  it("still resolves an error frame with no extra fields", async () => {
    const worker = fakeWorker()
    const client = Rpc.client<{ anything: (input: unknown) => Promise<void> }>(worker.target)

    const pending = client.call("anything", {})
    worker.reply({ type: "rpc.error", error: { name: "Error", message: "plain failure" } })

    const error = await pending.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as Error).message).toBe("plain failure")
  })
})

describe("worker rpc startup", () => {
  it("a request made before the worker is listening is answered, not lost", async () => {
    // `default.ts` starts calling the worker as soon as it is constructed, while
    // the worker is still evaluating an import graph with a top-level `await`.
    // A request posted in that window used to vanish, and with no timeout on
    // `call` the caller — the TUI's first bootstrap — waited forever: the
    // never-paints startup (`specs/effect-tui/00-startup-hang.md`).
    const worker = new Worker(new URL("./fixtures/slow-rpc-worker.ts", import.meta.url).href, {
      env: { ...process.env, RPC_WORKER_DELAY_MS: "200" },
    })
    try {
      const client = Rpc.client<{ echo: (input: number) => number }>(worker)
      const answer = await Promise.race([
        client.call("echo", 42),
        new Promise<"lost">((resolve) => setTimeout(() => resolve("lost"), 3_000)),
      ])
      expect(answer).toBe(42)
    } finally {
      worker.terminate()
    }
  })
})
