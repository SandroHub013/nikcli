import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ThemeContext, createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { SDKProvider } from "@tui/context/sdk"
import { Site } from "@tui/feature-plugins/mods"
import { Tree } from "@tui/feature-plugins/mods/tree"

const theme = createStandaloneTheme({ document: await loadBuiltInTheme("nikcli"), mode: "dark" })

/**
 * The terminal side of mods: a tree a mod answered `ui.render` with is drawn, a press goes back to the
 * mods as `ui.press`, and an invalidation draws again. The server is faked at the transport.
 */
async function mount(render: () => unknown) {
  const requests: { path: string; body: any }[] = []
  let push!: (type: string, properties: Record<string, unknown>) => void
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json() : undefined
    requests.push({ path, body })
    if (path === "/mod/ui/render") return Response.json(render())
    if (path === "/mod/ui/event") return Response.json({ handled: true })
    throw new Error(`Unexpected request: ${request.method} ${path}`)
  }) as typeof fetch
  const screen = await testRender(
    () => (
      <ThemeContext.Provider value={theme as never}>
        <SDKProvider
          url="http://mods.test"
          fetch={transport}
          events={{
            subscribe: async (_directory, handler) => {
              push = (type, properties) => handler({ directory: "/test", payload: { type, properties } as never })
              return () => {}
            },
          }}
        >
          <Site component="AbovePrompt" requestId="band" sessionID="ses_test" />
        </SDKProvider>
      </ThemeContext.Provider>
    ),
    { width: 60, height: 12 },
  )
  return {
    ...screen,
    requests,
    push: (type: string, properties: Record<string, unknown> = {}) => push(type, properties),
  }
}

/** Poll until the screen shows `text`: the answer arrives over a fake network and a debounce, not in a render pass. */
async function shows(screen: { flush: () => Promise<void>; captureCharFrame: () => string }, text: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await screen.flush()
    if (screen.captureCharFrame().includes(text)) return
    await Bun.sleep(25)
  }
  throw new Error(`the screen never showed "${text}":\n${screen.captureCharFrame()}`)
}

const tree = (text: string) =>
  JSON.stringify({
    type: "Box",
    props: { gap: 0 },
    children: [
      { type: "Text", props: { bold: true }, children: [text] },
      { type: "Button", key: "go", props: { label: "[ Go ]" } },
    ],
  })

describe("mods in the terminal", () => {
  test("draws the tree a mod answered with, and asks for it with the site's request id", async () => {
    const screen = await mount(() => ({ kind: "tree", tree: tree("hello from a mod") }))
    await shows(screen, "hello from a mod")
    expect(screen.captureCharFrame()).toContain("[ Go ]")
    const asked = screen.requests.find((request) => request.path === "/mod/ui/render")!
    expect(asked.body).toMatchObject({ component: "AbovePrompt", requestId: "band", sessionID: "ses_test" })
    screen.renderer.destroy()
  })

  test("draws nothing when no mod draws the site", async () => {
    const screen = await mount(() => ({ kind: "default" }))
    await screen.flush()
    await Bun.sleep(50)
    expect(/[A-Za-z0-9]/.test(screen.captureCharFrame())).toBe(false)
    screen.renderer.destroy()
  })

  test("a press on a Button reports its key, and an invalidation draws again", async () => {
    let text = "first"
    const screen = await mount(() => ({ kind: "tree", tree: tree(text) }))
    await shows(screen, "first")

    const lines = screen.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("[ Go ]"))
    const column = lines[row]!.indexOf("[ Go ]") + 2
    await screen.mockMouse.click(column, row)
    await Bun.sleep(30)
    expect(screen.requests.find((request) => request.path === "/mod/ui/event")?.body).toMatchObject({
      kind: "press",
      key: "go",
      component: "AbovePrompt",
      requestId: "band",
    })

    text = "second"
    screen.push("mod.ui.invalidate", { component: "AbovePrompt" })
    await shows(screen, "second")
    // Another site's invalidation is not ours.
    const before = screen.requests.filter((request) => request.path === "/mod/ui/render").length
    screen.push("mod.ui.invalidate", { component: "Pane" })
    await Bun.sleep(80)
    expect(screen.requests.filter((request) => request.path === "/mod/ui/render").length).toBe(before)
    screen.renderer.destroy()
  })
})

describe("the element tree renderer", () => {
  test("draws text, nested styled text, links, code and selects", async () => {
    const screen = await testRender(
      () => (
        <ThemeContext.Provider value={theme as never}>
          <Tree
            events={{ press() {}, input() {}, select() {} }}
            node={{
              type: "Box",
              props: {},
              children: [
                {
                  type: "Text",
                  props: {},
                  children: ["a ", { type: "Text", props: { bold: true }, children: ["bold"] }, " b"],
                },
                { type: "Link", props: { href: "https://example.test", label: "docs" } },
                { type: "Code", props: { text: "const x = 1" } },
                {
                  type: "Select",
                  key: "s",
                  props: { options: [{ value: "a", label: "Alpha" }, { value: "b" }], value: "a" },
                },
                "plain string",
              ],
            }}
          />
        </ThemeContext.Provider>
      ),
      { width: 50, height: 12 },
    )
    await screen.waitForFrame((frame) => frame.includes("plain string"))
    const frame = screen.captureCharFrame()
    expect(frame).toContain("a bold b")
    expect(frame).toContain("docs")
    expect(frame).toContain("const x = 1")
    expect(frame).toContain("● Alpha")
    expect(frame).toContain("○ b")
    screen.renderer.destroy()
  })
})
