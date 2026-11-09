import { describe, expect, test } from "bun:test"
import { alreadyOpen, waitForSeek, type WaitableVideo } from "./media-wait"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** A stand-in for the element: an event target with the two fields the waits read, and a count of its listeners. */
function fakeVideo(readyState = 4, currentTime = 0) {
  const target = new EventTarget() as WaitableVideo & { listeners: number }
  target.currentTime = currentTime
  target.readyState = readyState
  target.listeners = 0
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  target.addEventListener = ((...args: Parameters<typeof add>) => {
    target.listeners++
    return add(...args)
  }) as typeof target.addEventListener
  target.removeEventListener = ((...args: Parameters<typeof remove>) => {
    target.listeners--
    return remove(...args)
  }) as typeof target.removeEventListener
  return target
}

describe("waitForSeek (MOD-13)", () => {
  test("with no event, it resolves at the timeout with where the video is", async () => {
    const video = fakeVideo(4, 1)
    const where = await waitForSeek(video, 9, 20)
    expect(where).toBe(9)
    expect(video.listeners).toBe(0)
  })

  test("an error resolves it at once, and removes both listeners", async () => {
    const video = fakeVideo(4, 1)
    const pending = waitForSeek(video, 9, 5000)
    video.dispatchEvent(new Event("error"))
    expect(await pending).toBe(9)
    expect(video.listeners).toBe(0)
  })

  test("seeked resolves it with the position it reports", async () => {
    const video = fakeVideo(4, 1)
    const pending = waitForSeek(video, 9, 5000)
    video.currentTime = 8.5
    video.dispatchEvent(new Event("seeked"))
    expect(await pending).toBe(8.5)
    expect(video.listeners).toBe(0)
  })

  test("a seek to where the video already is answers without an event", async () => {
    const video = fakeVideo(4, 3)
    expect(await waitForSeek(video, 3, 5000)).toBe(3)
    expect(video.listeners).toBe(0)
  })
})

describe("alreadyOpen (MOD-13)", () => {
  test("the same path, with its metadata in, is already open", () => {
    expect(alreadyOpen({ readyState: 1 }, "C:/v/a.mp4", "C:/v/a.mp4")).toBe(true)
    expect(alreadyOpen({ readyState: 4 }, "C:/v/a.mp4", "C:/v/a.mp4")).toBe(true)
  })

  test("another path, or a file whose metadata is not in, or no element, is not", () => {
    expect(alreadyOpen({ readyState: 4 }, "C:/v/a.mp4", "C:/v/b.mp4")).toBe(false)
    expect(alreadyOpen({ readyState: 0 }, "C:/v/a.mp4", "C:/v/a.mp4")).toBe(false)
    expect(alreadyOpen(undefined, "C:/v/a.mp4", "C:/v/a.mp4")).toBe(false)
    expect(alreadyOpen({ readyState: 4 }, undefined, "C:/v/a.mp4")).toBe(false)
  })
})

describe("the pane uses them", () => {
  const source = readFileSync(join(import.meta.dir, "video-pane.tsx"), "utf8")

  test("seekTo is waitForSeek, and open asks alreadyOpen before it tells the host the path", () => {
    // `.includes` and a boolean: a failed `toContain` would print the whole file.
    expect(source.includes('from "./media-wait"')).toBe(true)
    expect(source.includes("await waitForSeek(video, seconds)")).toBe(true)
    expect(source.includes('addEventListener("seeked"')).toBe(false)
    const open = source.slice(source.indexOf("async open(path)"))
    expect(open.indexOf("alreadyOpen(") > -1).toBe(true)
    expect(open.indexOf("alreadyOpen(") < open.indexOf("props.onOpen(path)")).toBe(true)
  })
})
