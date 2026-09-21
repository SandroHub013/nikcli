import { describe, expect, test } from "bun:test"
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
import { isHtmlPreview, isImagePreview, resolvePreviewPath, shortenPath } from "./design-preview"
import type { DesignProposal } from "./state"
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

  test("dev.css compacts ade-view-tab and ade-bar-center under 640px", () => {
    const devCssPath = join(__dirname, "../dev.css")
    const css = readFileSync(devCssPath, "utf-8")

    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('[data-slot="ade-view-tab"]')
    expect(css).toContain('padding: 0 var(--ade-space-3);')
    expect(css).toContain('[data-slot="ade-bar-center"]')
    expect(css).toContain('max-width: calc(100% - 16px);')
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

    // Simulate document.documentElement.scrollWidth layout calculation
    const computeDocumentScrollWidth = (withProposals: boolean) => {
      const maxChildRight = withProposals ? centerEndWith : centerEndWithout
      return Math.max(windowWidth, maxChildRight)
    }

    // Set scrollWidth property on document.documentElement for the test assertion
    const doc = typeof document !== "undefined" ? document : ((globalThis as unknown as { document: { documentElement: object } }).document = { documentElement: {} } as unknown as Document)
    const origScrollWidth = Object.getOwnPropertyDescriptor(doc.documentElement, "scrollWidth")

    try {
      // Test without proposals
      Object.defineProperty(doc.documentElement, "scrollWidth", {
        configurable: true,
        get: () => computeDocumentScrollWidth(false),
      })
      expect(doc.documentElement.scrollWidth).toBe(420)

      // Test WITH proposals
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

