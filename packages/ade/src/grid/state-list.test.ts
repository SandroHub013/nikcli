import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { translate } from "../i18n"
import { STATE_FULL, STATE_IDS, STATE_SHORT, cleanStateDetail, stateOfSession } from "./pane-state"

/*
 * DS-1, UX-6, UX-7, UX-8, DS-18: a session has one state, said in one list.
 *
 * Before, three vocabularies named it (`data-status`, `data-st`, and six
 * Italian sentences used as the sidebar's data values), with three colour maps:
 * the same session was pomodoro in the sidebar and blue in its own pane header,
 * and in English the tooltip said «Status: a lavoro». Now the ids live in
 * `pane-state.ts`; the sidebar and the pane read them, and every id must have
 * its two languages, its colour, its shape and its rule in both sheets.
 */

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf-8")
const paneCss = read("grid", "pane.css")
const sidebarCss = read("sidebar", "sidebar.css")
const indexCss = read("index.css")
const iconSource = read("grid", "state-icon.tsx")
const sidebarSource = read("sidebar", "sidebar.tsx")
const paneSource = read("grid", "pane.tsx")
const treeSource = read("sidebar", "workspace-tree.ts")

describe("the list", () => {
  test("it has the six states of the audit, and the two that have no process", () => {
    expect([...STATE_IDS]).toEqual(["work", "perm", "ask", "err", "limit", "idle", "off", "closed"])
  })

  test("every state has its words, in Italian and in English, and they are not the same words", () => {
    for (const id of STATE_IDS) {
      for (const key of [`paneState.${id}`] as const) {
        const it = translate("it", key as never)
        const en = translate("en", key as never)
        expect([id, it.length > 0, en.length > 0]).toEqual([id, true, true])
        expect([id, it === en]).toEqual([id, false])
      }
      expect([id, STATE_FULL[id].length > 0]).toEqual([id, true])
      expect([id, STATE_SHORT[id].length > 0]).toEqual([id, true])
    }
  })

  test("the sidebar's name for the icon wraps the state's word, in the language of the window", () => {
    expect(translate("it", "sidebar.agentStatus", "Al lavoro")).toBe("Stato: Al lavoro")
    expect(translate("en", "sidebar.agentStatus", translate("en", "paneState.work"))).toBe("Status: Working")
    // No Italian word is left in the English sentence.
    for (const id of STATE_IDS) {
      const word = translate("en", `paneState.${id}` as never)
      expect(translate("en", "sidebar.agentStatus", word)).toBe(`Status: ${word}`)
    }
  })
})

describe("the sidebar and the pane read the same list", () => {
  test("the sidebar resolves a session with the pane's own function", () => {
    expect(sidebarSource).toContain("stateOfSession")
    expect(sidebarSource).toContain('from "../grid/pane-state"')
    expect(paneSource).toContain("resolvePaneState")
    expect(paneSource).toContain('from "./pane-state"')
    // Both draw the same icon.
    expect(sidebarSource).toContain('import { StateIcon } from "../grid/state-icon"')
    expect(paneSource).toContain('from "./state-icon"')
  })

  test("a session is one state whoever asks", () => {
    expect(stateOfSession({ status: "working" })).toBe("work")
    expect(stateOfSession({ status: "provisioning" })).toBe("work")
    expect(stateOfSession({ status: "waiting" })).toBe("perm")
    expect(stateOfSession({ status: "waiting", activity: "ade-msg ask a «Fabio»" })).toBe("ask")
    expect(stateOfSession({ status: "error" })).toBe("err")
    expect(stateOfSession({ status: "idle" })).toBe("idle")
    expect(stateOfSession({ status: "done" })).toBe("idle")
    expect(stateOfSession({ status: "working", suspended: true })).toBe("off")
  })

  test("no Italian sentence is a state value any more", () => {
    for (const phrase of ["a lavoro", "in attesa di input", "task completata", "disponibile", "sospesa"]) {
      expect([phrase, sidebarSource.includes(`"${phrase}"`)]).toEqual([phrase, false])
      expect([phrase, treeSource.includes(`"${phrase}"`)]).toEqual([phrase, false])
      expect([phrase, sidebarCss.includes(`"${phrase}"`)]).toEqual([phrase, false])
    }
    expect(sidebarSource).not.toContain("data-agent-status")
    expect(sidebarCss).not.toContain("data-agent-status")
    expect(treeSource).not.toContain("mapAgentStatus")
  })

  test("every state has its colour token, its shape, and its rule in both sheets", () => {
    for (const id of STATE_IDS) {
      expect([id, new RegExp(`--ade-state-${id}:`).test(indexCss)]).toEqual([id, true])
      expect([id, iconSource.includes(`props.state === "${id}"`)]).toEqual([id, true])
      expect([id, sidebarCss.includes(`[data-slot="agent-status-dot"][data-state="${id}"]`)]).toEqual([id, true])
      expect([id, paneCss.includes(`[data-component="session-pane"][data-state="${id}"]`)]).toEqual([id, true])
    }
    // The pane reads the shared tokens, not colours of its own.
    for (const id of ["work", "perm", "ask", "err", "limit", "idle"]) {
      expect(paneCss).toContain(`--st: var(--ade-state-${id});`)
    }
    expect(paneCss).not.toContain("--st-ask")
    expect(paneCss).not.toContain("--st-limit")
  })

  test("«needs you» is blue everywhere, and pomodoro is not a state colour", () => {
    expect(indexCss).toMatch(/--ade-state-perm:\s*var\(--ade-waiting\);/)
    const tokens = [...indexCss.matchAll(/--ade-state-[a-z]+:\s*([^;]+);/g)].map((match) => match[1]!)
    expect(tokens.length).toBe(STATE_IDS.length)
    expect(tokens.filter((value) => /accent/.test(value))).toEqual([])
    const sidebarStates = sidebarCss.slice(sidebarCss.indexOf("The state of a session"))
    expect(sidebarStates.slice(0, sidebarStates.indexOf("Card Meta"))).not.toContain("--ade-accent")
  })
})

