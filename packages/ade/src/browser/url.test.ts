import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addressForTake, addressNeedsCover, isAdeOrigin, isValidBrowserUrl, normalizeUrl } from "./url"
import { RECORDING_ATTRIBUTE } from "../record/sensitive"

describe("normalizeUrl", () => {
  describe("port shorthands", () => {
    test("normalizes numeric string into localhost URL", () => {
      expect(normalizeUrl("3000")).toBe("http://localhost:3000")
      expect(normalizeUrl("5173")).toBe("http://localhost:5173")
      expect(normalizeUrl("8080")).toBe("http://localhost:8080")
      expect(normalizeUrl("80")).toBe("http://localhost:80")
    })

    test("normalizes numeric string with path and query", () => {
      expect(normalizeUrl("3000/api/v1")).toBe("http://localhost:3000/api/v1")
      expect(normalizeUrl("5173/dashboard?tab=analytics#overview")).toBe(
        "http://localhost:5173/dashboard?tab=analytics#overview",
      )
    })

    test("normalizes colon-prefixed port shorthand", () => {
      expect(normalizeUrl(":3000")).toBe("http://localhost:3000")
      expect(normalizeUrl(":5173")).toBe("http://localhost:5173")
      expect(normalizeUrl(":8080/settings")).toBe("http://localhost:8080/settings")
    })

    test("refuses ports outside 1..65535", () => {
      expect(normalizeUrl("0")).toBeUndefined()
      expect(normalizeUrl("65536")).toBeUndefined()
      expect(normalizeUrl("99999")).toBeUndefined()
      expect(normalizeUrl(":0")).toBeUndefined()
      expect(normalizeUrl(":65536")).toBeUndefined()
      expect(normalizeUrl(":-1")).toBeUndefined()
      expect(normalizeUrl("-500")).toBeUndefined()
    })
  })

  describe("hosts and domains without scheme", () => {
    test("normalizes localhost and IP addresses", () => {
      expect(normalizeUrl("localhost")).toBe("http://localhost/")
      /*
       * The canonical form, which is what `new URL` produces: an empty path
       * is written as `/`. The function used to validate the parsed URL and
       * then return the raw string it was handed, so anything `new URL`
       * would have percent-encoded came out intact — see the escaping test
       * below for why that mattered.
       */
      expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/")
      expect(normalizeUrl("localhost:5173/app")).toBe("http://localhost:5173/app")
      expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/")
      expect(normalizeUrl("0.0.0.0:3000")).toBe("http://0.0.0.0:3000/")
      expect(normalizeUrl("[::1]:3000")).toBe("http://[::1]:3000/")
    })

    test("normalizes domain names", () => {
      expect(normalizeUrl("example.com")).toBe("http://example.com/")
      expect(normalizeUrl("example.com/test")).toBe("http://example.com/test")
      expect(normalizeUrl("sub.domain.org:8080/path?query=1")).toBe(
        "http://sub.domain.org:8080/path?query=1",
      )
      expect(normalizeUrl("my-app.local:3000")).toBe("http://my-app.local:3000/")
    })

    test("refuses invalid ports in host strings", () => {
      expect(normalizeUrl("localhost:0")).toBeUndefined()
      expect(normalizeUrl("localhost:65536")).toBeUndefined()
      expect(normalizeUrl("localhost:99999")).toBeUndefined()
      expect(normalizeUrl("example.com:70000")).toBeUndefined()
    })
  })

  describe("explicit http and https schemes", () => {
    test("preserves valid http and https URLs", () => {
      expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000/")
      expect(normalizeUrl("https://x.dev/a?b=c")).toBe("https://x.dev/a?b=c")
      expect(normalizeUrl("http://127.0.0.1:8080/api")).toBe("http://127.0.0.1:8080/api")
      // The default port for the scheme is dropped, as every browser does.
      expect(normalizeUrl("https://example.com:443/test#anchor")).toBe(
        "https://example.com/test#anchor",
      )
      expect(normalizeUrl("http://[::1]:3000")).toBe("http://[::1]:3000/")
    })

    test("handles case-insensitive scheme matching", () => {
      // Canonicalised, scheme included: `HTTP:` and `http:` are the same
      // scheme, and returning the typed casing meant two spellings of one
      // address compared unequal everywhere downstream.
      expect(normalizeUrl("HTTP://localhost:3000")).toBe("http://localhost:3000/")
      expect(normalizeUrl("HTTPS://x.dev/a?b=c")).toBe("https://x.dev/a?b=c")
    })

    test("refuses explicit http/https with invalid ports", () => {
      expect(normalizeUrl("http://localhost:0")).toBeUndefined()
      expect(normalizeUrl("http://localhost:65536")).toBeUndefined()
      expect(normalizeUrl("https://example.com:99999")).toBeUndefined()
    })

    /*
     * The function validated the parsed URL and returned the *raw* string,
     * so every character `new URL` would have percent-encoded survived.
     * `loadMirror` interpolates the result into `<base href="…">` with no
     * escaping, so a double quote closed the attribute and the rest became
     * markup in a document that — before the sandbox was fixed — ran in
     * ADE's own origin.
     */
    test("escapes what an attribute would otherwise let out", () => {
      const out = normalizeUrl('http://localhost:3000/"><script>alert(1)</script>')
      expect(out).toBeDefined()
      expect(out).not.toContain('"')
      expect(out).not.toContain("<")
      expect(out).not.toContain(">")
      expect(out).toContain("%22")
    })

    /*
     * `http://localhost:3000@evil.com/` is a valid URL whose host is
     * evil.com — everything before the `@` is a username. The address bar
     * showed the part the eye stops at, the frame loaded the other site, and
     * the whole string reached the agent's prompt through
     * `formatSelectionContext`, telling the agent it was on localhost too.
     */
    test("refuses the userinfo form, which is a disguise and not a credential", () => {
      expect(normalizeUrl("http://localhost:3000@evil.com/")).toBeUndefined()
      expect(normalizeUrl("https://user:pass@example.com/")).toBeUndefined()
      expect(normalizeUrl("localhost:3000@evil.com")).toBeUndefined()
    })
  })

  describe("rejected schemes and dangerous inputs", () => {
    test("rejects javascript: scheme in any case or format", () => {
      expect(normalizeUrl("javascript:alert(1)")).toBeUndefined()
      expect(normalizeUrl("JAVASCRIPT:void(0)")).toBeUndefined()
      expect(normalizeUrl("javascript:/*comment*/alert(1)")).toBeUndefined()
      expect(normalizeUrl("  javascript:alert(document.cookie)  ")).toBeUndefined()
      expect(normalizeUrl("java\u0000script:alert(1)")).toBeUndefined()
    })

    test("rejects data: scheme", () => {
      expect(normalizeUrl("data:text/html,<h1>test</h1>")).toBeUndefined()
      expect(normalizeUrl("DATA:text/plain;base64,SGVsbG8=")).toBeUndefined()
    })

    test("rejects file: scheme", () => {
      expect(normalizeUrl("file:///etc/passwd")).toBeUndefined()
      expect(normalizeUrl("file:///C:/Windows/System32")).toBeUndefined()
      expect(normalizeUrl("FILE:///path/to/file")).toBeUndefined()
    })

    test("rejects vbscript: scheme", () => {
      expect(normalizeUrl("vbscript:msgbox('hi')")).toBeUndefined()
      expect(normalizeUrl("VBSCRIPT:test")).toBeUndefined()
    })

    test("rejects other non-http schemes", () => {
      expect(normalizeUrl("ftp://ftp.example.com/file")).toBeUndefined()
      expect(normalizeUrl("ws://localhost:3000")).toBeUndefined()
      expect(normalizeUrl("wss://localhost:3000")).toBeUndefined()
      expect(normalizeUrl("blob:https://example.com/uuid")).toBeUndefined()
      expect(normalizeUrl("about:blank")).toBeUndefined()
      expect(normalizeUrl("chrome://settings")).toBeUndefined()
      expect(normalizeUrl("mailto:test@example.com")).toBeUndefined()
    })
  })

  describe("malformed and empty inputs", () => {
    test("refuses empty or whitespace strings", () => {
      expect(normalizeUrl("")).toBeUndefined()
      expect(normalizeUrl("   ")).toBeUndefined()
      expect(normalizeUrl("\t\n")).toBeUndefined()
    })

    test("refuses strings with spaces in host", () => {
      expect(normalizeUrl("foo bar:3000")).toBeUndefined()
      expect(normalizeUrl("not a url at all")).toBeUndefined()
    })

    test("refuses incomplete scheme inputs", () => {
      expect(normalizeUrl("http://")).toBeUndefined()
      expect(normalizeUrl("https://")).toBeUndefined()
      expect(normalizeUrl("http:// ")).toBeUndefined()
    })
  })
})

