import { describe, expect, test } from "bun:test"
import { generateQR, generateQRMatrix } from "@nikcli-ai/remote"
import { shouldUseAsciiQR } from "@nikcli-ai/util/win32"
import { buildMobilePairingDeepLink } from "@/cli/handlers/mobile/shared"
import { normalizeMobileServerUrl, shouldShowPairingLink } from "@tui/component/dialog-mobile-connect"
import { asciiQRRuns, qrRenderHeight, qrRenderMode, qrRenderWidth, renderQRRows } from "@tui/component/qr"

describe("mobile pairing", () => {
  test("builds the deep link consumed by the mobile app", () => {
    const value = buildMobilePairingDeepLink({
      serverUrl: "http://192.168.1.4:4096",
      token: "nkm_secret",
      directory: "/tmp/a project",
    })
    const url = new URL(value)

    expect(url.protocol).toBe("nikcli:")
    expect(url.hostname).toBe("connect")
    expect(url.searchParams.get("server")).toBe("http://192.168.1.4:4096")
    expect(url.searchParams.get("token")).toBe("nkm_secret")
    expect(url.searchParams.get("directory")).toBe("/tmp/a project")
  })

  test("builds a cloud link without leaking the local directory", () => {
    const value = buildMobilePairingDeepLink({
      serverUrl: "https://cloud.example.com",
      token: "nkm_cloud",
    })
    const url = new URL(value)

    expect(url.searchParams.get("server")).toBe("https://cloud.example.com")
    expect(url.searchParams.get("token")).toBe("nkm_cloud")
    expect(url.searchParams.has("directory")).toBe(false)
  })

  test("normalizes cloud server and mobile endpoint URLs", () => {
    expect(normalizeMobileServerUrl("cloud.example.com/")).toBe("https://cloud.example.com")
    expect(normalizeMobileServerUrl("https://cloud.example.com/base/mobile/teleport")).toBe(
      "https://cloud.example.com/base",
    )
    expect(normalizeMobileServerUrl("ftp://cloud.example.com")).toBeNull()
    expect(normalizeMobileServerUrl("")).toBeNull()
  })

  test("generates the QR matrix used by the TUI", async () => {
    const matrix = await generateQRMatrix(
      buildMobilePairingDeepLink({
        serverUrl: "http://192.168.1.4:4096",
        token: "nkm_secret",
        directory: "/Volumes/SSD/Projects/nikcli",
      }),
    )

    expect(matrix).not.toBeNull()
    expect(matrix?.length).toBeGreaterThan(0)
    expect(matrix?.every((row) => row.length === matrix.length)).toBe(true)
  })

  test("packs two QR module rows into one terminal row without truncation", () => {
    const matrix = [
      [true, false, true],
      [true, true, false],
    ]

    expect(renderQRRows(matrix, 0)).toEqual(["█▄▀"])
  })

  test("pads odd-height matrices with a blank half-row so the output is even", () => {
    const matrix = [
      [true, false, true],
      [true, true, false],
      [false, true, true],
    ]

    // Three module rows → two terminal rows. The bottom output row is the
    // last module row paired with a blank half-row, so the trailing column
    // is `▀` (top half of the last filled module) — not a space.
    expect(renderQRRows(matrix, 0)).toEqual(["█▄▀", " ▀▀"])
  })

  test("spells the pairing link out only where the QR cannot be trusted", () => {
    // Windows terminals all run through ConPTY, where a large frame can lose
    // cells and leave the QR a blank white square. Everywhere else the link
    // stays off screen: it carries the pairing token in clear text.
    expect(shouldShowPairingLink("win32")).toBe(true)
    expect(shouldShowPairingLink("darwin")).toBe(false)
    expect(shouldShowPairingLink("linux")).toBe(false)
  })

  test("Windows draws the QR with ASCII spaces, not half-block glyphs", () => {
    expect(shouldUseAsciiQR("win32")).toBe(true)
    expect(shouldUseAsciiQR("darwin")).toBe(false)
    expect(shouldUseAsciiQR("linux")).toBe(false)
    expect(qrRenderMode("win32")).toBe("ascii")
    expect(qrRenderMode("darwin")).toBe("half-block")
  })

  test("ASCII mode is two columns and one row per module so the square stays square", () => {
    const matrix = [
      [true, false, true],
      [true, true, false],
    ]

    expect(qrRenderWidth(matrix, 0, "half-block")).toBe(5)
    expect(qrRenderHeight(matrix, 0, "half-block")).toBe(1)
    expect(qrRenderWidth(matrix, 0, "ascii")).toBe(8)
    expect(qrRenderHeight(matrix, 0, "ascii")).toBe(2)
  })

  test("run-length encodes ASCII QR rows so adjacent modules share one cell run", () => {
    expect(asciiQRRuns([true, true, false, true])).toEqual([
      { dark: true, count: 2 },
      { dark: false, count: 1 },
      { dark: true, count: 1 },
    ])
  })

  test("CLI terminal QR on Windows is 16-color spaces, not █▀▄", async () => {
    const url = "nikcli://connect?server=http://192.168.1.4:4096&token=nkm_secret"
    const windows = await generateQR(url, { small: false })
    const compact = await generateQR(url, { small: true })

    expect(windows).toContain("\x1b[40m  \x1b[0m")
    expect(windows).toContain("\x1b[47m  \x1b[0m")
    expect(windows).not.toContain("█")
    expect(windows).not.toContain("▀")
    expect(windows).not.toContain("▄")
    expect(compact).toMatch(/[█▀▄]/)
  })
})
