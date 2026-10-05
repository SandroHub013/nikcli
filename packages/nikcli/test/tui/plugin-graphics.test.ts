import { afterEach, describe, expect, test } from "bun:test"
import { createGraphicsApi } from "@tui/plugin/graphics"
import { tuiSource } from "./tui-source"

/**
 * `api.graphics` is the host's side of the Kitty graphics protocol.
 *
 * A plugin cannot do this itself and get it right: the terminal's capabilities
 * were negotiated once at startup, the id space of the terminal's image table
 * is shared with the host's own inline previews, and the encoding is a
 * 297-entry diacritic table. So the host transmits and hands back the cells,
 * and these tests pin the three things that go wrong quietly — a placement
 * nothing can composite, an id that overwrites a live preview, and an image the
 * terminal holds for the rest of the session because nobody deleted it.
 */
const ENV_KEYS = ["KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "GHOSTTY_BIN_DIR", "TERM", "TERM_PROGRAM"] as const
let saved: Record<string, string | undefined> = {}

/** A renderer with just the surface `createGraphicsApi` reads. */
function renderer(capabilities: Record<string, unknown> | null) {
  return { capabilities } as unknown as Parameters<typeof createGraphicsApi>[0]["renderer"]
}

function capture() {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string) => {
    written.push(String(chunk))
    return true
  }
  return {
    written,
    restore() {
      process.stdout.write = original
    },
  }
}

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value
    }
  }
}

const KITTY = { kitty_graphics: true, terminal: { name: "kitty" } }

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe("graphics capability", () => {
  test("a terminal that negotiated nothing is not offered placements", () => {
    withEnv({ TERM: "xterm-256color" }, () => {
      expect(
        createGraphicsApi({
          renderer: renderer({
            kitty_graphics: false,
            terminal: { name: "xterm" },
          }),
        }).kittyPlaceholders,
      ).toBe(false)
    })
  })

  test("a negotiated DA1 answer alone is not enough: placeholders are a narrower set", () => {
    // kitty_graphics covers the classic protocol, which WezTerm and Warp speak
    // without compositing virtual placements. Without an explicit identity
    // signal the answer is not trusted, so a plugin does not emit placeholders
    // a terminal will render as stray combining marks.
    withEnv({ TERM: "xterm-256color" }, () => {
      expect(createGraphicsApi({ renderer: renderer(KITTY) }).kittyPlaceholders).toBe(false)
    })
  })

  test("kitty and ghostty are offered placements", () => {
    withEnv({ KITTY_WINDOW_ID: "1" }, () => {
      expect(createGraphicsApi({ renderer: renderer(KITTY) }).kittyPlaceholders).toBe(true)
    })
    withEnv({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app" }, () => {
      expect(createGraphicsApi({ renderer: renderer(KITTY) }).kittyPlaceholders).toBe(true)
    })
  })

  test("the env escape hatch wins over the terminal's own answer", () => {
    withEnv({ TERM: "xterm-256color", NIKCLI_KITTY_PLACEHOLDERS: "1" }, () => {
      expect(createGraphicsApi({ renderer: renderer(KITTY) }).kittyPlaceholders).toBe(true)
    })
  })
})