describe("isValidBrowserUrl", () => {
  test("returns true for valid URLs", () => {
    expect(isValidBrowserUrl("3000")).toBe(true)
    expect(isValidBrowserUrl(":5173")).toBe(true)
    expect(isValidBrowserUrl("localhost:3000")).toBe(true)
    expect(isValidBrowserUrl("https://x.dev/a?b=c")).toBe(true)
    expect(isValidBrowserUrl("example.com")).toBe(true)
  })

  test("returns false for invalid or rejected URLs", () => {
    expect(isValidBrowserUrl("")).toBe(false)
    expect(isValidBrowserUrl("javascript:alert(1)")).toBe(false)
    expect(isValidBrowserUrl("file:///etc/passwd")).toBe(false)
    expect(isValidBrowserUrl("65536")).toBe(false)
    expect(isValidBrowserUrl("ftp://example.com")).toBe(false)
  })
})

describe("isAdeOrigin", () => {
  test("the window's own origin is ADE, including a nested path", () => {
    expect(isAdeOrigin("http://localhost:5177/", "http://localhost:5177")).toBe(true)
    expect(isAdeOrigin("http://localhost:5177/index.html", "http://localhost:5177")).toBe(true)
    expect(isAdeOrigin("http://tauri.localhost/x", "http://tauri.localhost")).toBe(true)
  })

  test("tauri.localhost is ADE even when the window is the Vite server", () => {
    expect(isAdeOrigin("http://tauri.localhost/", "http://localhost:5177")).toBe(true)
    expect(isAdeOrigin("https://tauri.localhost/app", "http://localhost:5270")).toBe(true)
  })

  test("the media scheme is ADE in all three spellings (audit 0.7.7, C1)", () => {
    for (const host of ["http://tauri.localhost", "http://localhost:5177"]) {
      expect(isAdeOrigin("http://ade-media.localhost/C%3A%2Fp%2Fvariant.html", host)).toBe(true)
      expect(isAdeOrigin("https://ade-media.localhost/C%3A%2Fp%2F.env", host)).toBe(true)
      expect(isAdeOrigin("ade-media://localhost/C%3A%2Fp%2Fdrawing.svg", host)).toBe(true)
      expect(isAdeOrigin("HTTP://ADE-MEDIA.LOCALHOST/x", host)).toBe(true)
    }
    // A site whose name only contains it is not.
    expect(isAdeOrigin("https://ade-media.localhost.example.com/", "http://tauri.localhost")).toBe(false)
  })

  test("another origin is not ADE", () => {
    expect(isAdeOrigin("http://localhost:5173/", "http://localhost:5177")).toBe(false)
    expect(isAdeOrigin("https://bastelli-cmp.vercel.app/", "http://tauri.localhost")).toBe(false)
    expect(isAdeOrigin("not a url", "http://tauri.localhost")).toBe(false)
  })
})

