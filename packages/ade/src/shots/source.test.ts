import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createShotSource } from "./source"

/**
 * The browser path only — no host to watch a folder — which is exactly the
 * behaviour worth pinning: the tray must be empty and inert rather than broken
 * when there is nothing to watch.
 */
describe("createShotSource without a host", () => {
  test("starts empty and claims no folder", () => {
    createRoot((dispose) => {
      const source = createShotSource(false)
      expect(source.shots()).toEqual([])
      expect(source.folder()).toBeUndefined()
      expect(source.state()).toBe("none")
      dispose()
    })
  })

  /*
   * The difference the tray needs: with no host, and with a host that says
   * this machine has no screenshots folder, nothing can ever arrive — so the
   * strip says so instead of staying blank, which is what a Mac was left with.
   */
  test("says outright that there is no folder to watch", () => {
    createRoot((dispose) => {
      expect(createShotSource(false).state()).toBe("none")
      dispose()
    })
  })

  test("with a host it waits for the answer before saying anything", () => {
    createRoot((dispose) => {
      expect(createShotSource(true).state()).toBe("asking")
      dispose()
    })
  })

  test("loading an image resolves to nothing rather than throwing", async () => {
    await createRoot(async (dispose) => {
      const source = createShotSource(false)
      expect(await source.load("C:/Pictures/Screenshots/a.png")).toBeNull()
      dispose()
    })
  })

  test("dismissing something that is not there is harmless", () => {
    createRoot((dispose) => {
      const source = createShotSource(false)
      source.dismiss("C:/Pictures/Screenshots/mai-esistito.png")
      expect(source.shots()).toEqual([])
      dispose()
    })
  })

  test("removing without a host still empties the tray", async () => {
    await createRoot(async (dispose) => {
      const source = createShotSource(false)
      expect(await source.remove("C:/Pictures/Screenshots/a.png")).toBe(true)
      expect(source.shots()).toEqual([])
      dispose()
    })
  })

  test("removing with a host that fails keeps the shot and says so", async () => {
    await createRoot(async (dispose) => {
      const asked: string[] = []
      const failing = (async (command: string) => {
        asked.push(command)
        throw new Error("in uso")
      }) as never
      const source = createShotSource(true, failing)
      dispose()
      expect(await source.remove("C:/Pictures/Screenshots/a.png")).toBe(false)
      expect(asked).toEqual(["shot_delete"])
    })
  })

  test("removing with a host that succeeds empties the tray and says so", async () => {
    await createRoot(async (dispose) => {
      const source = createShotSource(true, (async () => undefined) as never)
      dispose()
      expect(await source.remove("C:/Pictures/Screenshots/a.png")).toBe(true)
    })
  })

  test("choosing a folder without a host does nothing rather than throwing", async () => {
    await createRoot(async (dispose) => {
      const source = createShotSource(false)
      await source.choose()
      expect(source.folder()).toBeUndefined()
      expect(source.state()).toBe("none")
      expect(source.notice()).toBeUndefined()
      expect(source.choosing()).toBe(false)
      expect(source.canChoose).toBe(false)
      dispose()
    })
  })
})

describe("createShotSource with a host", () => {
  test("a thumbnail comes as the host's raw bytes (audit RS-18)", async () => {
    await createRoot(async (dispose) => {
      const picture = new Uint8Array([1, 2, 3])
      const ask = (async (command: string) => (command === "shot_bytes" ? picture.buffer : undefined)) as never
      const loading = createShotSource(true, ask).load("C:/Pictures/Screenshots/a.png")
      // Before the await: the source's listener would otherwise reach for a host this test does not have.
      dispose()
      expect(await loading).toEqual(picture)
    })
  })
})
