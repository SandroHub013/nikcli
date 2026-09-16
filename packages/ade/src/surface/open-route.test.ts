import { describe, expect, test } from "bun:test"
import { MODEL_EXTENSIONS } from "../model3d/model"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import { routeForFile } from "./open-route"

describe("routeForFile", () => {
  test("every format the video panel plays opens a video panel, whatever the case or folder", () => {
    for (const extension of PLAYABLE_EXTENSIONS) {
      expect(`${extension}: ${routeForFile(`C:\progetto\video\demo.${extension}`)}`).toBe(`${extension}: video`)
      expect(`${extension}: ${routeForFile(`/home/me/clip.${extension.toUpperCase()}`)}`).toBe(`${extension}: video`)
    }
    expect(routeForFile("registrazioni/ADE 2026-09-16.mp4")).toBe("video")
  })

  test("models still open the 3D panel", () => {
    for (const extension of MODEL_EXTENSIONS) expect(routeForFile(`assets/robot.${extension}`)).toBe("model")
  })

  test("everything else opens the editor, formats the panel cannot play included", () => {
    for (const path of ["src/index.ts", "README.md", "film.mkv", "film.avi", "mp4", "note.mp4.txt", "Makefile"]) {
      expect(`${path}: ${routeForFile(path)}`).toBe(`${path}: editor`)
    }
  })
})
