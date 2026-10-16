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
  WORDMARK_MATRIX,
  WORDMARK_SIZE,
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
    test("every row in the wordmark has identical length matching WORDMARK_SIZE (100x14)", () => {
      expect(WORDMARK_MATRIX.length).toBe(WORDMARK_SIZE.height)
      for (const row of WORDMARK_MATRIX) {
        expect(row.length).toBe(WORDMARK_SIZE.width)
      }
      expect(WORDMARK_SIZE.width).toBe(100)
      expect(WORDMARK_SIZE.height).toBe(14)
    })

    test("every pixel in the wordmark belongs to the approved palette", () => {
      const allowedKeys = new Set(Object.keys(SPLASH_PALETTE))
      for (const row of WORDMARK_MATRIX) {
        for (const char of row) {
          expect(allowedKeys.has(char)).toBe(true)
        }
      }
    })

    test("uppercase R and C are at least 7 pixels high", () => {
      // Uppercase letters span from row 3 to row 9 (7 rows)
      const rUpper = WORDMARK_MATRIX[3]!.slice(1, 10)
      const cUpper = WORDMARK_MATRIX[3]!.slice(52, 62)
      expect(rUpper).toContain("a")
      expect(cUpper).toContain("a")

      const rBase = WORDMARK_MATRIX[9]!.slice(1, 10)
      const cBase = WORDMARK_MATRIX[9]!.slice(52, 62)
      expect(rBase).toContain("f")
      expect(cBase).toContain("c")
    })

    test("letter d has an ascender extending above the lowercase x-height", () => {
      // Row 3 contains the ascender of 'd' (cols 75..84)
      const row3D = WORDMARK_MATRIX[3]!.slice(75, 85)
      expect(row3D).toContain("a")

      // Lowercase 'a' on row 3 has no ascender (it is empty)
      const row3A = WORDMARK_MATRIX[3]!.slice(13, 22)
      expect(row3A.replaceAll(".", "")).toBe("")
    })

    test("letter g has a descender reaching below the baseline", () => {
      // Baseline is row 9. Rows 11 and 12 contain the descender loop of 'g' (cols 24..32)
      const row11G = WORDMARK_MATRIX[11]!.slice(24, 33)
      const row12G = WORDMARK_MATRIX[12]!.slice(24, 33)
      expect(row11G).toContain("f")
      expect(row12G).toContain("f")

      // Other letters like 'a' have no descender on row 11
      const row11A = WORDMARK_MATRIX[11]!.slice(13, 22)
      expect(row11A.replaceAll(".", "")).toBe("")
    })

    test("the grave accent on the letter ù is well-detached above the letter", () => {
      const row0 = WORDMARK_MATRIX[0]!
      const row1 = WORDMARK_MATRIX[1]!
      const row2 = WORDMARK_MATRIX[2]!

      // Accent pixels on rows 0 and 1 around col 38..40
      expect(row0.slice(37, 41)).toContain("j")
      expect(row1.slice(38, 42)).toContain("i")

      // Row 2 is empty space separating the accent from the letter body
      expect(row2.slice(35, 45).replaceAll(".", "")).toBe("")
    })

    test("Ragù is styled in tomato red/cream and Code in basil green", () => {
      const raguChars = WORDMARK_MATRIX.map((r) => r.slice(0, 48)).join("")
      expect(raguChars).toContain("f") // pomodoro vivo
      expect(raguChars).toContain("e") // pomodoro medio
      expect(raguChars).toContain("j") // panna highlight
      expect(raguChars).not.toContain("c") // no basilico in Ragù

      const codeChars = WORDMARK_MATRIX.map((r) => r.slice(50)).join("")
      expect(codeChars).toContain("c") // basilico chiaro
      expect(codeChars).not.toContain("f") // no pomodoro in Code
    })
  })
})
