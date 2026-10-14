import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"

const [{ Harness }, { AssistantMessage }, { loadBuiltInTheme }, { KVProvider }] = await Promise.all([
  import("@ragu/tui-storybook/harness.tsx"),
  import("@tui/routes/session/parts"),
  import("@tui/context/theme-catalog"),
  import("@tui/context/kv"),
])

const document = await loadBuiltInTheme("ragu")
const T0 = 1_700_000_000_000

/*
 * A reasoning part can be stored without its end: a retry drops the open
 * reasoning without closing it, and a process killed mid-thought never writes
 * it. In a turn that is long sealed, its header still said "Thinking" with a
 * spinner, and the spinner asks for a frame every 80 ms. Every transcript row
 * is mounted, so even scrolled out of sight it kept the whole session
 * repainting: ~9% of a core with nothing running, on a 1200-message session.
 */
function sealedTurn(sealed = true) {
  const entry = (id: string, type: string, extra: Record<string, unknown>) => ({
    id,
    sessionID: "storybook",
    messageID: "m2",
    type,
    timestamp: T0,
    ...extra,
  })
  return {
    messageID: "m2",
    sessionID: "storybook",
    role: "assistant" as const,
    createdAt: T0,
    completedAt: sealed ? T0 + 4200 : undefined,
    compacted: false,
    request: { agent: "build", mode: "normal", modelID: "grok-4.7", providerID: "xai" },
    complete: sealed ? { finish: "stop", outputTokens: 120, cost: 0 } : undefined,
    body: [
      // No `completed`: the end of this thought was never written.
      entry("e1", "reasoning", { text: "Devo leggere il file e poi correggerlo." }),
      entry("e2", "text", { text: "Fatto.", completed: T0 + 4000 }),
    ],
  }
}

async function mount(turn: ReturnType<typeof sealedTurn>) {
  const view = await testRender(
    () => (
      <KVProvider>
        <Harness document={document} mode="dark" width={100} height={20}>
          <box width={100}>
            <AssistantMessage turn={turn as never} last={true} />
          </box>
        </Harness>
      </KVProvider>
    ),
    { width: 100, height: 20 },
  )
  // The KV provider shows its children once kv.json has been read.
  for (let i = 0; i < 50 && !view.captureCharFrame().includes("Fatto"); i++) {
    await Bun.sleep(10)
    view.renderOnce()
  }
  return view
}

/** Spinners whose timer is running: each one asks for a frame every interval. The class is minified, so by its fields. */
function spinners(node: any): number {
  const own = Array.isArray(node?._frames) && node?._isRunning === true ? 1 : 0
  return own + (node?.getChildren?.() ?? []).reduce((sum: number, child: unknown) => sum + spinners(child), 0)
}

describe("reasoning in a sealed turn", () => {
  test("is a finished thought, not a spinner that keeps the session repainting", async () => {
    const { renderer, captureCharFrame } = await mount(sealedTurn())
    const frame = captureCharFrame()
    expect(frame).toContain("Fatto")
    expect(frame).toContain("Thought")
    expect(frame).not.toContain("Thinking")
    expect(spinners(renderer.root)).toBe(0)
  })

  test("while the turn is still running, the same part is still thinking", async () => {
    const { renderer, captureCharFrame } = await mount(sealedTurn(false))
    expect(captureCharFrame()).toContain("Thinking")
    expect(spinners(renderer.root)).toBe(1)
  })
})