describe("the sidebar tells the state by shape and by name, not by colour alone", () => {
  test("the icon is a named image inside the row's button", () => {
    const icon = sidebarSource.slice(sidebarSource.indexOf("function StatusIcon"), sidebarSource.indexOf("function SessionChildRow"))
    expect(icon).toContain('role="img"')
    expect(icon).toContain('aria-label={t("sidebar.agentStatus", STATE_FULL[props.state])}')
    expect(icon).toContain("<StateIcon state={props.state} />")
    // Both kinds of row use it.
    expect(sidebarSource.match(/<StatusIcon state=\{state\(\)\} \/>/g)?.length).toBe(2)
  })

  test("the eight shapes are distinct drawings", () => {
    const shapes = STATE_IDS.map((id) => {
      const match = new RegExp(`props.state === "${id}"\\}>([\\s\\S]*?)</Match>`).exec(iconSource)
      return match?.[1]?.replace(/\s+/g, " ").trim()
    })
    expect(shapes.every(Boolean)).toBe(true)
    expect(new Set(shapes).size).toBe(STATE_IDS.length)
  })
})

describe("the chip says what to do, not what the terminal scraped (UX-8, DS-18)", () => {
  test("a permission prompt has fixed words that say the answer goes in the terminal", () => {
    expect(translate("it", "paneState.perm.here")).toBe("rispondi nel terminale")
    expect(translate("it", "paneState.perm.tip")).toBe(
      "La sessione ti chiede un permesso: scegli la risposta nel terminale con le frecce e Invio",
    )
    expect(translate("en", "paneState.perm.here")).toBe("answer in the terminal")
    expect(paneSource).toContain('if (answerInTerminal()) return t("paneState.perm.here")')
    // Not for a pane whose own buttons make it a «perm»: its label is theirs.
    expect(paneSource).toContain('const answerInTerminal = () => state() === "perm" && !hasActions()')
  })

  test("the screenshot's chip text becomes one clean word", () => {
    expect(cleanStateDetail("Mustering…Mustering…✻Mustering…3Musterin")).toBe("Mustering…")
    expect(cleanStateDetail("✻ Mustering… (12s)")).toBe("Mustering… (12s)")
    expect(cleanStateDetail("Edit · pane.css")).toBe("Edit pane.css")
    expect(cleanStateDetail("⠋ ⠙ ⠹")).toBe("")
    expect(cleanStateDetail(undefined)).toBe("")
  })

  test("the detail is bounded with an ellipsis, and its full text stays in the tooltip", () => {
    expect(paneCss).toMatch(/\.hA \.a-det \{[^}]*max-width: 24ch;/)
    expect(paneSource).toContain("data-tip={tipState()}")
  })
})

