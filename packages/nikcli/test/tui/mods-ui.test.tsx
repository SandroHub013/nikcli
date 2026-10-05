import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ThemeContext, createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { SDKProvider } from "@tui/context/sdk"
import { Site } from "@tui/feature-plugins/mods"
import { Replace } from "@tui/feature-plugins/mods/render"
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

/** A site nikcli draws itself: `Replace` draws its children unless a mod answers with a tree. */
async function mountReplace(input: { mods: unknown[]; render: () => unknown }) {
  const requests: string[] = []
  let push!: (type: string, properties: Record<string, unknown>) => void
  const transport = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(request, init)
    const path = new URL(req.url).pathname
    requests.push(path)
    if (path === "/mod") return Response.json(input.mods)
    if (path === "/mod/ui/render") return Response.json(input.render())
    throw new Error(`Unexpected request: ${req.method} ${path}`)
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
          <Replace component="ToolUse" requestId="call_1" sessionID="ses_test" props={{ tool: "bash" }}>
            {(site) => <text>{`default row for ${String(site.tool)}`}</text>}
          </Replace>
        </SDKProvider>
      </ThemeContext.Provider>
    ),
    { width: 60, height: 6 },
  )
  return {
    ...screen,
    requests,
    push: (type: string, properties: Record<string, unknown> = {}) => push(type, properties),
  }
}

const modInfo = (events: string[]) => [{ id: "m", name: "m", tier: "user", rank: 100, events, tools: [], commands: [] }]

describe("sites nikcli draws itself", () => {
  test("with no mod that draws, the default is drawn and no render request is made", async () => {
    const screen = await mountReplace({ mods: modInfo(["tool.call"]), render: () => ({ kind: "default" }) })
    await shows(screen, "default row for bash")
    await Bun.sleep(80)
    expect(screen.requests.filter((path) => path === "/mod/ui/render")).toEqual([])
    screen.renderer.destroy()
  })

  test("a mod that draws replaces the default with its tree", async () => {
    const screen = await mountReplace({
      mods: modInfo(["ui.render"]),
      render: () => ({
        kind: "tree",
        tree: JSON.stringify({ type: "Text", props: { color: "success" }, children: ["drawn by a mod"] }),
      }),
    })
    await shows(screen, "drawn by a mod")
    expect(screen.captureCharFrame()).not.toContain("default row")
    screen.renderer.destroy()
  })

  test("a mod that only rewrites props changes what the default shows; one answering null hides the row", async () => {
    let answer: unknown = { kind: "default", props: JSON.stringify({ tool: "renamed" }) }
    const screen = await mountReplace({ mods: modInfo(["ui.render"]), render: () => answer })
    await shows(screen, "default row for renamed")

    answer = { kind: "tree" }
    screen.push("mod.ui.invalidate", { component: "ToolUse" })
    for (let attempt = 0; attempt < 60 && screen.captureCharFrame().includes("default row"); attempt++) {
      await screen.flush()
      await Bun.sleep(25)
    }
    expect(screen.captureCharFrame()).not.toContain("default row")
    screen.renderer.destroy()
  })

  test("a mod loading later turns the site on: an untargeted invalidation re-reads the mod list", async () => {
    let mods: unknown[] = modInfo(["tool.call"])
    const requests: string[] = []
    const screen = await mountReplace({
      get mods() {
        return mods
      },
      render: () => ({ kind: "tree", tree: JSON.stringify({ type: "Text", props: {}, children: ["now drawn"] }) }),
    } as never)
    await shows(screen, "default row for bash")
    mods = modInfo(["ui.render"])
    screen.push("mod.ui.invalidate", {})
    await shows(screen, "now drawn")
    void requests
    screen.renderer.destroy()
  })
})

describe("Replace without a client", () => {
  test("is its children: a story or a component test has nobody to ask", async () => {
    const screen = await testRender(
      () => (
        <ThemeContext.Provider value={theme as never}>
          <Replace component="ToolUse" requestId="x">
            <text>plain default</text>
          </Replace>
        </ThemeContext.Provider>
      ),
      { width: 40, height: 4 },
    )
    await shows(screen, "plain default")
    screen.renderer.destroy()
  })
})
