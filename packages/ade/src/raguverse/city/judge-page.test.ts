import { beforeEach, describe, expect, test } from "bun:test"
import { beforeSide, judgePage, summarize, type JudgeData } from "./judge-page"

const NAMES = ["plaza", "aerial", "facade", "desk", "permission", "hologram", "street", "rise"]
const img = (tag: string) => `data:image/jpeg;base64,${tag}`

function data(over: Partial<JudgeData> = {}): JudgeData {
  return {
    title: "Tripla A · A1",
    seed: 7,
    generated: "2026-09-29",
    levels: ["bassa", "media"],
    shots: NAMES.map((name, i) => ({ n: i + 1, name, about: `about ${name}` })),
    images: ["bassa", "media"].flatMap((level) =>
      NAMES.map((_, i) => ({ level, n: i + 1, before: img(`${level}-b${i + 1}`), after: img(`${level}-a${i + 1}`) })),
    ),
    numbers: [
      { name: "GPU p95 (ms)", before: "9.1", after: "11.0", ok: true },
      { name: "burnt", before: "0.3 %", after: "2.4 %", ok: false },
      { name: "memory", before: "150 MB" },
    ],
    clips: { bassa: { before: "prima/bassa.webm", after: "dopo/bassa.webm" } },
    ...over,
  }
}

/** Puts the page in the document and runs its own script, the way a browser would. */
function mount(page: string) {
  const body = /<body>([\s\S]*?)<\/body>/.exec(page)![1]
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  const json = /<script type="application\/json" id="data">[\s\S]*?<\/script>/.exec(body)![0]
  // The document gets the markup and the data; the script is run by hand, once, as the browser would run it.
  document.body.innerHTML = body
    .replace(/<script>[\s\S]*?<\/script>/g, "")
    .replace(/<script type="application\/json" id="data">[\s\S]*?<\/script>/, "")
  const holder = document.createElement("script")
  holder.type = "application/json"
  holder.id = "data"
  holder.textContent = /<script type="application\/json" id="data">([\s\S]*)<\/script>/.exec(json)![1]
  document.body.append(holder)
  new Function(scripts[scripts.length - 1][1])()
}
const $ = (id: string) => document.getElementById(id) as HTMLElement
const click = (id: string) => $(id).dispatchEvent(new Event("click", { bubbles: true }))
const answers = () => JSON.parse(($("out") as HTMLTextAreaElement).value)

describe("the blind order", () => {
  test("it depends on the seed and the shot only, and is the same every time", () => {
    for (let n = 1; n <= 8; n++) expect(beforeSide(7, n)).toBe(beforeSide(7, n))
    const a = Array.from({ length: 8 }, (_, i) => beforeSide(1, i + 1))
    const b = Array.from({ length: 8 }, (_, i) => beforeSide(2, i + 1))
    expect(a).not.toEqual(b)
  })

  test("both sides come up, about half each, so the eye cannot learn which side is the «prima»", () => {
    let right = 0
    let total = 0
    for (let seed = 1; seed <= 500; seed++)
      for (let n = 1; n <= 8; n++) {
        right += beforeSide(seed, n)
        total++
      }
    expect(right / total).toBeGreaterThan(0.45)
    expect(right / total).toBeLessThan(0.55)
    // Not the same side for all eight shots, for nearly every seed.
    let mixed = 0
    for (let seed = 1; seed <= 200; seed++)
      if (new Set(Array.from({ length: 8 }, (_, i) => beforeSide(seed, i + 1))).size === 2) mixed++
    expect(mixed).toBeGreaterThan(190)
  })
})

describe("what the answers say", () => {
  const v = (o: Record<string, string>) => o
  test("closed with «meglio» on six of eight and no «peggio»", () => {
    expect(
      summarize(
        v({ 1: "meglio", 2: "meglio", 3: "meglio", 4: "meglio", 5: "meglio", 6: "meglio", 7: "uguale", 8: "uguale" }),
        8,
      ).closed,
    ).toBe(true)
    expect(
      summarize(
        v({ 1: "meglio", 2: "meglio", 3: "meglio", 4: "meglio", 5: "meglio", 6: "uguale", 7: "uguale", 8: "uguale" }),
        8,
      ).closed,
    ).toBe(false)
  })

  test("one «peggio» keeps it open, however many «meglio»", () => {
    const s = summarize(
      v({ 1: "meglio", 2: "meglio", 3: "meglio", 4: "meglio", 5: "meglio", 6: "meglio", 7: "meglio", 8: "peggio" }),
      8,
    )
    expect(s).toMatchObject({ meglio: 7, peggio: 1, closed: false })
  })

  test("the ones not answered are counted, and a value that is not an answer is not one", () => {
    const s = summarize(v({ 1: "meglio", 2: "boh", 3: "" }), 8)
    expect(s).toMatchObject({ meglio: 1, uguale: 0, peggio: 0, unanswered: 7 })
  })
})

