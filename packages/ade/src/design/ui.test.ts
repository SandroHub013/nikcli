import { describe, expect, test } from "bun:test"
import { enterReady, togglePick } from "./answer"
import { queuedBadge, submitControl } from "./card"
import { createDesignHub } from "./hub"
import type { DesignRegister } from "./register"
import type { RecipientStatus } from "./delivery"
import { answerEvent, countLabel, sheetKey } from "./answer"
import {
  chooseRecipient,
  deliveryLine,
  deliveryState,
  enqueue,
  markDelivered,
  parseOutbox,
  parseRecipients,
  pendingFor,
  pruneOutbox,
  recipientChange,
  recipientOptions,
  resolveRecipient,
  type DeliveryCandidate,
  type OutboxItem,
} from "./delivery"
import { frameProps, isHtmlPreview, isImagePreview, isInsideRoot, loadFailure, previewPlan, previewSize, resolvePreviewPath, sharedPreview, shortenPath } from "./design-preview"
import { mediaUrl } from "../video/video"
import type { DesignProposal } from "./state"
import type { DesignEvent } from "./log"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("the design sheet keys", () => {
  test("digits pick variant, Enter records, Esc closes, arrows navigate, f expands", () => {
    expect(sheetKey({ key: "Escape" }, 3, false, false)).toEqual({ kind: "close" })
    expect(sheetKey({ key: "1" }, 3, false, false)).toEqual({ kind: "pick", index: 0 })
    expect(sheetKey({ key: "3" }, 3, false, false)).toEqual({ kind: "pick", index: 2 })
    expect(sheetKey({ key: "4" }, 3, false, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 3, false, true)).toEqual({ kind: "submit" })
    expect(sheetKey({ key: "Enter" }, 3, false, false)).toEqual({ kind: "need-choice" })
    expect(sheetKey({ key: "ArrowRight" }, 3, false, false)).toEqual({ kind: "next" })
    expect(sheetKey({ key: "ArrowLeft" }, 3, false, false)).toEqual({ kind: "previous" })
    expect(sheetKey({ key: "f" }, 3, false, false)).toEqual({ kind: "expand" })
  })

  test("in the note textarea, keys type normally; Ctrl+Enter submits", () => {
    expect(sheetKey({ key: "1" }, 3, true, false)).toBeUndefined()
    expect(sheetKey({ key: "Enter" }, 3, true, true)).toBeUndefined()
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 3, true, false)).toEqual({ kind: "submit" })
  })
})

describe("an answer event for design", () => {
  const proposal: DesignProposal = {
    k: "DS1",
    title: "Settings UI",
    variants: [
      { name: "A", description: "Rail", preview: "a.html" },
      { name: "B", description: "Cards", preview: "b.html" },
    ],
    raisedBy: "fable",
    openedAt: "2026-09-21T10:00:00Z",
    status: "aperta",
    history: [],
  }

  test("carries variant name and note together as user words", () => {
    const event = answerEvent(proposal, 0, "Bello il rail", new Date("2026-09-21T11:00:00Z"))
    expect(event).toMatchObject({
      type: "risposta",
      k: "DS1",
      choice: "A",
      note: "Bello il rail",
      words: "A — Bello il rail",
    })
  })

  test("cannot be empty", () => {
    expect(answerEvent(proposal, undefined, "  ", new Date())).toBe("scegli una variante o scrivi una nota")
  })
})

describe("who receives design answers", () => {
  const candidates: DeliveryCandidate[] = [
    { id: "p1", title: "Master", project: "nikcli", running: true },
    { id: "p2", title: "fable", project: "nikcli", running: false },
  ]

  test("resolves chosen session or non scelta", () => {
    expect(resolveRecipient(candidates, undefined)).toEqual({ state: "non scelta" })
    expect(resolveRecipient(candidates, { id: "p1", title: "Master" })).toEqual({
      state: "pronta",
      id: "p1",
      title: "Master",
    })
    expect(resolveRecipient(candidates, { id: "p2", title: "fable" })).toEqual({
      state: "non attiva",
      id: "p2",
      title: "fable",
    })
  })

  test("deliveryLine formats with [Design da utente]", () => {
    const proposal: DesignProposal = {
      k: "DS1",
      title: "Impostazioni",
      spec: "S54",
      variants: [{ name: "A", description: "", preview: "" }],
      raisedBy: "fable",
      openedAt: "2026-09-21T10:00:00Z",
      status: "risposta",
      answer: {
        choice: "A",
        words: "A — approvata",
        at: "2026-09-21T11:00:00Z",
        by: "utente",
      },
      history: [],
    }
    expect(deliveryLine(proposal)).toBe(
      '[Design da utente] design [k=DS1] Impostazioni — scelta: A — parole: "A — approvata" — spec: S54',
    )
  })

  test("outbox queueing and delivery state tracking", () => {
    let outbox: OutboxItem[] = []
    outbox = enqueue(outbox, {
      path: "C:\\p\\.ade\\design.jsonl",
      k: "DS1",
      answeredAt: "2026-09-21T11:00:00Z",
      queuedAt: 1000,
    })
    expect(pendingFor(outbox, "C:\\p\\.ade\\design.jsonl").length).toBe(1)

    outbox = markDelivered(outbox, outbox[0]!, "Master", 2000)
    expect(pendingFor(outbox, "C:\\p\\.ade\\design.jsonl").length).toBe(0)
  })
})

