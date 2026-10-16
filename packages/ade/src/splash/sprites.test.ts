import { describe, expect, test } from "bun:test"
import {
  DEVELOPER_POSE_NAMES,
  DEVELOPER_POSES,
  DEVELOPER_SPRITE_SIZE,
  POT_FRAMES,
  POT_SPRITE_SIZE,
  SPLASH_PALETTE,
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
      // The lower body (rows 10-14) must be grounded in all frames
      for (const frame of POT_FRAMES) {
        // Row 14 is the base outline: "....aaaaaaaa...."
        expect(frame[14]).toBe("....aaaaaaaa....")
        // Row 13 is the bottom shadow: "...adddddddda..."
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

    test("every developer pose has identical dimensions matching DEVELOPER_SPRITE_SIZE (20x24)", () => {
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

  describe("wordmark (Ragù Code)", () => {
    test("every row in the wordmark has identical length matching WORDMARK_SIZE", () => {
      expect(WORDMARK_MATRIX.length).toBe(WORDMARK_SIZE.height)
      for (const row of WORDMARK_MATRIX) {
        expect(row.length).toBe(WORDMARK_SIZE.width)
      }
    })

    test("every pixel in the wordmark belongs to the approved palette", () => {
      const allowedKeys = new Set(Object.keys(SPLASH_PALETTE))
      for (const row of WORDMARK_MATRIX) {
        for (const char of row) {
          expect(allowedKeys.has(char)).toBe(true)
        }
      }
    })

    test("the grave accent on the letter ù is present and clearly visible above the letter", () => {
      // The letter ù is located around columns 22 to 27.
      // Rows 0 and 1 contain the grave accent (\ slant).
      const row0 = WORDMARK_MATRIX[0]!
      const row1 = WORDMARK_MATRIX[1]!
      const row2 = WORDMARK_MATRIX[2]!
      const row3 = WORDMARK_MATRIX[3]!

      // Row 0 has accent top pixel at col 23
      expect(row0[23]).toBe("j")
      // Row 1 has accent bottom pixel at col 24
      expect(row1[24]).toBe("i")

      // The space around the accent on rows 0 and 1 is transparent
      expect(row0.slice(0, 23).replaceAll(".", "")).toBe("")
      expect(row0.slice(24).replaceAll(".", "")).toBe("")
      expect(row1.slice(0, 24).replaceAll(".", "")).toBe("")
      expect(row1.slice(25).replaceAll(".", "")).toBe("")

      // Row 2 and 3 have the stems of the letter u underneath
      expect(row2.slice(22, 28)).toContain("i")
      expect(row3.slice(22, 28)).toContain("f")
    })

    test("Ragù is styled in tomato red/cream and Code in basil green", () => {
      // Columns 0 to 28 ("Ragù"): must contain pomodoro red ('f' / 'e') and cream ('i' / 'j')
      const raguChars = WORDMARK_MATRIX.map((r) => r.slice(0, 29)).join("")
      expect(raguChars).toContain("f") // pomodoro vivo
      expect(raguChars).toContain("e") // pomodoro medio
      expect(raguChars).toContain("i") // crema
      expect(raguChars).not.toContain("c") // no basilico in Ragù

      // Columns 30 to 64 ("Code"): must contain basil green ('c' / 'b')
      const codeChars = WORDMARK_MATRIX.map((r) => r.slice(30)).join("")
      expect(codeChars).toContain("c") // basilico chiaro
      expect(codeChars).not.toContain("f") // no pomodoro in Code
    })
  })
})