describe("placeKittyImage", () => {
  test("transmits one drawless placement and describes the cells that composite it", () => {
    const out = capture()
    try {
      withEnv({ KITTY_WINDOW_ID: "1" }, () => {
        const api = createGraphicsApi({ renderer: renderer(KITTY) })
        const placement = api.placeKittyImage({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          columns: 4,
          rows: 3,
        })

        // One sequence, nothing drawn at the cursor (`U=1`), no terminal reply
        // (`q=2`), and the PNG declared by format 100.
        expect(out.written).toHaveLength(1)
        const [head, rest] = out.written[0]!.split(";")
        expect(head).toBe(`\x1b_Ga=T,U=1,q=2,f=100,i=${placement.id},c=4,r=3`)
        // The payload is terminated by ST, not by end-of-string.
        expect(rest!.endsWith("\x1b\\")).toBe(true)
        expect(rest!.slice(0, -2)).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"))

        // One row string per row, each holding `columns` placeholder cells —
        // U+10EEEE plus the row and column diacritics that address its slice.
        expect(placement.lines).toHaveLength(3)
        for (const line of placement.lines) {
          expect([...line]).toHaveLength(4 * 3)
        }
        // The id has to be readable off the cell foreground, or the terminal
        // composites nothing at all.
        const [r, g, b] = placement.fg.toInts()
        expect(r).toBe((placement.id >> 16) & 0xff)
        expect(g).toBe((placement.id >> 8) & 0xff)
        expect(b).toBe(placement.id & 0xff)
      })
    } finally {
      out.restore()
    }
  })

  test("a path hands the terminal the file instead of the pixels", () => {
    const out = capture()
    try {
      withEnv({ KITTY_WINDOW_ID: "1" }, () => {
        const api = createGraphicsApi({ renderer: renderer(KITTY) })
        const placement = api.placeKittyImage({
          path: "/tmp/scene.png",
          columns: 2,
          rows: 1,
        })
        expect(out.written[0]).toContain("t=t")
        expect(out.written[0]).toContain(Buffer.from("/tmp/scene.png").toString("base64"))
        expect(placement.lines).toHaveLength(1)
      })
    } finally {
      out.restore()
    }
  })

  test("ids stay clear of the host's own preview range", () => {
    const out = capture()
    try {
      withEnv({ KITTY_WINDOW_ID: "1" }, () => {
        const api = createGraphicsApi({ renderer: renderer(KITTY) })
        const first = api.placeKittyImage({
          bytes: new Uint8Array([1]),
          columns: 1,
          rows: 1,
        })
        const second = api.placeKittyImage({
          bytes: new Uint8Array([1]),
          columns: 1,
          rows: 1,
        })
        // `component/tui-image.tsx` hands out 1..0xffff for previews; a plugin
        // placement landing there would overwrite a preview still on screen.
        for (const placement of [first, second]) {
          expect(placement.id).toBeGreaterThan(0xffff)
          expect(placement.id).toBeLessThanOrEqual(0xffffff)
        }
        expect(first.id).not.toBe(second.id)
      })
    } finally {
      out.restore()
    }
  })

  test("dispose deletes the image once, and a second call writes nothing", () => {
    const out = capture()
    try {
      withEnv({ KITTY_WINDOW_ID: "1" }, () => {
        const api = createGraphicsApi({ renderer: renderer(KITTY) })
        const placement = api.placeKittyImage({
          bytes: new Uint8Array([1]),
          columns: 1,
          rows: 1,
        })
        out.written.length = 0

        placement.dispose()
        placement.dispose()
        // `d=I` deletes the image *and* its placements, which is what stops a
        // hot-reloaded plugin from leaving one image per reload behind.
        expect(out.written).toEqual([`\x1b_Ga=d,d=I,i=${placement.id},q=2\x1b\\`])
      })
    } finally {
      out.restore()
    }
  })
})

describe("the backdrop mount point", () => {
  test("mounted in an absolute box sized to the frame, ahead of the built-in wallpaper", async () => {
    // Pinned against the source: the mount needs the whole TUI to observe, and
    // what matters is positional. Absolute so the slot does not join the column
    // and push the interface down; sized to the frame, because a zero-size
    // wrapper lays its children out at width 0 and a full-screen node inside one
    // renders nothing at all. As a direct child of `renderer.root` instead it
    // would be behind the opaque app box and never seen.
    const src = await tuiSource("app.tsx")
    const mount = src.indexOf(`<TuiPluginRuntime.Slot name="backdrop" />`)
    expect(mount).toBeGreaterThan(-1)
    const wrapper = src.lastIndexOf("<box", mount)
    const open = src.slice(wrapper, mount)
    expect(open).toContain(`position="absolute"`)
    expect(open).toContain("width={dimensions().width}")
    expect(open).toContain("height={dimensions().height}")
    // Ahead of the wallpaper and of every interface sibling.
    expect(src.indexOf("<BackgroundImage />")).toBeGreaterThan(mount)
    expect(src.indexOf("<Home />")).toBeGreaterThan(mount)
  })
})