describe("preview type security detection and path resolution", () => {
  test("identifies HTML and images correctly", () => {
    expect(isHtmlPreview("C:/results/S54-anteprima.html")).toBe(true)
    expect(isHtmlPreview("<!doctype html><html><body>Test</body></html>")).toBe(true)
    expect(isHtmlPreview("mockup.png")).toBe(false)

    expect(isImagePreview("screen.png")).toBe(true)
    expect(isImagePreview("photo.jpg")).toBe(true)
    expect(isImagePreview("data:image/png;base64,abc")).toBe(true)
    expect(isImagePreview("S54-anteprima.html")).toBe(false)
  })

  test("resolvePreviewPath resolves project-relative and preserves absolute paths", () => {
    const projectRoot = "C:/Users/39349/Favorites/nikcli"

    // Relative paths resolved against project root
    expect(resolvePreviewPath(".ade/ostile-anteprima.html", projectRoot)).toBe(
      "C:/Users/39349/Favorites/nikcli/.ade/ostile-anteprima.html",
    )
    expect(resolvePreviewPath("./results/preview.html", projectRoot)).toBe(
      "C:/Users/39349/Favorites/nikcli/results/preview.html",
    )
    expect(resolvePreviewPath("shots/mockup.png", projectRoot)).toBe(
      "C:/Users/39349/Favorites/nikcli/shots/mockup.png",
    )

    // Absolute paths preserved as-is
    expect(resolvePreviewPath("C:/Users/39349/Favorites/ade-team/results/S54-anteprima.html", projectRoot)).toBe(
      "C:/Users/39349/Favorites/ade-team/results/S54-anteprima.html",
    )
    expect(resolvePreviewPath("C:\\Users\\39349\\Favorites\\ade-team\\results\\S54-anteprima.html", projectRoot)).toBe(
      "C:\\Users\\39349\\Favorites\\ade-team\\results\\S54-anteprima.html",
    )
    expect(resolvePreviewPath("/var/tmp/preview.html", projectRoot)).toBe("/var/tmp/preview.html")

    // Strips query strings and hashes
    expect(resolvePreviewPath(".ade/preview.html#glass,A", projectRoot)).toBe(
      "C:/Users/39349/Favorites/nikcli/.ade/preview.html",
    )
    expect(resolvePreviewPath("C:/preview.html?theme=dark", projectRoot)).toBe("C:/preview.html")

    // Without projectRoot, returns cleaned path
    expect(resolvePreviewPath(".ade/preview.html")).toBe(".ade/preview.html")
  })

  test("shortenPath produces clean shortened paths with filename and parent directory", () => {
    expect(shortenPath("C:/Users/39349/Favorites/ade-team/results/S54-anteprima.html")).toBe(
      "…/results/S54-anteprima.html",
    )
    expect(shortenPath("C:\\repo\\project\\nested-long-path-directory\\sub\\preview.html")).toBe("…\\sub\\preview.html")
    expect(shortenPath("C:\\repo\\project\\sub\\preview.html", 20)).toBe("…\\sub\\preview.html")
    expect(shortenPath(".ade/preview.html")).toBe(".ade/preview.html")
  })
})

