import { describe, expect, test } from "bun:test"
import {
  BASIL_SIZE,
  BASIL_SPRITE,
  DEVELOPER_POSE_NAMES,
  DEVELOPER_POSES,
  DEVELOPER_SPRITE_SIZE,
  LAPTOP_SIZE,
  LAPTOP_SPRITE,
  POT_FRAMES,
  POT_SPRITE_SIZE,
  SPLASH_PALETTE,
  TOMATO_SIZE,
  TOMATO_SPRITE,
  WORDMARK_COLORS,
  WORDMARK_GRID,
  WORDMARK_HEIGHT,
  WORDMARK_NATIVE_HEIGHT,
  WORDMARK_NATIVE_WIDTH,
  WORDMARK_SCALE,
  WORDMARK_SIZE,
  WORDMARK_WIDTH,
} from "./sprites"

describe("splash sprite data (step 1)", () => {
  describe("palette integrity", () => {
    test("every key in the palette has a valid hex colour or transparent", () => {
      for (const [key, color] of Object.entries(SPLASH_PALETTE)) {
        if (color === "transparent") {
          expect(key).toBe(".")
        } else {
          expect(color).toMatch(/^#[0-9a-f]{6}$/i)
        }
      }
    })
  })

  describe("pot frames", () => {
    test("has between 6 and 8 frames (8 defined)", () => {
      expect(POT_FRAMES.length).toBeGreaterThanOrEqual(6)
      expect(POT_FRAMES.length).toBeLessThanOrEqual(8)
      expect(POT_FRAMES.length).toBe(8)
    })

    test("every pot frame has identical dimensions matching POT_SPRITE_SIZE (16x16)", () => {
      for (const frame of POT_FRAMES) {
        expect(frame.length).toBe(POT_SPRITE_SIZE.height)
        for (const row of frame) {
          expect(row.length).toBe(POT_SPRITE_SIZE.width)
        }
      }
    })

    test("every pixel in pot frames belongs to the approved palette", () => {
      const allowedKeys = new Set(Object.keys(SPLASH_PALETTE))
      for (const frame of POT_FRAMES) {
        for (const row of frame) {
          for (const char of row) {
            expect(allowedKeys.has(char)).toBe(true)
          }
        }
      }
    })

    test("pot base and handles match the iconic Ragu pot silhouette", () => {
      for (const frame of POT_FRAMES) {
        expect(frame[14]).toBe("....aaaaaaaa....")
        expect(frame[13]).toBe("...adddddddda...")
      }
    })
  })

  describe("developer poses", () => {
    test("has exactly 8 poses matching the required sequence", () => {
      expect(DEVELOPER_POSES.length).toBe(8)
      expect(DEVELOPER_POSE_NAMES.length).toBe(8)
      expect(DEVELOPER_POSE_NAMES).toEqual([
        "pronto",
        "mescola_sinistra",
        "mescola_destra",
        "alza_cucchiaio",
        "assaggia",
        "contento",
        "pollice_su",
        "sorriso",
      ])
    })

    test("developer height is roughly twice the height of the pot (34 vs 16 px)", () => {
      expect(DEVELOPER_SPRITE_SIZE.height).toBe(34)
      expect(DEVELOPER_SPRITE_SIZE.height).toBeGreaterThanOrEqual(POT_SPRITE_SIZE.height * 2)
    })

    test("every developer pose has identical dimensions matching DEVELOPER_SPRITE_SIZE (28x34)", () => {
      for (const pose of DEVELOPER_POSES) {
        expect(pose.length).toBe(DEVELOPER_SPRITE_SIZE.height)
        for (const row of pose) {
          expect(row.length).toBe(DEVELOPER_SPRITE_SIZE.width)
        }
      }
    })

    test("every pixel in developer poses belongs to the approved palette", () => {
      const allowedKeys = new Set(Object.keys(SPLASH_PALETTE))
      for (const pose of DEVELOPER_POSES) {
        for (const row of pose) {
          for (const char of row) {
            expect(allowedKeys.has(char)).toBe(true)
          }
        }
      }
    })
  })

  describe("props: laptop, tomato, basil", () => {
    test("laptop has valid dimensions and displays colored code lines", () => {
      expect(LAPTOP_SPRITE.length).toBe(LAPTOP_SIZE.height)
      for (const row of LAPTOP_SPRITE) {
        expect(row.length).toBe(LAPTOP_SIZE.width)
      }
      const text = LAPTOP_SPRITE.join("")
      expect(text).toContain("f") // red keyword
      expect(text).toContain("c") // green function call
      expect(text).toContain("k") // amber code
    })

    test("counter tomato and basil have valid dimensions", () => {
      expect(TOMATO_SPRITE.length).toBe(TOMATO_SIZE.height)
      expect(BASIL_SPRITE.length).toBe(BASIL_SIZE.height)
    })
  })

  describe("wordmark (Ragù Code)", () => {
    test("wordmark grid has native dimensions matching WORDMARK_NATIVE_WIDTH and WORDMARK_NATIVE_HEIGHT (40x10)", () => {
      expect(WORDMARK_GRID.length).toBe(WORDMARK_NATIVE_HEIGHT)
      for (const row of WORDMARK_GRID) {
        expect(row.length).toBe(WORDMARK_NATIVE_WIDTH)
      }
      expect(WORDMARK_NATIVE_WIDTH).toBe(40)
      expect(WORDMARK_NATIVE_HEIGHT).toBe(10)
    })

    test("scaled wordmark occupies 80x20 pixels (50% of canvas width)", () => {
      expect(WORDMARK_WIDTH).toBe(80)
      expect(WORDMARK_HEIGHT).toBe(20)
      expect(WORDMARK_SCALE).toBe(2)
      expect(WORDMARK_SIZE.width).toBe(80)
      expect(WORDMARK_SIZE.height).toBe(20)
    })

    test("every pixel in the wordmark belongs to the CLI brand palette without dark outlines", () => {
      const allowedColors = new Set([
        "",
        WORDMARK_COLORS.ragu,
        WORDMARK_COLORS.raguShadow,
        WORDMARK_COLORS.code,
        WORDMARK_COLORS.codeShadow,
      ])
      for (const row of WORDMARK_GRID) {
        for (const pixel of row) {
          expect(allowedColors.has(pixel)).toBe(true)
          // Explicitly confirm no dark outline #120d0b
          expect(pixel).not.toBe("#120d0b")
        }
      }
    })

    test("letter d has an ascender on line 0", () => {
      // Line 0 bottom pixel row (row 1 in grid), col 21 + 13 = 34
      expect(WORDMARK_GRID[1]![34]).toBe(WORDMARK_COLORS.code)
    })

    test("letter g has a descender reaching down to line 4", () => {
      // Line 4 (rows 8 and 9 in grid) contains g descender
      const gRow8 = WORDMARK_GRID[8]!.slice(10, 14)
      expect(gRow8).toContain(WORDMARK_COLORS.ragu)
    })

    test("the grave accent on ù consists of 2 diagonal pixels detached from the u", () => {
      // Row 0 col 16 (top pixel) and Row 1 col 17 (bottom pixel) form '\' diagonal
      expect(WORDMARK_GRID[0]![16]).toBe(WORDMARK_COLORS.ragu)
      expect(WORDMARK_GRID[1]![17]).toBe(WORDMARK_COLORS.ragu)

      // Detached space: row 1 col 16 and row 0 col 17 are empty
      expect(WORDMARK_GRID[1]![16]).toBe("")
      expect(WORDMARK_GRID[0]![17]).toBe("")

      // The interior top of the u (rows 2 and 3 at cols 16-17) is empty
      expect(WORDMARK_GRID[2]![16]).toBe("")
      expect(WORDMARK_GRID[2]![17]).toBe("")
      expect(WORDMARK_GRID[3]![16]).toBe("")
      expect(WORDMARK_GRID[3]![17]).toBe("")
    })

    test("Ragù uses pomodoro/tinted shadow and Code uses basil/tinted shadow with gap", () => {
      // Ragù cols (0..18)
      const raguPixels = WORDMARK_GRID.flatMap((row) => row.slice(0, 19)).filter(Boolean)
      expect(raguPixels).toContain(WORDMARK_COLORS.ragu)
      expect(raguPixels).toContain(WORDMARK_COLORS.raguShadow)
      expect(raguPixels).not.toContain(WORDMARK_COLORS.code)

      // Gap cols (19..20) are completely empty
      for (const row of WORDMARK_GRID) {
        expect(row[19]).toBe("")
        expect(row[20]).toBe("")
      }

      // Code cols (21..39)
      const codePixels = WORDMARK_GRID.flatMap((row) => row.slice(21)).filter(Boolean)
      expect(codePixels).toContain(WORDMARK_COLORS.code)
      expect(codePixels).toContain(WORDMARK_COLORS.codeShadow)
      expect(codePixels).not.toContain(WORDMARK_COLORS.ragu)
    })
  })
})

