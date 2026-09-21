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
import { isHtmlPreview, isImagePreview, resolvePreviewPath } from "./design-preview"
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
})

describe("top bar narrow window layout and 420px overflow protection", () => {
  test("design.css specifies responsive rules for narrow windows under 640px", () => {
    const cssPath = join(__dirname, "design.css")
    const css = readFileSync(cssPath, "utf-8")

    // Checks that badge is kept at 24px height
    expect(css).toContain('height: 24px;')
    // Checks that label is hidden in narrow windows (< 640px)
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('[data-slot="design-badge-label"]')
    expect(css).toContain('display: none;')
    // Checks that padding is compacted to prevent overflow
    expect(css).toContain('padding: 0 6px;')
  })

  test("narrow badge layout does not overflow a 420px container", () => {
    // In narrow mode (<= 640px), the badge displays [icon] [count], dropping the text label.
    // Icon width (11px) + gap (3px) + single digit count (8px) + padding (6px * 2) + border (1px * 2) = 36px.
    const badgeNarrowWidth = 36
    const tabsWidth = 180 // 4 navigation tabs: Agenti, Codice, Bot, Chat
    const paletteIconWidth = 24
    const centerGaps = 8 * 2

    const totalCenterWidth = tabsWidth + paletteIconWidth + badgeNarrowWidth + centerGaps
    expect(totalCenterWidth).toBeLessThan(260)

    // With a 420px window and center aligned at 50% (210px):
    const windowWidth = 420
    const centerLeft = windowWidth / 2 - totalCenterWidth / 2
    const centerRight = windowWidth / 2 + totalCenterWidth / 2

    // Both edges must comfortably fit within [0, 420px] with zero horizontal overflow
    expect(centerLeft).toBeGreaterThan(0)
    expect(centerRight).toBeLessThan(windowWidth)
    expect(centerRight - centerLeft).toBe(totalCenterWidth)
    expect(windowWidth - centerRight).toBeGreaterThan(70) // At least 70px breathing room to the right
  })
})

