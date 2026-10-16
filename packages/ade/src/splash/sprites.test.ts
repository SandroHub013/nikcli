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

    test("every pot frame has identical dimensions matching POT_SPRITE_SIZE (32x32)", () => {
      for (const frame of POT_FRAMES) {
        expect(frame.length).toBe(POT_SPRITE_SIZE.height)
        for (const row of frame) {
          expect(row.length).toBe(POT_SPRITE_SIZE.width)
        }
      }
      expect(POT_SPRITE_SIZE.width).toBe(32)
      expect(POT_SPRITE_SIZE.height).toBe(32)
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

    test("pot base and handles match the iconic Ragu pot silhouette at 32x32 and are symmetric (P2-4)", () => {
      for (const frame of POT_FRAMES) {
        expect(frame[30]).toBe(".........dddddddddddd...........")
        expect(frame[29]).toBe(".......dddddddddddddddd.........")
        expect(frame[12]).toContain("i")
        expect(frame[13]).toContain("i")
        expect(frame[17]![0]).toBe("d")
        expect(frame[17]![31]).toBe("d")
        // Row 11 ends symmetrically without right-side bastoncino
        expect(frame[11]!.endsWith("dddd....")).toBe(true)
        // Crema rim rows 12 and 13 end symmetrically at col 27 with 4 dots
        expect(frame[12]!.endsWith("id....")).toBe(true)
        expect(frame[13]!.endsWith("id....")).toBe(true)
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

    test("developer height is human-scale alongside the 32x32 pot (34 vs 32 px)", () => {
      expect(DEVELOPER_SPRITE_SIZE.height).toBe(34)
      expect(POT_SPRITE_SIZE.height).toBe(32)
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

    test("developer is dressed in visible attire (basil hoodie and cream apron)", () => {
      for (const pose of DEVELOPER_POSES) {
        const bodyStr = pose.slice(15, 27).join("")
        expect(bodyStr).toContain("c") // basil green hoodie
        expect(bodyStr).toContain("i") // cream apron
        // No invisible dark body tones
        expect(bodyStr).not.toContain("l")
        expect(bodyStr).not.toContain("m")
      }
    })

    test("developer face has 1px eyes separated by 1px without dark mask", () => {
      const pronto = DEVELOPER_POSES[0]!
      // Row 10 is the eye row: cols 8..10 are eye (b), skin space (h), eye (b)
      expect(pronto[10]![8]).toBe("b")
      expect(pronto[10]![9]).toBe("h")
      expect(pronto[10]![10]).toBe("b")
      // Surrounding face pixels on eye row are peach skin 'h' (no dark band)
      expect(pronto[10]![6]).toBe("h")
      expect(pronto[10]![7]).toBe("h")
      expect(pronto[10]![11]).toBe("h")
      expect(pronto[10]![12]).toBe("h")
    })

    test("mescola poses reach hands toward pot for scene-space stirring (P2-4)", () => {
      const mescolaSinistra = DEVELOPER_POSES[1]!
      const mescolaDestra = DEVELOPER_POSES[2]!
      // In mescola sinistra, hand reaches toward pot
      expect(mescolaSinistra[16]![21]).toBe("h")

      // In mescola destra, hand reaches toward pot
      expect(mescolaDestra[15]![21]).toBe("h")
    })

    test("assaggia pose brings spoon to developer mouth (P2-4)", () => {
      const assaggia = DEVELOPER_POSES[4]!
      // Row 14: spoon bowl touches mouth at cols 11..12
      expect(assaggia[14]![11]).toBe("k")
      expect(assaggia[14]![12]).toBe("k")
    })

    test("pollice_su has distinct raised thumb (P2-4)", () => {
      const polliceSu = DEVELOPER_POSES[6]!
      // Row 13 has raised thumb at col 3 above fist at row 15
      expect(polliceSu[13]![3]).toBe("h")
      expect(polliceSu[14]![3]).toBe("h")
      expect(polliceSu[15]![2]).toBe("h")
      expect(polliceSu[15]![3]).toBe("h")
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

    test("counter tomato and basil have valid dimensions and no invisible outlines (P2-4, P3-3, P3-5)", () => {
      expect(TOMATO_SPRITE.length).toBe(TOMATO_SIZE.height)
      expect(TOMATO_SIZE.width).toBe(5)
      for (const row of TOMATO_SPRITE) {
        expect(row.length).toBe(5)
        expect(row).not.toContain("a")
      }
      expect(BASIL_SPRITE.length).toBe(BASIL_SIZE.height)
      expect(BASIL_SIZE.width).toBe(4)
      for (const row of BASIL_SPRITE) {
        expect(row.length).toBe(4)
        expect(row).not.toContain("a")
      }
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

    test("the grave accent on ù is a single pixel detached by 1 row from the u (P3-2)", () => {
      // Row 0 col 16 (top pixel) is filled with ragù color
      expect(WORDMARK_GRID[0]![16]).toBe(WORDMARK_COLORS.ragu)
      expect(WORDMARK_GRID[0]![17]).toBe("")

      // Row 1 (y=1) is completely empty across the u columns, giving a full 1-row detachment
      for (let col = 15; col <= 18; col++) {
        expect(WORDMARK_GRID[1]![col]).toBe("")
      }

      // The top of the u starts on row 2 (y=2)
      expect(WORDMARK_GRID[2]![15]).toBe(WORDMARK_COLORS.ragu)
      expect(WORDMARK_GRID[2]![16]).toBe("")
      expect(WORDMARK_GRID[2]![17]).toBe("")
      expect(WORDMARK_GRID[2]![18]).toBe(WORDMARK_COLORS.ragu)
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

