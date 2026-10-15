import { describe, expect, test } from "bun:test"
import { sidebarPath } from "@tui/util/sidebar-path"

/* Review of the UI, N21: on Windows the sidebar's foot read «/C:\Users\…\proj» (it split on "/" only). */
describe("sidebarPath", () => {
  test("a Windows folder is split on the backslash, with no leading «/»", () => {
    expect(sidebarPath("C:\\Users\\me\\proj")).toEqual({ parent: "C:\\Users\\me\\", name: "proj" })
  })

  test("a POSIX folder keeps its separators", () => {
    expect(sidebarPath("~/work/proj")).toEqual({ parent: "~/work/", name: "proj" })
    expect(sidebarPath("/")).toEqual({ parent: "", name: "" })
  })

  test("the branch goes after the name, even when it has a «/»", () => {
    expect(sidebarPath("~/work/proj", "feat/ade")).toEqual({ parent: "~/work/", name: "proj:feat/ade" })
    expect(sidebarPath("C:\\proj", "main")).toEqual({ parent: "C:\\", name: "proj:main" })
  })

  test("a bare name has no parent", () => {
    expect(sidebarPath("proj")).toEqual({ parent: "", name: "proj" })
  })
})
