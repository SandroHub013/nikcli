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

describe("«Altro giro» in the hub", () => {
  const setup = () => {
    const appended: DesignEvent[] = []
    const answered: DesignEvent[] = []
    const register = {
      path: () => "C:\project\.ade\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      refresh: async () => {},
      append: async (event: DesignEvent) => {
        appended.push(event)
      },
      watch: () => () => {},
    } as unknown as DesignRegister
    const hub = createDesignHub({
      register,
      recipient: () => ({ state: "pronta", id: "p1", title: "Master" }),
      sessions: () => [{ id: "p1", title: "Master", running: true }],
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: (_, event) => answered.push(event),
    })
    const proposal: DesignProposal = {
      k: "DS1",
      title: "Tasto",
      variants: [{ name: "A", description: "", preview: "" }],
      raisedBy: "fable",
      openedAt: new Date().toISOString(),
      status: "aperta",
      history: [],
    }
    return { hub, appended, answered, proposal }
  }

  test("with an empty note it records nothing and says what to write", async () => {
    const { hub, appended, answered, proposal } = setup()
    expect(await hub.again(proposal)).toBe(false)
    expect(appended).toEqual([])
    expect(answered).toEqual([])
    expect(hub.problem("DS1")).toBe("Scrivi nella nota cosa cambiare")
  })

  test("with a note it goes through onAnswered with again: true", async () => {
    const { hub, answered, proposal } = setup()
    hub.setDraft("DS1", { picked: 0, note: "meno vetro" })
    expect(await hub.again(proposal)).toBe(true)
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ type: "risposta", again: true, words: "meno vetro" })
    expect((answered[0] as { choice?: string }).choice).toBeUndefined()
  })
})

describe("«Altro giro» with nobody to receive it", () => {
  const setup = () => {
    const calls: string[] = []
    const register = {
      path: () => "C:\\project\\.ade\\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      refresh: async () => {},
      append: async (event: DesignEvent) => {
        calls.push(`append:${(event as { again?: boolean }).again ? "again" : event.type}`)
      },
      watch: () => () => {},
    } as unknown as DesignRegister
    const hub = createDesignHub({
      register,
      recipient: () => ({ state: "non scelta" }),
      sessions: () => [{ id: "p1", title: "Master", running: true }],
      choose: (id) => calls.push(`choose:${id}`),
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })
    const proposal: DesignProposal = {
      k: "DS1",
      title: "Tasto",
      variants: [{ name: "A", description: "", preview: "" }],
      raisedBy: "fable",
      openedAt: new Date().toISOString(),
      status: "aperta",
      history: [],
    }
    hub.setDraft("DS1", { note: "meno vetro" })
    return { hub, calls, proposal }
  }

  test("with the inline select empty it writes nothing, like «Scegli e invia»", async () => {
    const { hub, calls, proposal } = setup()
    expect(await hub.again(proposal)).toBe(false)
    expect(calls).toEqual([])
  })

  test("with a running session picked inline it chooses it, then writes", async () => {
    const { hub, calls, proposal } = setup()
    hub.setInlineRecipient("p1")
    expect(await hub.again(proposal)).toBe(true)
    expect(calls).toEqual(["choose:p1", "append:again"])
  })
})
