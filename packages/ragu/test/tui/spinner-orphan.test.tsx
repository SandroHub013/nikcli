import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"

const [{ Harness }, { Spinner }, { loadBuiltInTheme }, { KVProvider }, solid] = await Promise.all([
  import("@ragu/tui-storybook/harness.tsx"),
  import("@tui/component/spinner"),
  import("@tui/context/theme-catalog"),
  import("@tui/context/kv"),
  import("solid-js"),
])

const document = await loadBuiltInTheme("ragu")

/*
 * A large session (about 1200 messages) mounts every transcript row, and past
 * ~16k text buffers opentui's native side stops creating them: "Failed to
 * create TextBuffer". The exception reaches the App's ErrorBoundary, which
 * disposes the whole App, but the renderables already on screen are not taken
 * out of the tree, and the fallback cannot be drawn either. The startup
 * "Loading plugins..." spinner was one of them: its owner gone, its node still
 * in the tree, its timer still asking for a frame every 80 ms, and each frame
 * walked the whole dead transcript. ADE read the endless output as a turn.
 *
 * Here the same orphan without the native failure: a spinner made under a root
 * that is disposed while its node stays where it was inserted.
 */
function running(node: any): number {
  const own = Array.isArray(node?._frames) && node?._isRunning === true ? 1 : 0
  return own + (node?.getChildren?.() ?? []).reduce((sum: number, child: unknown) => sum + running(child), 0)
}

describe("a spinner whose owner is gone", () => {
  test("stops asking for frames even if its node is left in the tree", async () => {
    let dispose: (() => void) | undefined
    function Orphaning() {
      const node = solid.createRoot((done: () => void) => {
        dispose = done
        return <Spinner>Loading plugins...</Spinner>
      })
      return <box>{node}</box>
    }
    const { renderer, renderOnce, captureCharFrame } = await testRender(
      () => (
        <KVProvider>
          <Harness document={document} mode="dark" width={60} height={5}>
            <Orphaning />
          </Harness>
        </KVProvider>
      ),
      { width: 60, height: 5 },
    )
    // The KV provider shows its children once kv.json has been read.
    for (let i = 0; i < 50 && !captureCharFrame().includes("Loading"); i++) {
      await Bun.sleep(10)
      renderOnce()
    }
    expect(captureCharFrame()).toContain("Loading plugins...")
    expect(running(renderer.root)).toBe(1)

    dispose!()
    expect(running(renderer.root)).toBe(0)
  })
})