describe("a take on the browser pane (D78)", () => {
  test("addressForTake: origin and path only, strips credentials, query and fragment", () => {
    // 1. https://u:p@h.com/a?token=x#y -> https://h.com/a
    expect(addressForTake("https://u:p@h.com/a?token=x#y")).toBe("https://h.com/a")

    // 2. http://localhost:3000/ resta com'è
    expect(addressForTake("http://localhost:3000/")).toBe("http://localhost:3000/")

    // 3. un indirizzo non valido dà ""
    expect(addressForTake("")).toBe("")
    expect(addressForTake("not a url")).toBe("")
    expect(addressForTake(":::")).toBe("")
    expect(addressForTake("javascript:alert(1)")).toBe("")

    // 4. un percorso lungo si tronca
    const longPath = "/path/" + "x".repeat(100)
    const truncated = addressForTake(`https://example.com${longPath}`)
    expect(truncated).toContain("…")
    expect(truncated).toStartWith("https://example.com/path/")

    // 5. il risultato non contiene mai @, ? o #
    const checks = [
      "https://u:p@h.com/a?token=x#y",
      "http://user:pass@localhost:3000/?foo=bar#section",
      "https://user@test.org/p?q=1#h",
    ]
    for (const url of checks) {
      const res = addressForTake(url)
      expect(res).not.toContain("@")
      expect(res).not.toContain("?")
      expect(res).not.toContain("#")
    }

    // Special schemes: about:blank, data:, blob:
    expect(addressForTake("about:blank")).toBe("about:")
    expect(addressForTake("data:text/html,<h1>hi</h1>")).toBe("data:")
    expect(addressForTake("blob:https://example.com/uuid")).toBe("blob:")
  })

  test("addressNeedsCover: true for credentials, queries and secrets; false for clean localhost", () => {
    // vero con user:pass@, con ?q= e con DB_PASS=… incollato
    expect(addressNeedsCover("user:pass@")).toBe(true)
    expect(addressNeedsCover("https://user:pass@example.com/")).toBe(true)
    expect(addressNeedsCover("?q=")).toBe(true)
    expect(addressNeedsCover("http://localhost:5173/?q=secret")).toBe(true)
    expect(addressNeedsCover("DB_PASS=hunter2hunter2")).toBe(true)

    // falso con http://localhost:5173/
    expect(addressNeedsCover("http://localhost:5173/")).toBe(false)
    expect(addressNeedsCover("http://localhost:3000")).toBe(false)
  })

  test("recording veil CSS: flex and frame hidden under data-ade-recording; veil none and frame visible without", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")

    // Verify rules exist in index.css
    const veilDefault = css.slice(css.indexOf('[data-slot="browser-record-veil"]'))
    const veilDefaultBody = veilDefault.slice(veilDefault.indexOf("{"), veilDefault.indexOf("}"))
    expect(veilDefaultBody).toMatch(/display:\s*none/)

    const veilRecording = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}] [data-slot="browser-record-veil"]`))
    const veilRecordingBody = veilRecording.slice(veilRecording.indexOf("{"), veilRecording.indexOf("}"))
    expect(veilRecordingBody).toMatch(/display:\s*flex/)
    expect(veilRecordingBody).toMatch(/position:\s*absolute/)
    expect(veilRecordingBody).toMatch(/inset:\s*0/)
    expect(veilRecordingBody).toMatch(/background:\s*var\(--ade-bg\)/)

    const frameRecording = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}] [data-slot="browser-frame"]`))
    const frameRecordingBody = frameRecording.slice(frameRecording.indexOf("{"), frameRecording.indexOf("}"))
    expect(frameRecordingBody).toMatch(/visibility:\s*hidden/)

    // Matcher test with and without data-ade-recording on <html>
    const veilSelector = `html[${RECORDING_ATTRIBUTE}] [data-slot="browser-record-veil"]`
    const frameSelector = `html[${RECORDING_ATTRIBUTE}] [data-slot="browser-frame"]`
    const defaultVeilSelector = `[data-slot="browser-record-veil"]`

    // Drawn again after each change to <html>: happy-dom keeps an element's match across an ancestor's attribute change.
    const draw = () => {
      document.body.innerHTML = `
        <div data-slot="browser-viewport-container">
          <div data-slot="browser-record-veil" id="test-veil"></div>
          <iframe data-slot="browser-frame" id="test-frame"></iframe>
        </div>
      `
    }

    // Under recording: veil matches recording flex selector, frame matches recording hidden selector
    document.documentElement.setAttribute(RECORDING_ATTRIBUTE, "")
    draw()
    const veilEl1 = document.getElementById("test-veil")!
    const frameEl1 = document.getElementById("test-frame")!
    expect(veilEl1.matches(veilSelector)).toBe(true)
    expect(frameEl1.matches(frameSelector)).toBe(true)

    // Without recording: veil matches display:none selector, neither matches recording selector
    document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
    draw()
    const veilEl2 = document.getElementById("test-veil")!
    const frameEl2 = document.getElementById("test-frame")!
    expect(veilEl2.matches(veilSelector)).toBe(false)
    expect(frameEl2.matches(frameSelector)).toBe(false)
    expect(veilEl2.matches(defaultVeilSelector)).toBe(true)

    document.body.innerHTML = ""
  })

  test("recording veil DOM: present on initial render of BrowserPane without Show", () => {
    // Structural check: the veil is a direct child of browser-viewport-container and not wrapped in a conditional <Show>
    const source = readFileSync(join(import.meta.dir, "browser-pane.tsx"), "utf8")
    expect(source).toMatch(/data-slot="browser-viewport-container">\s*<div data-slot="browser-record-veil"/)
    expect(source).not.toMatch(/<Show[^>]*>\s*<div data-slot="browser-record-veil"/)

    // The veil includes title and reduced address
    expect(source).toContain('data-slot="browser-record-veil-title"')
    expect(source).toContain('data-slot="browser-record-veil-url"')
    expect(source).toContain("addressForTake(url())")

    // Address bar input has data-sensitive tied to addressNeedsCover
    expect(source).toContain('data-sensitive={addressNeedsCover(inputUrl()) ? "" : undefined}')

    // In DOM, the veil element exists and contains the title text
    document.body.innerHTML = `
      <div data-slot="browser-viewport-container">
        <div data-slot="browser-record-veil">
          <span data-slot="browser-record-veil-title">Pagina nascosta durante la ripresa</span>
        </div>
      </div>
    `
    const veil = document.querySelector('[data-slot="browser-record-veil"]')
    expect(veil).not.toBeNull()
    expect(document.querySelector('[data-slot="browser-record-veil-title"]')?.textContent).toBe("Pagina nascosta durante la ripresa")
    document.body.innerHTML = ""
  })

  test("recording veil under glass theme: veil background is solid #131111 (alpha 1) while light/dark keep var(--ade-bg)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")

    // In [data-theme="glass"], container background is explicitly transparent:
    // line 136: --ade-bg: transparent;
    const glassSection = css.slice(css.indexOf('[data-theme="glass"]'))
    const glassSectionBody = glassSection.slice(glassSection.indexOf("{"), glassSection.indexOf("}"))
    expect(glassSectionBody).toMatch(/--ade-bg:\s*transparent/)

    // Rule 1: Default veil rule for light and dark themes keeps var(--ade-bg).
    // In light theme --ade-bg is #f4f2f0 and text is #1a1817 (dark text on light ground).
    // In dark theme --ade-bg is #131111 and text is #ecebeb (light text on dark ground).
    const defaultVeilRule = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}] [data-slot="browser-record-veil"]`))
    const defaultVeilBody = defaultVeilRule.slice(defaultVeilRule.indexOf("{"), defaultVeilRule.indexOf("}"))
    expect(defaultVeilBody).toMatch(/background:\s*var\(--ade-bg\)/)

    // Rule 2: In glass theme, --ade-bg is transparent, so an explicit override is declared
    // covering both html[data-theme="glass"] and [data-component="ade-shell"][data-theme="glass"].
    const glassVeilRule = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}][data-theme="glass"] [data-slot="browser-record-veil"]`))
    const glassVeilBody = glassVeilRule.slice(glassVeilRule.indexOf("{"), glassVeilRule.indexOf("}"))
    expect(glassVeilBody).toMatch(/background:\s*#131111/)

    // Verify #131111 is full 6-digit hex without alpha channel (solid, alpha 1).
    const bgMatch = glassVeilBody.match(/background:\s*(#[0-9a-fA-F]{6})/)
    expect(bgMatch).not.toBeNull()
    const hexColor = bgMatch![1]
    expect(hexColor).toBe("#131111")
    expect(hexColor.length).toBe(7) // # followed by 6 hex chars (alpha 1)

    // Selector matching check:
    // With data-theme="glass", element matches the glass veil selector.
    // In happy-dom, CSS variables declared across external stylesheets are not evaluated by getComputedStyle;
    // testing the selectors and stylesheet rules directly verifies the cascade behavior.
    const glassVeilSelectorRoot = `html[${RECORDING_ATTRIBUTE}][data-theme="glass"] [data-slot="browser-record-veil"]`
    const glassVeilSelectorInner = `html[${RECORDING_ATTRIBUTE}] [data-theme="glass"] [data-slot="browser-record-veil"]`

    // Case A: data-theme="glass" on <html>
    document.documentElement.setAttribute(RECORDING_ATTRIBUTE, "")
    document.documentElement.setAttribute("data-theme", "glass")
    document.body.innerHTML = `<div data-slot="browser-record-veil" id="veil-glass"></div>`
    const veilGlassRoot = document.getElementById("veil-glass")!
    expect(veilGlassRoot.matches(glassVeilSelectorRoot)).toBe(true)

    // Case B: data-theme="glass" on shell/inner container
    document.documentElement.removeAttribute("data-theme")
    document.body.innerHTML = `
      <div data-component="ade-shell" data-theme="glass">
        <div data-slot="browser-record-veil" id="veil-glass-inner"></div>
      </div>
    `
    const veilGlassInner = document.getElementById("veil-glass-inner")!
    expect(veilGlassInner.matches(glassVeilSelectorInner)).toBe(true)

    // Case C: light / dark themes do not match glass selector
    document.documentElement.setAttribute("data-theme", "light")
    document.body.innerHTML = `<div data-slot="browser-record-veil" id="veil-light"></div>`
    const veilLight = document.getElementById("veil-light")!
    expect(veilLight.matches(glassVeilSelectorRoot)).toBe(false)
    expect(veilLight.matches(glassVeilSelectorInner)).toBe(false)

    document.documentElement.removeAttribute("data-theme")
    document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
    document.body.innerHTML = ""
  })
})