describe("the page", () => {
  test("it is one file with eight shots, both levels, the numbers, the question and the export, and nothing from the network", () => {
    const page = judgePage(data())
    expect(page.match(/<section class="shot" id="shot-\d">/g)).toHaveLength(8)
    expect(page).toContain("È tripla A?")
    expect(page).toContain('id="out"')
    expect(page).toContain("GPU p95 (ms)")
    expect(page).toContain("media-a8")
    expect(page).not.toMatch(/(?:src|href)="https?:/)
    expect(page).not.toMatch(/<link\b/)
    expect(page).not.toMatch(/navigator\.clipboard/)
  })

  test("what comes from the data is escaped: a name that closes the script does not", () => {
    const page = judgePage(
      data({
        title: "<b>x</b>",
        shots: NAMES.map((n, i) => ({
          n: i + 1,
          name: i === 0 ? "</script><img src=x onerror=alert(1)>" : n,
          about: "a",
        })),
      }),
    )
    expect(page).not.toContain("</script><img")
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(page.match(/<\/script>/g)).toHaveLength(2)
  })

  test("the line separators of JSON are escaped too, which a script cannot hold raw", () => {
    const raw = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`
    const page = judgePage(data({ shots: NAMES.map((n, i) => ({ n: i + 1, name: i === 0 ? raw : n, about: "a" })) }))
    const json = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(page)![1]
    expect(json).not.toContain(String.fromCharCode(0x2028))
    expect(json).not.toContain(String.fromCharCode(0x2029))
    expect(JSON.parse(json).shots[0].name).toBe(raw)
  })
})

describe("the page at work", () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {}
  })

  test("it starts on the first level with the «prima» on the left and answers nothing", () => {
    mount(judgePage(data()))
    expect(($("l-1") as HTMLImageElement).getAttribute("src")).toBe(img("bassa-b1"))
    expect(($("r-1") as HTMLImageElement).getAttribute("src")).toBe(img("bassa-a1"))
    expect($("tl-1").textContent).toBe("prima")
    expect(answers().closed).toBe(false)
    expect(answers().counts.unanswered).toBe(8)
  })

  test("the level switch shows the other level's pictures", () => {
    mount(judgePage(data()))
    ;(document.querySelector('.tabs button[data-level="media"]') as HTMLElement).click()
    expect(($("l-3") as HTMLImageElement).getAttribute("src")).toBe(img("media-b3"))
    expect(($("r-3") as HTMLImageElement).getAttribute("src")).toBe(img("media-a3"))
  })

  test("six «meglio» and no «peggio» close it, and the export says so, with the note and «È tripla A?»", () => {
    mount(judgePage(data()))
    for (let n = 1; n <= 6; n++) click(`v-${n}-2`)
    click("v-7-1")
    click("v-8-1")
    const note = $("note") as HTMLTextAreaElement
    note.value = "bella"
    note.dispatchEvent(new Event("input", { bubbles: true }))
    ;(document.querySelector('.yn button[data-a="si"]') as HTMLElement).click()
    const out = answers()
    expect(out.closed).toBe(true)
    expect(out.counts).toEqual({ meglio: 6, uguale: 2, peggio: 0, unanswered: 0 })
    expect(out.tripleA).toBe("si")
    expect(out.note).toBe("bella")
    expect(out.verdicts[0]).toEqual({ shot: 1, name: "plaza", verdict: "meglio" })
    expect($("count").textContent).toContain("pezzo chiuso")
  })

  test("one «peggio» keeps it open", () => {
    mount(judgePage(data()))
    for (let n = 1; n <= 7; n++) click(`v-${n}-2`)
    click("v-8-0")
    expect(answers().closed).toBe(false)
    expect($("count").textContent).not.toContain("pezzo chiuso")
  })

  test("blind: the sides follow the seed, the labels are hidden, and the answers still speak of the «dopo»", () => {
    const seed = 7
    mount(judgePage(data({ seed })))
    const box = $("blind") as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event("change", { bubbles: true }))
    expect(document.body.classList.contains("blind")).toBe(true)
    for (let n = 1; n <= 8; n++) {
      const beforeLeft = beforeSide(seed, n) === 0
      expect(($("l-" + n) as HTMLImageElement).getAttribute("src")).toBe(img(`bassa-${beforeLeft ? "b" : "a"}${n}`))
    }
    click("v-1-2")
    expect(answers().blind).toBe(true)
    expect(answers().verdicts[0].verdict).toBe("meglio")
  })

  test("the answers survive a reload of the page", () => {
    mount(judgePage(data()))
    click("v-2-2")
    mount(judgePage(data()))
    expect(answers().verdicts[1].verdict).toBe("meglio")
  })

  test("«Azzera» clears them", () => {
    mount(judgePage(data()))
    click("v-2-2")
    click("reset")
    expect(answers().counts.unanswered).toBe(8)
  })
})
