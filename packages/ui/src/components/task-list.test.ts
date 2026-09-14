import { describe, expect, test } from "bun:test"
import { currentTask, taskProgress, taskState, type TaskItem } from "./task-list"

/**
 * Statuses arrive from the server as free-form strings, so the mapping has to be
 * total: an unrecognised value must still render as something rather than
 * dropping the task out of the list.
 */

const item = (id: string, status: string, content = id): TaskItem => ({ id, status, content })

describe("taskState", () => {
  test.each([
    ["pending", "pending"],
    ["in_progress", "active"],
    ["completed", "done"],
    ["cancelled", "cancelled"],
  ])("maps %p to %p", (status, expected) => {
    expect(taskState(status)).toBe(expected as ReturnType<typeof taskState>)
  })

  test.each(["", "queued", "IN_PROGRESS", "blocked", "unknown-future-status"])(
    "degrades %p to pending rather than losing the task",
    (status) => {
      expect(taskState(status)).toBe("pending")
    },
  )
})

describe("taskProgress", () => {
  test("counts nothing for an empty list", () => {
    expect(taskProgress([])).toEqual({ done: 0, total: 0 })
  })

  test("drops cancelled work from the denominator instead of scoring it as done", () => {
    expect(
      taskProgress([item("a", "completed"), item("b", "cancelled"), item("c", "in_progress"), item("d", "pending")]),
    ).toEqual({ done: 1, total: 3 })
  })

  test("the ratio matches the ticks the list actually draws", () => {
    // Only `completed` renders a success tick, so only `completed` may count.
    const items = [item("a", "completed"), item("b", "completed"), item("c", "cancelled"), item("d", "pending")]
    const ticks = items.filter((entry) => taskState(entry.status) === "done").length
    expect(taskProgress(items).done).toBe(ticks)
  })

  test("a fully cancelled list reads as nothing to do, not as complete", () => {
    expect(taskProgress([item("a", "cancelled"), item("b", "cancelled")])).toEqual({ done: 0, total: 0 })
  })

  test("never reports more done than total", () => {
    const items = [item("a", "completed"), item("b", "completed")]
    const progress = taskProgress(items)
    expect(progress.done).toBeLessThanOrEqual(progress.total)
  })
})

describe("currentTask", () => {
  test("prefers the task actually in flight", () => {
    expect(
      currentTask([item("a", "pending"), item("b", "in_progress"), item("c", "pending")])?.id,
    ).toBe("b")
  })

  test("falls back to the next pending task", () => {
    expect(currentTask([item("a", "completed"), item("b", "pending"), item("c", "pending")])?.id).toBe("b")
  })

  test("returns nothing when everything is settled", () => {
    expect(currentTask([item("a", "completed"), item("b", "cancelled")])).toBeUndefined()
  })

  test("returns nothing for an empty list", () => {
    expect(currentTask([])).toBeUndefined()
  })

  test("treats an unknown status as pending work, not as finished", () => {
    expect(currentTask([item("a", "completed"), item("b", "weird")])?.id).toBe("b")
  })
})
