import { describe, expect, test } from "bun:test"
import { createDesignHub } from "./hub"
import type { DesignProposal } from "./state"
import type { DesignRegister } from "./register"
import type { DesignEvent } from "./log"

describe("the design register and the hub", () => {
  test("an answer is written from the draft, the draft is cleared and message queued", async () => {
    const appended: DesignEvent[] = []
    const queued: any[] = []

    const register: DesignRegister = {
      path: () => "C:\\project\\.ade\\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      refresh: async () => {},
      append: async (event) => {
        appended.push(event)
      },
      watch: () => () => {},
    }

    const hub = createDesignHub({
      register,
      recipient: () => ({ state: "non scelta" }),
      sessions: () => [],
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: (proposal, event) => queued.push({ proposal, event }),
    })

    const proposal: DesignProposal = {
      k: "DS1",
      title: "Settings layout",
      spec: "S54",
      variants: [
        { name: "A · Rail", description: "Side navigation", preview: "a.html" },
        { name: "B · Cards", description: "Grid cards", preview: "b.html" },
      ],
      raisedBy: "fable",
      openedAt: new Date().toISOString(),
      status: "aperta",
      history: [],
    }

    hub.setDraft("DS1", { picked: 1, note: "Preferisco la variante a tessere" })
    expect(hub.draft("DS1")).toEqual({ picked: 1, note: "Preferisco la variante a tessere" })

    const success = await hub.answer(proposal)
    expect(success).toBe(true)
    expect(appended.length).toBe(1)
    expect(appended[0]!.type).toBe("risposta")
    expect((appended[0] as any).choice).toBe("B · Cards")
    expect(queued.length).toBe(1)
    expect(hub.draft("DS1")).toEqual({ note: "" })
  })

  test("full preview opens and closes via hub", () => {
    const register: DesignRegister = {
      path: () => "C:\\project\\.ade\\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      refresh: async () => {},
      append: async () => {},
      watch: () => () => {},
    }

    const hub = createDesignHub({
      register,
      recipient: () => ({ state: "non scelta" }),
      sessions: () => [],
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })

    expect(hub.fullPreview().open).toBe(false)
    hub.openFullPreview({ name: "A", description: "desc", preview: "a.html" }, "Test Title")
    expect(hub.fullPreview().open).toBe(true)
    expect(hub.fullPreview().variant?.name).toBe("A")
    expect(hub.fullPreview().title).toBe("Test Title")

    hub.closeFullPreview()
    expect(hub.fullPreview().open).toBe(false)
  })
})