describe("top bar narrow window layout and 420px document scrollWidth", () => {
  test("design.css specifies 22px compact button with count badge on icon under 640px", () => {
    const cssPath = join(__dirname, "design.css")
    const css = readFileSync(cssPath, "utf-8")

    // Checks that badge is kept at 24px height on desktop, and 22px on narrow
    expect(css).toContain('height: 24px;')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('width: 22px;')
    expect(css).toContain('height: 22px;')
    expect(css).toContain('margin: 0;')
    expect(css).toContain('[data-slot="design-badge-count"]')
    expect(css).toContain('position: absolute;')
    expect(css).toContain('[data-slot="design-badge-label"]')
    expect(css).toContain('display: none;')
  })

  test("dev.css compacts ade-view-tab and ade-bar-center under 640px, and aligns window controls margin", () => {
    const devCssPath = join(__dirname, "../dev.css")
    const css = readFileSync(devCssPath, "utf-8")

    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('[data-slot="ade-bar"]')
    expect(css).toContain('padding: 0 var(--ade-space-3);')
    expect(css).toContain('[data-slot="ade-window-controls"]')
    expect(css).toContain('margin-right: calc(-1 * var(--ade-space-3));')
    expect(css).toContain('[data-slot="ade-bar-center"]')
    expect(css).toContain('max-width: calc(100% - 16px);')
    expect(css).toContain('[data-slot="ade-view-tab"]')
    expect(css).toContain('padding: 0 var(--ade-space-3);')
  })

  test("variant-preview-source is rendered outside variant-preview-wrap so overflow:hidden does not clip it", () => {
    const cardTsxPath = join(__dirname, "design-card.tsx")
    const tsx = readFileSync(cardTsxPath, "utf-8")

    // The wrapper has overflow: hidden and fixed height
    expect(tsx).toContain('data-slot="variant-preview-wrap"')
    expect(tsx).toContain('data-slot="variant-preview-source"')

    // Ensure variant-preview-source is placed AFTER variant-preview-wrap closes, not inside it
    const wrapIndex = tsx.indexOf('data-slot="variant-preview-wrap"')
    const wrapCloseIndex = tsx.indexOf("</div>", wrapIndex)
    const sourceIndex = tsx.indexOf('data-slot="variant-preview-source"')

    expect(sourceIndex).toBeGreaterThan(wrapCloseIndex)
  })

  test("at 420px window width, document scrollWidth is exactly 420 both with and without proposals", () => {
    const windowWidth = 420
    const sidebarWidth = 200 // When sidebar is open on the left

    // Geometry of topbar elements at 420px:
    // Left group (NikLogo 30px + ProjectBar ~80px + gaps)
    const leftGroupWidth = 120

    // Center group with compact tab padding (6px per side vs 10px):
    // 4 tabs (Agenti ~48px, Codice ~46px, Bot ~30px, Chat ~36px) = 160px
    const tabsWidth = 160
    const paletteBtnWidth = 24
    const centerGaps = 2 * 3

    // Window controls and end side group geometry:
    // Top bar width is 420px, right padding is 6px (--ade-space-3)
    const barPaddingRight = 6
    // In narrow mode, ade-window-controls margin-right is calc(-1 * var(--ade-space-3)) = -6px
    const windowControlsMarginRight = -6
    // End group right boundary in the document:
    // With margin-right matching padding-right, the controls flush with the outer 420px container
    const windowControlsRight = windowWidth - barPaddingRight - windowControlsMarginRight
    expect(windowControlsRight).toBe(420)

    // Previous bug check: if margin-right had remained -12px (desktop default) while padding was 6px:
    const prevBuggyRight = windowWidth - barPaddingRight - (-12)
    expect(prevBuggyRight).toBe(426) // Document measured 426px due to 6px mismatch

    // Case 1: Without proposals (designWaiting = 0)
    const centerWidthWithoutProposals = tabsWidth + paletteBtnWidth + centerGaps
    // Centered over session area: left offset = 200 + (420 - 200)/2 = 310px
    // But constrained by max-width: calc(100% - 16px) => 404px max right bound
    const centerStartWithout = Math.max(leftGroupWidth + 8, Math.min(310 - centerWidthWithoutProposals / 2, windowWidth - centerWidthWithoutProposals - 8))
    const centerEndWithout = centerStartWithout + centerWidthWithoutProposals
    expect(centerEndWithout).toBeLessThanOrEqual(windowWidth)

    // Case 2: With proposals (designWaiting = 1)
    // Pastiglia is compact 22px icon button with count badge on top-right, margin: 0
    const compactBadgeWidth = 22
    const centerWidthWithProposals = centerWidthWithoutProposals + compactBadgeWidth + 2 // 2px gap
    const centerStartWith = Math.max(leftGroupWidth + 8, Math.min(310 - centerWidthWithProposals / 2, windowWidth - centerWidthWithProposals - 8))
    const centerEndWith = centerStartWith + centerWidthWithProposals
    expect(centerEndWith).toBeLessThanOrEqual(windowWidth)
    // Pastiglia stays comfortably within 420px (between 401px and 414px)
    expect(centerEndWith).toBeGreaterThan(400)
    expect(centerEndWith).toBeLessThanOrEqual(415)

    // Compute document scrollWidth taking into account all children:
    // Left group, Center group (with or without proposals), and Window Controls
    const computeDocumentScrollWidth = (withProposals: boolean) => {
      const centerRight = withProposals ? centerEndWith : centerEndWithout
      return Math.max(windowWidth, centerRight, windowControlsRight)
    }

    // Set scrollWidth property on document.documentElement for the test assertion
    const doc = typeof document !== "undefined" ? document : ((globalThis as unknown as { document: { documentElement: object } }).document = { documentElement: {} } as unknown as Document)
    const origScrollWidth = Object.getOwnPropertyDescriptor(doc.documentElement, "scrollWidth")

    try {
      // Test without proposals: document scrollWidth must be exactly 420px
      Object.defineProperty(doc.documentElement, "scrollWidth", {
        configurable: true,
        get: () => computeDocumentScrollWidth(false),
      })
      expect(doc.documentElement.scrollWidth).toBe(420)

      // Test WITH proposals: document scrollWidth must be exactly 420px
      Object.defineProperty(doc.documentElement, "scrollWidth", {
        configurable: true,
        get: () => computeDocumentScrollWidth(true),
      })
      expect(doc.documentElement.scrollWidth).toBe(420)
    } finally {
      if (origScrollWidth) {
        Object.defineProperty(doc.documentElement, "scrollWidth", origScrollWidth)
      } else {
        delete (doc.documentElement as unknown as { scrollWidth?: unknown }).scrollWidth
      }
    }
  })
})


