import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createDesignHub } from "./hub"
import { t } from "../i18n"
import type { DesignProposal } from "./state"
import { createDesignRegister, type DesignRegister } from "./register"
import type { DesignEvent } from "./log"
import type { DesignIo } from "./store"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { DesignSheet } = await import("./design-sheet")
const { DesignPane } = await import("./design-pane")

const opened = (k: string) =>
  `${JSON.stringify({
    type: "aperta",
    k,
    at: "2026-09-15T10:00:00.000Z",
    by: "fable",
    title: `T ${k}`,
    spec: "S54",
    variants: [
      { name: "A", description: "Alpha" },
      { name: "B", description: "Beta" },
    ],
  })}\n`

function memory(initial: string) {
  const files = new Map([["/p/.ade/design.jsonl", initial]])
  const io: DesignIo = {
    readTextFile: async (path) => ({ text: files.get(path) ?? "", truncated: false }),
    writeTextFile: async (path, contents) => {
      files.set(path, contents)
      return null
    },
    appendTextFile: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
      return null
    },
  }
  return { io, files }
}

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
      tick: async () => {},
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

  test("variant opens via hub openVariant", async () => {
    const register: DesignRegister = {
      path: () => "C:\\project\\.ade\\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      refresh: async () => {},
      append: async () => {},
      tick: async () => {},
      watch: () => () => {},
    }

    const openedVariants: { k: string; variant: number }[] = []
    const hubWithOpen = createDesignHub({
      register,
      recipient: () => ({ state: "non scelta" }),
      sessions: () => [],
      choose: () => {},
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
      openVariant: async (p, v) => {
        openedVariants.push({ k: p.k, variant: v })
        return undefined
      },
    })

    const p: DesignProposal = {
      k: "DS1",
      title: "Settings",
      variants: [{ name: "A", description: "desc", preview: "a.html" }],
      raisedBy: "fable",
      openedAt: new Date().toISOString(),
      status: "aperta",
      history: [],
    }
    await hubWithOpen.openVariant(p, 1)
    expect(openedVariants).toEqual([{ k: "DS1", variant: 1 }])
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
      tick: async () => {},
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
      tick: async () => {},
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

describe("Enter with nobody to receive the answer, in the Design window (audit 0.7.7, MEDIO 7)", () => {
  test("the card says to choose who receives, and the note goes once a session is picked", async () => {
    const register: DesignRegister = {
      path: () => "/p/.ade/design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      refresh: async () => {},
      append: async () => {},
      tick: async () => {},
      watch: () => () => {},
    }
    const hub = createDesignHub({ register, recipient: () => ({ state: "non scelta" }), sessions: () => [], choose: () => {}, delivery: () => ({ state: "in coda" }), onAnswered: () => {} })
    const proposal: DesignProposal = {
      k: "DS1",
      title: "Tasto",
      spec: "S54",
      variants: [
        { name: "A", description: "", preview: "a.html" },
        { name: "B", description: "", preview: "b.html" },
      ],
      raisedBy: "fable",
      openedAt: new Date().toISOString(),
      status: "aperta",
      history: [],
    }
    hub.setDraft("DS1", { picked: 0, note: "" })
    expect(await hub.submit(proposal, "primary")).toBe(false)
    expect(hub.problem("DS1")).toBe(t("design.sheet.needRecipient"))
    hub.setInlineRecipient("p1")
    expect(hub.problem("DS1")).toBeUndefined()
  })
})

describe("card stability (R0, ALTO 1)", () => {
  test("a tick or a new event of another proposal reuses the same DesignProposal object reference", async () => {
    const { io, files } = memory(opened("DS1"))
    await createRoot(async (dispose) => {
      const register = createDesignRegister({ path: () => "/p/.ade/design.jsonl", io: async () => io })
      await register.refresh()
      const ds1Before = register.state()!.proposals[0]

      // A tick occurs
      await register.tick()
      const ds1AfterTick = register.state()!.proposals[0]
      expect(ds1AfterTick).toBe(ds1Before)

      // Another proposal DS2 is opened in the file
      files.set("/p/.ade/design.jsonl", files.get("/p/.ade/design.jsonl")! + opened("DS2"))
      await register.refresh()

      const ds1AfterDS2 = register.state()!.proposals.find((p) => p.k === "DS1")
      expect(ds1AfterDS2).toBe(ds1Before)
      dispose()
    })
  })

  test("with a note in progress and focus inside DesignSheet, a new event for another proposal does not unmount the card", async () => {
    const { io, files } = memory(opened("DS1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDesignRegister>
    let hub!: ReturnType<typeof createDesignHub>

    const dispose = createRoot((dispose) => {
      register = createDesignRegister({ path: () => "/p/.ade/design.jsonl", io: async () => io })
      hub = createDesignHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      render(
        () =>
          createComponent(DesignSheet, {
            hub,
            onClose: () => {},
            onOpenPanel: () => {},
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    // Find the card and textarea
    const cardBefore = host.querySelector('[data-slot="design-card"]') as HTMLElement
    const textarea = host.querySelector('[data-slot="design-note"]') as HTMLTextAreaElement
    expect(cardBefore).not.toBeNull()
    expect(textarea).not.toBeNull()

    // Type a note and focus the textarea
    hub.setDraft("DS1", { note: "nota a metà" })
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    // A tick occurs
    await register.tick()

    // Card must not be unmounted and focus must stay in the note
    const cardAfterTick = host.querySelector('[data-slot="design-card"]')
    expect(cardAfterTick).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    // Another proposal DS2 is added to the register
    files.set("/p/.ade/design.jsonl", files.get("/p/.ade/design.jsonl")! + opened("DS2"))
    await register.refresh()

    // Card must still be the exact same element and focus must still be preserved
    const cardAfterDS2 = host.querySelector('[data-slot="design-card"]')
    expect(cardAfterDS2).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    dispose()
    host.remove()
  })

  test("with a note in progress and focus inside DesignPane, a new event for another proposal does not unmount the card", async () => {
    const { io, files } = memory(opened("DS1"))
    const host = document.createElement("div")
    document.body.append(host)

    let register!: ReturnType<typeof createDesignRegister>
    let hub!: ReturnType<typeof createDesignHub>

    const dispose = createRoot((dispose) => {
      register = createDesignRegister({ path: () => "/p/.ade/design.jsonl", io: async () => io })
      hub = createDesignHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      render(
        () =>
          createComponent(DesignPane, {
            hub,
            focused: true,
          }),
        host,
      )
      return dispose
    })

    await register.refresh()

    const cardBefore = host.querySelector('[data-slot="design-card"]') as HTMLElement
    const textarea = host.querySelector('[data-slot="design-note"]') as HTMLTextAreaElement
    expect(cardBefore).not.toBeNull()
    expect(textarea).not.toBeNull()

    hub.setDraft("DS1", { note: "nota nel pannello" })
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    await register.tick()
    expect(host.querySelector('[data-slot="design-card"]')).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    files.set("/p/.ade/design.jsonl", files.get("/p/.ade/design.jsonl")! + opened("DS2"))
    await register.refresh()

    expect(host.querySelector('[data-slot="design-card"]')).toBe(cardBefore)
    expect(document.activeElement).toBe(textarea)

    dispose()
    host.remove()
  })
})


/*
 * D2 review, MEDIO: opening the sheet cleared every pick, the one made in
 * the browser pane with «Scelgo questa» included, and «I pick in the pane,
 * send from the sheet» lost the choice without a word. A pick made through
 * `hub.pick` is a choice made in this window: the sheet keeps it.
 */
describe("the sheet keeps a choice made in this window", () => {
  async function sheetAfter(prepare: (hub: ReturnType<typeof createDesignHub>) => void) {
    const { io } = memory(opened("DS1"))
    const host = document.createElement("div")
    document.body.append(host)
    let register!: ReturnType<typeof createDesignRegister>
    let hub!: ReturnType<typeof createDesignHub>
    const disposeHub = createRoot((dispose) => {
      register = createDesignRegister({ path: () => "/p/.ade/design.jsonl", io: async () => io })
      hub = createDesignHub({
        register,
        recipient: () => ({ state: "non scelta" }),
        sessions: () => [],
        choose: () => {},
        delivery: () => ({ state: "in coda" }),
        onAnswered: () => {},
      })
      return dispose
    })
    await register.refresh()
    prepare(hub)
    const disposeSheet = createRoot((dispose) => {
      render(() => createComponent(DesignSheet, { hub, onClose: () => {}, onOpenPanel: () => {} }), host)
      return dispose
    })
    const picked = hub.draft("DS1").picked
    disposeSheet()
    disposeHub()
    host.remove()
    return { picked, chosen: hub.chosen("DS1") }
  }

  test("picked in the pane («Scelgo questa»), then the sheet opened: the choice stays", async () => {
    const proposal = { k: "DS1" }
    const { picked, chosen } = await sheetAfter((hub) => hub.pick(proposal, 1))
    expect(picked).toBe(1)
    expect(chosen).toBe(true)
  })

  test("a pick nobody made in this window is still cleared", async () => {
    const { picked, chosen } = await sheetAfter((hub) => hub.setDraft("DS1", { note: "", picked: 1 }))
    expect(picked).toBeUndefined()
    expect(chosen).toBe(false)
  })
})
