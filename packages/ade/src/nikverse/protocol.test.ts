import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALLOWLIST,
  NIKVERSE_SCHEME,
  PORT_OFFER,
  decide,
  parseCommand,
  readFromWorld,
  vet,
  worldOrigin,
  worldUrl,
  type Snapshot,
} from "./protocol"
import { PORT_OFFER as WORLD_PORT_OFFER } from "./world/world.js"

const snapshot: Snapshot = {
  at: 1,
  shops: [{ id: "s1", name: "nikcli" }],
  agents: [
    {
      paneId: "n1-0",
      title: "Dario",
      kind: "claude-code",
      shop: "s1",
      state: "work",
      since: 1,
      look: { body: 0, palette: 0 },
    },
  ],
  waiting: { decisions: 0 },
}

describe("the commands the world may ask for", () => {
  test("the allowlist is exactly the four of this piece, and none of them asks yet", () => {
    expect(Object.keys(ALLOWLIST).sort()).toEqual(["chord", "focus-project", "open-session", "release-focus"])
    for (const name of Object.keys(ALLOWLIST) as (keyof typeof ALLOWLIST)[]) expect(ALLOWLIST[name].confirm).toBe(false)
  })

  test("a well formed command is read as itself, and only its own fields survive", () => {
    expect(parseCommand({ cmd: "open-session", paneId: "n1-0", extra: "x" })).toEqual({
      ok: true,
      command: { cmd: "open-session", paneId: "n1-0" },
    })
    expect(parseCommand({ cmd: "focus-project", project: "s1" })).toEqual({
      ok: true,
      command: { cmd: "focus-project", project: "s1" },
    })
    expect(parseCommand({ cmd: "release-focus", anything: 1 })).toEqual({ ok: true, command: { cmd: "release-focus" } })
    const chord = { cmd: "chord" as const, key: "k", ctrl: true, alt: false, shift: false, meta: false }
    expect(parseCommand({ ...chord, sneaky: true })).toEqual({ ok: true, command: chord })
  })

  test("a command that is not on the allowlist is ignored, with the reason", () => {
    for (const cmd of ["new-session", "close-session", "run", "eval", "constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      const parsed = parseCommand({ cmd, paneId: "n1-0" })
      expect([cmd, parsed.ok]).toEqual([cmd, false])
    }
    expect(parseCommand({ cmd: "delete-everything" })).toEqual({ ok: false, reason: "comando sconosciuto: delete-everything" })
  })

  test("anything that is not a command object is ignored", () => {
    for (const raw of [undefined, null, 0, "open-session", [], [{ cmd: "release-focus" }], { cmd: 3 }, { cmd: null }, {}]) {
      expect([raw, parseCommand(raw).ok]).toEqual([raw, false])
    }
  })

  test("a command with a missing, empty, oversized or mistyped field is ignored", () => {
    for (const raw of [
      { cmd: "open-session" },
      { cmd: "open-session", paneId: "" },
      { cmd: "open-session", paneId: 7 },
      { cmd: "open-session", paneId: "x".repeat(201) },
      { cmd: "focus-project", project: null },
      { cmd: "chord", key: "", ctrl: true, alt: false, shift: false, meta: false },
      { cmd: "chord", key: "k".repeat(25), ctrl: true, alt: false, shift: false, meta: false },
      { cmd: "chord", key: "k", ctrl: "yes", alt: false, shift: false, meta: false },
      { cmd: "chord", key: "k", ctrl: true },
    ]) {
      expect([raw, parseCommand(raw).ok]).toEqual([raw, false])
    }
  })

  test("a chord without Ctrl, Alt or Meta is refused: a bare key is the world's own, and Shift alone is a letter", () => {
    const base = { cmd: "chord", key: "w", ctrl: false, alt: false, shift: false, meta: false }
    expect(parseCommand(base).ok).toBe(false)
    expect(parseCommand({ ...base, shift: true }).ok).toBe(false)
    for (const flag of ["ctrl", "alt", "meta"]) expect(parseCommand({ ...base, [flag]: true }).ok).toBe(true)
  })

  test("a session or a project the world was never shown is ignored", () => {
    expect(vet({ cmd: "open-session", paneId: "n1-0" }, snapshot)).toEqual({ ok: true })
    expect(vet({ cmd: "focus-project", project: "s1" }, snapshot)).toEqual({ ok: true })
    expect(vet({ cmd: "open-session", paneId: "n9-9" }, snapshot).ok).toBe(false)
    expect(vet({ cmd: "focus-project", project: "s9" }, snapshot).ok).toBe(false)
    // Before the world has been shown anything, it may not name anything.
    expect(vet({ cmd: "open-session", paneId: "n1-0" }, undefined).ok).toBe(false)
    expect(vet({ cmd: "focus-project", project: "s1" }, undefined).ok).toBe(false)
    // Focus and shortcuts name nothing of ADE's.
    expect(vet({ cmd: "release-focus" }, undefined)).toEqual({ ok: true })
  })

  test("a command that would change something asks first; the four of this piece run", () => {
    expect(decide({ cmd: "open-session", paneId: "n1-0" })).toBe("run")
    expect(decide({ cmd: "release-focus" })).toBe("run")
    const original = ALLOWLIST["focus-project"].confirm
    ;(ALLOWLIST["focus-project"] as { confirm: boolean }).confirm = true
    try {
      expect(decide({ cmd: "focus-project", project: "s1" })).toBe("confirm")
    } finally {
      ;(ALLOWLIST["focus-project"] as { confirm: boolean }).confirm = original
    }
  })

  test("a message from the world is `ready` or a command, and nothing else", () => {
    expect(readFromWorld({ type: "ready" })).toEqual({ type: "ready" })
    // The world on screen, and too slow at its level (old PCs, points 3 and 2): nothing else rides along.
    expect(readFromWorld({ type: "opened", extra: "x" })).toEqual({ type: "opened" })
    expect(readFromWorld({ type: "slow", level: "alta" })).toEqual({ type: "slow" })
    expect(readFromWorld({ type: "command", command: { cmd: "release-focus" } })).toEqual({
      type: "command",
      command: { cmd: "release-focus" },
    })
    for (const data of [undefined, null, "ready", 1, {}, { type: "snapshot" }, { type: "eval", code: "1" }])
      expect([data, readFromWorld(data)]).toEqual([data, undefined])
  })
})

describe("where the world lives", () => {
  test("Windows serves the scheme as http://nikverse.localhost, the others as nikverse://localhost", () => {
    expect(NIKVERSE_SCHEME).toBe("nikverse")
    expect(worldOrigin(true)).toBe("http://nikverse.localhost")
    expect(worldOrigin(false)).toBe("nikverse://localhost")
    expect(worldUrl(true)).toBe("http://nikverse.localhost/")
    expect(worldUrl(false)).toBe("nikverse://localhost/")
  })

  test("its origin is never ADE's own, in a release or under the dev server", () => {
    const ade = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5177"]
    for (const windows of [true, false]) expect(ade).not.toContain(worldOrigin(windows))
    for (const windows of [true, false]) expect(new URL(worldUrl(windows)).host).not.toBe("tauri.localhost")
  })

  test("the offer the panel makes is the one the world waits for", () => {
    expect(PORT_OFFER).toBe(WORLD_PORT_OFFER)
  })

  test("lint: the frame's origin is opaque, so Tauri's IPC refuses it, and it has no way to navigate ADE", () => {
    const source = readFileSync(join(import.meta.dir, "nikverse-pane.tsx"), "utf8")
    const frame = source.slice(source.indexOf("<iframe"), source.indexOf("/>", source.indexOf("<iframe")))
    expect(frame).toContain("src={frameSrc()}")
    expect(frame).not.toContain("srcdoc")
    const sandbox = /sandbox="([^"]*)"/.exec(frame)?.[1]?.split(/\s+/) ?? []
    // Every scheme Tauri registers is a local origin for its IPC: the world must not have its own.
    // Scripts and nothing else: WebView2 gives a frame no pointer lock, and the camera turns by dragging.
    expect(sandbox).toEqual(["allow-scripts"])
    for (const never of ["allow-pointer-lock", "allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"])
      expect(sandbox).not.toContain(never)
    // No target origin can name an opaque one: the offer goes to "*", but only to the window of the frame this panel made.
    expect(source).toContain('PROTOCOL_VERSION }, "*", [channel.port2])')
    expect(source.match(/postMessage\(/g)).toHaveLength(1)
    // The port goes only to the window that just proved it knows the nonce, from this frame.
    const answered = source.slice(source.indexOf("const onHello"), source.indexOf("const lifecycle"))
    expect(answered).toContain("handshake.hello(event)")
    expect(answered.indexOf("if (!verdict.ok)")).toBeLessThan(answered.indexOf("connect(event.source as Window)"))
    expect(source.match(/connect\(/g)).toHaveLength(2)
    // The secret is in the address' fragment, fresh for each load of the frame.
    // The address is the world's, its query (the bench door, a lowered level, the list: `opening.worldQuery`), and the nonce.
    expect(source).toContain("`${worldUrl()}${worldQuery({ bench: benchQuery(), ")
    expect(source).toContain("})}#n=${secret}`")
    // The bench door is asked for by the test build only.
    expect(source).toContain('dataset.adeBuild === "test"')
    expect(source).toContain("?bench=1")
    // The gate's `--tune` rides on the same door, and on no other: nothing is added to a release build's address.
    expect(source.slice(source.indexOf("const benchQuery"), source.indexOf("const sourceFor"))).toMatch(/adeBuild === "test"\s*\?[\s\S]*__nikverseTune[\s\S]*:\s*""/)
    expect(source).toContain("src={frameSrc()}")
    expect(source).toContain("nonce = newNonce()")
    // Every load of the frame asks the link whether its document is still there.
    expect(source).toContain("onLoad={() => link?.probe()}")
  })

  test("a pong is read, with its number, and nothing else passes for one", () => {
    expect(readFromWorld({ type: "pong", id: 3 })).toEqual({ type: "pong", id: 3 })
    for (const data of [{ type: "pong" }, { type: "pong", id: "3" }, { type: "pong", id: null }])
      expect([data, readFromWorld(data)]).toEqual([data, undefined])
  })

})