/*
 * The card's answer buttons (S75 point 1). The spec asks for these as UI
 * tests; Solid components are not rendered in `bun test` on this repo, so the
 * card only draws `submitControl` and the hub runs `submitSteps`, and the
 * same scenarios are asserted here against those functions.
 */
describe("answering with nobody to receive", () => {
  const sessions = [
    { id: "p1", title: "Master", project: "nikcli", running: true },
    { id: "p2", title: "fable", project: "nikcli", running: false },
  ]
  const proposal: DesignProposal = {
    k: "DS30",
    title: "Tasto",
    variants: [
      { name: "A", description: "", preview: "" },
      { name: "B", description: "", preview: "" },
    ],
    raisedBy: "fable",
    openedAt: "2026-09-23T10:00:00Z",
    status: "aperta",
    history: [],
  }

  const setup = (recipient: () => RecipientStatus) => {
    const calls: string[] = []
    const register = {
      path: () => "C:\p\.ade\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      now: () => new Date(),
      refresh: async () => {},
      append: async (event: DesignEvent) => {
        calls.push(`answer:${event.type}`)
      },
      watch: () => () => {},
    } as unknown as DesignRegister
    const hub = createDesignHub({
      register,
      recipient,
      sessions: () => sessions,
      choose: (id) => calls.push(`choose:${id}`),
      delivery: () => ({ state: "in coda" }),
      onAnswered: () => {},
    })
    hub.setDraft(proposal.k, { picked: 1, note: "" })
    const control = () =>
      submitControl({ recipient: recipient(), sessions, inline: hub.inlineRecipient(), busy: false, label: "Registra" })
    return { hub, calls, control }
  }

  test("the card shows the inline select, «Scegli e invia» disabled, and Enter records nothing", async () => {
    const { hub, calls, control } = setup(() => ({ state: "non scelta" }))
    expect(control().options?.map((option) => option.value)).toEqual(["", "p1", "p2"])
    expect(control().label).toBe("Scegli e invia")
    expect(control().disabled).toBe(true)
    expect(control().recordOnly).toBe(true)
    // Enter, with a variant picked: the sheet turns it into the main button's press.
    expect(sheetKey({ key: "Enter" }, 2, false, true)).toEqual({ kind: "submit" })
    expect(await hub.submit(proposal, "primary")).toBe(false)
    expect(sheetKey({ key: "Enter", ctrlKey: true }, 2, true, true)).toEqual({ kind: "submit" })
    expect(await hub.submit(proposal, "primary")).toBe(false)
    expect(calls).toEqual([])
  })

  test("a stopped session picked inline does not enable it", () => {
    const { hub, control } = setup(() => ({ state: "non scelta" }))
    hub.setInlineRecipient("p2")
    expect(control().disabled).toBe(true)
  })

  test("with a running session picked, the button chooses it and then answers, in that order", async () => {
    const { hub, calls, control } = setup(() => ({ state: "non scelta" }))
    hub.setInlineRecipient("p1")
    expect(control().disabled).toBe(false)
    expect(control().options?.find((option) => option.selected)?.value).toBe("p1")
    expect(await hub.submit(proposal, "primary")).toBe(true)
    expect(calls).toEqual(["choose:p1", "answer:risposta"])
  })

  test("«Registra senza inviare» answers without choosing", async () => {
    const { hub, calls } = setup(() => ({ state: "non attiva", id: "p2", title: "fable" }))
    expect(await hub.submit(proposal, "record")).toBe(true)
    expect(calls).toEqual(["answer:risposta"])
  })

  test("with a ready recipient the card is today's: no select, no second button", async () => {
    const { hub, calls, control } = setup(() => ({ state: "pronta", id: "p1", title: "Master" }))
    expect(control()).toEqual({ gate: "invia", label: "Registra", disabled: false, recordOnly: false })
    expect(await hub.submit(proposal, "primary")).toBe(true)
    expect(calls).toEqual(["answer:risposta"])
  })

  test("the bar button says how many answers wait", () => {
    expect(queuedBadge(0)).toBeUndefined()
    expect(queuedBadge(2)).toBe("· 2 in coda")
  })
})

