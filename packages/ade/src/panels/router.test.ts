import { describe, expect, test } from "bun:test"
import { createPanelRouter, type PanelHandler } from "./router"
import { REPLY_PREFIX } from "./protocol"

const VERBS = [{ name: "play", usage: "play", summary: "avvia" }] as const

/** A panel that records what it was asked and answers as told. */
function panel(answer: PanelHandler["run"]): PanelHandler & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    verbs: VERBS,
    run: (request) => {
      asked.push(`${request.verb} ${request.args.join(" ")}`.trim())
      return answer(request)
    },
  }
}

describe("createPanelRouter", () => {
  test("an ordinary line of output is not a request", async () => {
    const router = createPanelRouter()
    router.register("video", panel(async () => ({ ok: true, detail: "fatto" })))

    expect(await router.handle("Compiled 3 modules in 412ms")).toBeUndefined()
    // Including a line that talks *about* the protocol without being one.
    expect(await router.handle("puoi scrivere @ade video play per avviarlo")).toBeUndefined()
  })

  test("a request reaches the panel it names, and the reply says what happened", async () => {
    const router = createPanelRouter()
    const video = panel(async () => ({ ok: true, detail: "0:12.0 di 1:40.0, in riproduzione" }))
    router.register("video", video)

    const handled = await router.handle("@ade video seek 12")
    expect(video.asked).toEqual(["seek 12"])
    expect(handled?.reply).toBe(`${REPLY_PREFIX} video seek ok — 0:12.0 di 1:40.0, in riproduzione`)
  })

  test("a panel that is not open is told so, with the ones that are", async () => {
    const router = createPanelRouter()
    router.register("video", panel(async () => ({ ok: true, detail: "" })))

    const handled = await router.handle("@ade 3d rotate 90")
    /*
     * The failure this prevents: answering "ok" for a panel nobody is
     * showing. The agent would go on reasoning about a view that does not
     * exist, and nothing in the interface would contradict it.
     */
    expect(handled?.reply).toContain("errore")
    expect(handled?.reply).toContain("«3d» non è aperto")
    expect(handled?.reply).toContain("video")
  })

  test("with nothing open at all it says that instead of listing an empty set", async () => {
    const router = createPanelRouter()
    const handled = await router.handle("@ade video play")
    expect(handled?.reply).toContain("nessun pannello aperto")
  })

  test("a panel that throws still answers, because the agent is blocked on the line", async () => {
    const router = createPanelRouter()
    router.register(
      "video",
      panel(() => Promise.reject(new Error("il file non è leggibile"))),
    )

    const handled = await router.handle("@ade video play")
    expect(handled?.reply).toBe(`${REPLY_PREFIX} video play errore — il file non è leggibile`)
  })

  test("a closed panel stops answering", async () => {
    const router = createPanelRouter()
    router.register("video", panel(async () => ({ ok: true, detail: "fatto" })))
    expect(router.open()).toEqual(["video"])

    router.unregister("video")
    expect(router.open()).toEqual([])
    const handled = await router.handle("@ade video play")
    expect(handled?.reply).toContain("errore")
  })

  test("the reply ADE typed is never read back as a new request", async () => {
    const router = createPanelRouter()
    const video = panel(async () => ({ ok: true, detail: "fatto" }))
    router.register("video", video)

    // The terminal echoes what ADE writes; taking that for a request would be
    // a loop with no exit.
    const first = await router.handle("@ade video play")
    expect(first).toBeDefined()
    expect(await router.handle(first!.reply)).toBeUndefined()
    expect(video.asked).toEqual(["play"])
  })

  test("the greeting describes the panel that is open, and nothing when none is", () => {
    const router = createPanelRouter()
    expect(router.greeting("video")).toEqual([])

    router.register("video", panel(async () => ({ ok: true, detail: "" })))
    const lines = router.greeting("video")
    expect(lines.length).toBeGreaterThan(2)
    // Every line is prefixed, so the greeting cannot be read back as requests.
    expect(lines.every((line) => line.startsWith(REPLY_PREFIX))).toBe(true)
    expect(lines.join("\n")).toContain("play")
  })
})
