import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/xterm"
import { releaseDisposed } from "./registry"

/*
 * A closed terminal stayed alive behind an IntersectionObserver WebView2
 * keeps after xterm disconnects it (P1-C5). `releaseDisposed` empties the
 * RenderService the observer's callback holds. Whether that frees the
 * terminal is measured live (Verifiche, five open/close cycles); these tests
 * hold the function and the private name it depends on.
 */
describe("releaseDisposed (P1-C5)", () => {
  test("empties the render service a disposed terminal leaves behind", () => {
    const service = { a: {}, b: [] as unknown[] }
    expect(releaseDisposed({ _core: { _renderService: service } })).toBe(true)
    expect(Object.keys(service)).toEqual([])
  })

  test("without the private field it does nothing and does not throw", () => {
    expect(releaseDisposed({})).toBe(false)
    expect(releaseDisposed({ _core: {} })).toBe(false)
    expect(releaseDisposed({ _core: { _renderService: null } })).toBe(false)
  })

  test("the installed xterm still has _core._renderService: an update that renames it fails here", () => {
    const terminal = new Terminal()
    const host = document.createElement("div")
    document.body.append(host)
    try {
      terminal.open(host)
      const service = (terminal as unknown as { _core?: { _renderService?: object } })._core?._renderService
      expect(typeof service).toBe("object")
      terminal.dispose()
      expect(releaseDisposed(terminal)).toBe(true)
      expect(Object.keys(service!)).toEqual([])
    } finally {
      host.remove()
    }
  })
})