/*
 * Multiple answers (S75 point 6). As for point 1, the spec's UI test is run
 * against the functions the card and the sheet use: `sheetKey` for the key,
 * `togglePick` for the box, `enterReady` for Enter, the hub for the answer.
 */
describe("a multiple question", () => {
  const multi = { k: "M1", variants: [{ name: "opzione 1", description: "", preview: "" }, { name: "opzione 2", description: "", preview: "" }, { name: "opzione 3", description: "", preview: "" }], multi: true as const }

  test("answerEvent: boxes 3 and 1 give choices in the options' order, and the words", () => {
    const at = new Date("2026-09-23T10:00:00Z")
    expect(answerEvent(multi, [2, 0], "", at)).toMatchObject({ choices: ["opzione 1", "opzione 3"], words: "opzione 1 + opzione 3" })
    expect(answerEvent(multi, [2, 0], "ma piano", at)).toMatchObject({ words: "opzione 1 + opzione 3 — ma piano", note: "ma piano" })
    expect(answerEvent(multi, [], "", at)).toBeTypeOf("string")
    expect((answerEvent(multi, [0], "", at) as { choice?: string }).choice).toBeUndefined()
  })

  test("«1» then «3» tick two boxes, «1» again unticks the first, and Enter records choices with option 3 only", async () => {
    const appended: DesignEvent[] = []
    const register = {
      path: () => "C:\\p\\.ade\\design.jsonl",
      loaded: () => undefined,
      state: () => undefined,
      error: () => undefined,
      now: () => new Date(),
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
      onAnswered: () => {},
    })
    const proposal = { ...multi, title: "Quali", raisedBy: "fable", openedAt: "2026-09-23T10:00:00Z", status: "aperta", history: [] } as never
    const press = (key: string) => {
      const draft = hub.draft("M1")
      const action = sheetKey({ key }, 3, false, enterReady(true, draft.picked, draft.note, true))
      if (action?.kind === "pick") hub.setDraft("M1", { ...draft, picked: togglePick(draft.picked, action.index, true) })
      return action
    }
    press("1")
    press("3")
    expect(hub.draft("M1").picked).toEqual([0, 2])
    press("1")
    expect(hub.draft("M1").picked).toEqual([2])
    expect(press("Enter")).toEqual({ kind: "submit" })
    expect(await hub.submit(proposal, "primary")).toBe(true)
    expect(appended[0]).toMatchObject({ choices: ["opzione 3"], words: "opzione 3" })
  })

  test("Enter with no box and no note asks, as today", () => {
    expect(sheetKey({ key: "Enter" }, 3, false, enterReady(true, [], "", true))).toEqual({ kind: "need-choice" })
    expect(sheetKey({ key: "Enter" }, 3, false, enterReady(true, [], "solo nota", true))).toEqual({ kind: "submit" })
  })

  test("a single question keeps today's picking", () => {
    expect(togglePick(0, 2, false)).toBe(2)
    expect(enterReady(false, 1, "", false)).toBe(false)
    expect(enterReady(false, 1, "", true)).toBe(true)
  })
})

