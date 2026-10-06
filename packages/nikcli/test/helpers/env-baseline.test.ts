import { describe, expect, it } from "bun:test"

/*
 * The preload points LOCALAPPDATA and APPDATA at the run's temporary home, so they are part of keeping a
 * test away from the user's folders. The baseline restores them before each test, like NIKCLI_* and XDG_*:
 * a test that changes one must not hand the changed value to the next.
 *
 * The two tests depend on running in this order, which a file's tests always do.
 */
const seen: { local?: string; roaming?: string } = {}

describe("LOCALAPPDATA and APPDATA in the test environment baseline", () => {
  it("are the temporary home's, and a test may change them", () => {
    seen.local = process.env.LOCALAPPDATA
    seen.roaming = process.env.APPDATA
    expect(seen.local).toContain("nikcli")
    expect(seen.roaming).toContain("nikcli")

    process.env.LOCALAPPDATA = "C:\Users\someone\AppData\Local"
    delete process.env.APPDATA
  })

  it("come back as they were for the next test", () => {
    expect(process.env.LOCALAPPDATA).toBe(seen.local)
    expect(process.env.APPDATA).toBe(seen.roaming)
  })
})
