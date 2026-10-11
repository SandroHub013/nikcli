import { afterEach, describe, expect, it } from "bun:test"
import { ImageAddon } from "@xterm/addon-image"
import { DEFAULT_IMAGE_OPTIONS, disposeTerminal, getTerminal } from "./registry"

describe("terminal ImageAddon (OSC 1337)", () => {
  const SESSION_ID = "test-image-pane"

  afterEach(() => {
    disposeTerminal(SESSION_ID)
  })

  it("loads ImageAddon in every terminal session with the required options", () => {
    const session = getTerminal(SESSION_ID)
    expect(session.image).toBeInstanceOf(ImageAddon)
    expect(DEFAULT_IMAGE_OPTIONS.iipSupport).toBe(true)
    expect(DEFAULT_IMAGE_OPTIONS.sixelSupport).toBe(false)
    expect(DEFAULT_IMAGE_OPTIONS.iipSizeLimit).toBe(10_000_000)
    expect(DEFAULT_IMAGE_OPTIONS.pixelLimit).toBe(4_194_304)
    expect(DEFAULT_IMAGE_OPTIONS.storageLimit).toBe(64)
    expect(DEFAULT_IMAGE_OPTIONS.showPlaceholder).toBe(true)
    expect(DEFAULT_IMAGE_OPTIONS.enableSizeReports).toBe(true)
    expect(session.image.storageLimit).toBe(64)
    expect(session.image.storageUsage).toBe(0)
  })

  it("registers the OSC 1337 parser handler and ignores sixel DCS", () => {
    const session = getTerminal(SESSION_ID)
    const parser = (session.terminal as unknown as { _core: { _inputHandler: { _parser: { _oscParser: { _handlers: Record<number, unknown> }; _dcsParser: { _handlers: Record<string, unknown> } } } } })._core._inputHandler._parser
    expect(parser._oscParser._handlers[1337]).toBeDefined()

    // With sixelSupport disabled, DCS 'q' is not registered
    expect(parser._dcsParser._handlers["q"]).toBeUndefined()
  })

  it("safely ignores oversized IIP payload without blocking or throwing", () => {
    const session = getTerminal(SESSION_ID)
    // IIP declaring size larger than iipSizeLimit (10MB)
    const oversizedSeq = "\x1b]1337;File=inline=1;size=25000000:AAAA\x07"
    expect(() => session.terminal.write(oversizedSeq)).not.toThrow()
    // Terminal continues to process subsequent text normally
    session.terminal.write("normal output")
    expect(session.image.storageUsage).toBe(0)
  })

  it("frees addon storage and resources on disposeTerminal", () => {
    const session = getTerminal(SESSION_ID)
    const image = session.image
    expect(image.storageUsage).toBe(0)

    // Disposing terminal disposes the addon and cleans up terminal map
    disposeTerminal(SESSION_ID)
    expect(getTerminal(SESSION_ID)).not.toBe(session)
  })
})