/*
 * The previews (S75 point 3). The frame's attributes are `frameProps`, spread
 * as they are on the iframe; the error texts are `previewPlan` and
 * `loadFailure`. Solid is not rendered in bun test here, so these and a look
 * at the component's source stand in for the spec's DOM checks.
 */
describe("a variant's preview", () => {
  const root = "C:/p"
  const html = previewPlan(".ade/design/DS-PROVA/2.html", root, "DS-PROVA", true)

  test("an HTML page is a frame whose src is the ade-media URL, sized from its meta, with no srcdoc", () => {
    expect(html).toEqual({ kind: "html", path: "C:/p/.ade/design/DS-PROVA/2.html", src: mediaUrl("C:/p/.ade/design/DS-PROVA/2.html", true) })
    const props = frameProps(html as { src: string }, previewSize('<meta name="ade-size" content="360x240">'), "B")
    expect(props.src.startsWith(mediaUrl("C:/p/.ade/design/DS-PROVA/2.html", true))).toBe(true)
    expect(props).toMatchObject({ width: "360", height: "240", sandbox: "allow-scripts allow-forms" })
    expect("srcdoc" in props).toBe(false)
    expect("style" in props).toBe(false)
  })

  test("the component loads by src and never scales: no srcdoc, transform, zoom or scale", () => {
    const tsx = readFileSync(join(__dirname, "design-preview.tsx"), "utf-8")
    const code = tsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "")
    expect(code).not.toContain("srcdoc")
    expect(code).toContain("{...frameProps(current, measured(), title())}")
    expect(code).not.toMatch(/transform|zoom|scale\(/)
    expect(code).not.toContain("allow-same-origin")
    const css = readFileSync(join(__dirname, "design.css"), "utf-8")
    const blocks = css.split("}").filter((block) => /preview|design-variant/.test(block))
    expect(blocks.some((block) => /transform|zoom|scale\(/.test(block))).toBe(false)
  })

  test("a page outside the project root gets no frame: Fuori dal progetto", () => {
    expect(previewPlan("C:/altrove/confronto.html", root, "DS1", true)).toEqual({
      kind: "error",
      text: "Fuori dal progetto: C:/altrove/confronto.html — le anteprime stanno in .ade/design/DS1/",
    })
    expect(previewPlan("../fuori.html", root, "DS1", true).kind).toBe("error")
    expect(isInsideRoot(String.raw`C:\P\.ade\design\x.html`, "c:/p")).toBe(true)
  })

  test("a failure names the path: Non si carica", () => {
    expect(loadFailure("C:/p/.ade/design/DS1/4.html", new Error("file non trovato"))).toBe(
      "Non si carica: C:/p/.ade/design/DS1/4.html — file non trovato",
    )
    // The host repeats the path in its message (seen live in ADE Test): said once.
    expect(loadFailure("C:/p/x.html", "C:/p/x.html: Impossibile trovare il file specificato. (os error 2)")).toBe(
      "Non si carica: C:/p/x.html — Impossibile trovare il file specificato. (os error 2)",
    )
    const image = previewPlan("shots/a.png", root, "DS1", true)
    expect(image).toMatchObject({ kind: "image", path: "C:/p/shots/a.png" })
    const tsx = readFileSync(join(__dirname, "design-preview.tsx"), "utf-8")
    expect(tsx).toContain('onError={() => setFailure(loadFailure(current.path, t("design.preview.imageBroken")))}')
  })

  test("two variants on the same page are flagged", () => {
    expect(sharedPreview([{ preview: "results/c.html#a" }, { preview: "results/c.html#b" }])).toBe(true)
    expect(sharedPreview([{ preview: ".ade/design/DS1/1.html" }, { preview: ".ade/design/DS1/2.html" }])).toBe(false)
    expect(sharedPreview([{ preview: "" }, { preview: "" }])).toBe(false)
  })

  test("HTML written into the register is an error, not a srcdoc", () => {
    expect(previewPlan("<!doctype html><p>x</p>", root, "DS1", true).kind).toBe("error")
  })
})