describe("motion lives in the sidebar, once (DS-5)", () => {
  const animationLines = (css: string) => css.split("\n").filter((line) => /^\s*animation(-name)?:/.test(line))

  test("the pane's chip and icon do not move, and nothing blinks with steps()", () => {
    expect(paneCss).not.toMatch(/\.ic-[a-z]+\s*\{/)
    expect(paneCss).not.toContain("ade-spin")
    expect(paneCss).not.toContain("ade-attn")
    expect(paneCss).not.toContain("ade-pane-halo")
    expect(paneCss).not.toContain("steps(")
    expect(sidebarCss).not.toContain("steps(")
  })

  test("every loop of the pane and the sidebar's states runs at the loop token", () => {
    for (const line of [...animationLines(paneCss), ...animationLines(sidebarCss)].filter((one) => /infinite/.test(one))) {
      expect(line).toContain("var(--ade-loop)")
      expect(line).toContain("var(--ade-loops, running)")
    }
  })

  test("«working» breathes in the sidebar, and only «working», and not with reduced motion", () => {
    const rules = sidebarCss.slice(sidebarCss.indexOf("The one motion of a session's state"))
    const media = rules.slice(rules.indexOf("@media"), rules.indexOf("@keyframes ade-state-breathe"))
    expect(media).toContain("(prefers-reduced-motion: no-preference)")
    expect(media).toContain('[data-state="work"] .ic')
    expect(media.match(/animation:/g)?.length).toBe(1)
    for (const id of STATE_IDS.filter((one) => one !== "work")) {
      expect([id, media.includes(`data-state="${id}"`)]).toEqual([id, false])
    }
    // No old ripple, no pulse at 1.4s or 1.6s.
    expect(sidebarCss).not.toContain("ade-agent-pulse")
    expect(sidebarCss).not.toContain("ade-agent-ripple")
  })

  test("the loop token is one slow breathe", () => {
    expect(indexCss).toMatch(/--ade-loop:\s*2\.4s;/)
    expect(indexCss).toMatch(/--ade-loop-ease:\s*ease-in-out;/)
  })

  test("the attention dot in the bar rests after three cycles, and is steady with reduced motion", () => {
    const pill = read("ui", "pill-tabs.css")
    expect(pill).toContain("animation: ade-pill-pulse var(--ade-loop) var(--ade-loop-ease) 3 var(--ade-loops, running);")
    expect(pill.slice(pill.indexOf("It pulses three times"))).toContain("(prefers-reduced-motion: no-preference)")
    expect(pill).not.toMatch(/ade-pill-pulse 1\.2s/)
  })
})

describe("no flicker from filters over live content (DS-6)", () => {
  test("the header pill and the glass shell carry no backdrop-filter", () => {
    expect(paneCss).not.toMatch(/(^|[\s-])backdrop-filter\s*:/m)
    expect(indexCss).not.toMatch(/(^|[\s-])backdrop-filter\s*:\s*blur/m)
  })

  test("the pill is near opaque instead: 92% of its ground", () => {
    expect(paneCss.match(/color-mix\(in srgb, [^;]*?92%, transparent\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(paneCss).not.toMatch(/var\(--ade-raised\) (78|90)%/)
  })

  test("in light the lifted pill is grounded in a crema step with a border ring (DS-24)", () => {
    expect(paneCss).toContain("light-dark(var(--ade-surface), var(--ade-raised)) 92%")
    expect(paneCss).toContain("inset 0 0 0 1px light-dark(var(--ade-border), rgba(255, 255, 255, 0.06))")
  })
})

describe("the header keeps four things (DS-19)", () => {
  const header = paneSource.slice(paneSource.indexOf('data-slot="pane-header"'), paneSource.indexOf("</header>"))
  const card = header.slice(header.indexOf('data-slot="pane-card"'))
  const outside = header.slice(0, header.indexOf('data-slot="pane-info"'))

  test("title, state chip and cost stay in the pill", () => {
    expect(outside).toContain('data-slot="pane-title"')
    expect(outside).toContain("a-state")
    expect(outside).toContain('data-slot="pane-cost"')
  })

  test("quota, mode, folder and tokens moved into the card", () => {
    for (const marker of ['class="a-q"', 'data-slot="pane-mode"', 'data-slot="pane-tree"', 'data-slot="pane-tokens"']) {
      expect([marker, outside.includes(marker), card.includes(marker)]).toEqual([marker, false, true])
    }
  })

  test("the card opens by hover and by keyboard focus, and closes with Escape", () => {
    expect(paneCss).toContain(".hA .info:hover .card")
    expect(paneCss).toContain(".hA .info:has(:focus-visible) .card")
    expect(header).toContain('event.key !== "Escape"')
    // The trigger is a real button with a name, and describes itself by the card.
    expect(header).toContain('data-slot="pane-info-trigger"')
    expect(header).toContain("aria-describedby={cardId}")
    expect(translate("it", "pane.details")).toBe("Dettagli della sessione")
    expect(translate("en", "pane.details")).toBe("Session details")
  })

  test("the card is not hidden by the header's collapse rules", () => {
    const queries = paneCss.slice(paneCss.indexOf("Container queries (collapse order"))
    for (const selector of [".a-q", ".a-mode", ".a-br", ".qbar", ".qk", ".qr", ".ct"]) {
      expect([selector, queries.includes(`.hA ${selector}`)]).toEqual([selector, false])
    }
  })
})

describe("a selected sidebar row keeps its meta readable (DS-22)", () => {
  test("the meta takes the soft text on the selection's veil", () => {
    expect(sidebarCss).toMatch(/\[data-slot="session-row"\]\[data-selected\] :is\(\[data-slot="session-meta"\]/)
    expect(sidebarCss).toMatch(/\[data-slot="active-agent-card"\]\[data-selected\]\s+:is\(\[data-slot="active-agent-meta"\]/)
  })
})
