import { describe, expect, test } from "bun:test"
import { mediaUrl } from "../video/video"
import { designPathOf, designUrlFor } from "./design-url"

/*
 * D1: in Design mode the browser pane shows only a design page of an open
 * project. Everything else the media scheme could serve — `.env`, the
 * registers, source — never becomes the frame's address.
 */

const WIN = "C:\\Users\\x\\app"
const POSIX = "/home/x/app"
const roots = [WIN, POSIX]

describe("designUrlFor refuses", () => {
  const refused: [string, string][] = [
    [".env at the root", "C:\\Users\\x\\app\\.env"],
    ["the decisions register", "C:/Users/x/app/.ade/decisions.jsonl"],
    ["a climb out of .ade/design", "C:/Users/x/app/.ade/design/../../.env"],
    ["a climb on POSIX", "/home/x/app/.ade/design/../../.env.html"],
    ["a percent-encoded climb", "C:/Users/x/app/.ade/design/%2e%2e/%2e%2e/.env"],
    ["a percent-encoded name", "C:/Users/x/app/.ade/design/DS-A/%31.html"],
    ["a dot segment", "C:/Users/x/app/.ade/design/./DS-A/1.html"],
    ["an .html outside .ade/design", "C:/Users/x/app/public/index.html"],
    ["an .html in .ade but not in design", "C:/Users/x/app/.ade/results/r.html"],
    ["a project that is not open", "C:/Users/x/other/.ade/design/DS-A/1.html"],
    ["an .svg under .ade/design", "C:/Users/x/app/.ade/design/DS-A/logo.svg"],
    ["a .js under .ade/design", "C:/Users/x/app/.ade/design/DS-A/inspect.js"],
    ["the design folder itself", "C:/Users/x/app/.ade/design/"],
    ["a name that only starts like the root", "C:/Users/x/App-old/.ade/design/DS-A/1.html"],
    ["the same name in other case, on another root", "/home/x/APP/.ade/design/DS-A/1.html"],
    ["a relative path", ".ade/design/DS-A/1.html"],
    ["a doubled separator", "C:/Users/x/app/.ade//design/DS-A/1.html"],
    ["a NUL", "C:/Users/x/app/.ade/design/DS-A/1.html\u0000.png"],
    ["an empty path", ""],
  ]
  for (const [label, path] of refused) {
    test(label, () => expect(designUrlFor(path, roots)).toBeUndefined())
  }

  test("with no project open, nothing", () => {
    expect(designUrlFor("C:/Users/x/app/.ade/design/DS-A/1.html", [])).toBeUndefined()
  })
})

describe("designUrlFor accepts a design page, as mediaUrl gives it", () => {
  test("a root with backslashes", () => {
    const path = "C:\\Users\\x\\app\\.ade\\design\\DS-A\\1.html"
    expect(designUrlFor(path, roots, true)).toBe(mediaUrl(path, true))
  })

  test("a root with forward slashes, and Windows case", () => {
    const path = "c:/users/x/APP/.ade/design/DS-A/2.htm"
    expect(designUrlFor(path, ["C:/Users/x/app"], true)).toBe(mediaUrl(path, true))
  })

  test("a POSIX root, a path with spaces and accents", () => {
    const path = "/home/x/app/.ade/design/Proposta più bella/1.html"
    expect(designUrlFor(path, roots, false)).toBe(mediaUrl(path, false))
  })

  test("a trailing slash on the root does not matter", () => {
    const path = "/home/x/app/.ade/design/DS-A/1.html"
    expect(designUrlFor(path, ["/home/x/app/"], false)).toBe(mediaUrl(path, false))
  })
})

describe("designPathOf", () => {
  test("a design page's URL gives its path back", () => {
    const path = "C:/Users/x/app/.ade/design/DS-A/1.html"
    expect(designPathOf(mediaUrl(path, true), roots)).toBe(path)
    const posix = "/home/x/app/.ade/design/Proposta più bella/1.html"
    expect(designPathOf(mediaUrl(posix, false), roots)).toBe(posix)
  })

  test("a reload token or a fragment does not change the page", () => {
    const path = "C:/Users/x/app/.ade/design/DS-A/1.html"
    expect(designPathOf(`${mediaUrl(path, true)}?__ade_reload=3#top`, roots)).toBe(path)
  })

  const outside: [string, string][] = [
    ["another file of the project", mediaUrl("C:/Users/x/app/.env", true)],
    ["an .html outside .ade/design", mediaUrl("C:/Users/x/app/public/index.html", true)],
    ["a double-encoded climb", "http://ade-media.localhost/C%3A/Users/x/app/.ade/design/%252e%252e/.env"],
    ["an encoded climb", "http://ade-media.localhost/C%3A/Users/x/app/.ade/design/%2e%2e/%2e%2e/.env.html"],
    ["another host", "http://localhost:3000/C%3A/Users/x/app/.ade/design/DS-A/1.html"],
    ["the ADE window itself", "http://tauri.localhost/index.html"],
    ["credentials in the URL", "http://u:p@ade-media.localhost/C%3A/Users/x/app/.ade/design/DS-A/1.html"],
    ["a data URL", "data:text/html,<p>x</p>"],
    ["not a URL", "not a url"],
  ]
  for (const [label, url] of outside) {
    test(`${label}: undefined`, () => expect(designPathOf(url, roots)).toBeUndefined())
  }
})
