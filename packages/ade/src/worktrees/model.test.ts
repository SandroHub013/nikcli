import { describe, expect, test } from "bun:test"
import {
  conflicts,
  isHolding,
  riskOf,
  sortForBoard,
  type Occupant,
  type Worktree,
} from "./model"

function makeTree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "wt-1",
    projectId: "proj-alpha",
    name: "principale",
    path: "/repo/alpha/main",
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: 0,
    occupants: [],
    updatedAt: 1000,
    ...overrides,
  }
}

describe("isHolding", () => {
  test("working occupant is holding", () => {
    const occupant: Occupant = { sessionId: "s1", agentId: "agy", state: "working" }
    expect(isHolding(occupant)).toBe(true)
  })

  test("waiting occupant is holding", () => {
    const occupant: Occupant = { sessionId: "s2", agentId: "kimi", state: "waiting" }
    expect(isHolding(occupant)).toBe(true)
  })

  test("stopped occupant is NOT holding", () => {
    const occupant: Occupant = { sessionId: "s3", agentId: "claude", state: "stopped" }
    expect(isHolding(occupant)).toBe(false)
  })
})

describe("riskOf", () => {
  test("returns libero for zero occupants", () => {
    const tree = makeTree({ occupants: [] })
    expect(riskOf(tree)).toBe("libero")
  })

  test("returns occupato for one working occupant", () => {
    const tree = makeTree({
      occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
    })
    expect(riskOf(tree)).toBe("occupato")
  })

  test("returns occupato for one waiting occupant", () => {
    const tree = makeTree({
      occupants: [{ sessionId: "s1", agentId: "kimi", state: "waiting" }],
    })
    expect(riskOf(tree)).toBe("occupato")
  })

  test("returns libero for one stopped occupant (stopped does not hold tree)", () => {
    const tree = makeTree({
      occupants: [{ sessionId: "s1", agentId: "agy", state: "stopped" }],
    })
    expect(riskOf(tree)).toBe("libero")
  })

  test("returns libero for multiple stopped occupants", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "stopped" },
        { sessionId: "s2", agentId: "kimi", state: "stopped" },
      ],
    })
    expect(riskOf(tree)).toBe("libero")
  })

  test("returns occupato for one working occupant alongside a stopped occupant (no conflict)", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "stopped" },
      ],
    })
    expect(riskOf(tree)).toBe("occupato")
  })

  test("returns occupato for one waiting occupant alongside a stopped occupant", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "waiting" },
        { sessionId: "s2", agentId: "kimi", state: "stopped" },
      ],
    })
    expect(riskOf(tree)).toBe("occupato")
  })

  test("returns conflitto for two working occupants", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "working" },
      ],
    })
    expect(riskOf(tree)).toBe("conflitto")
  })

  test("returns conflitto for one working and one waiting occupant", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "waiting" },
      ],
    })
    expect(riskOf(tree)).toBe("conflitto")
  })

  test("returns conflitto for two waiting occupants", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "waiting" },
        { sessionId: "s2", agentId: "kimi", state: "waiting" },
      ],
    })
    expect(riskOf(tree)).toBe("conflitto")
  })

  test("returns conflitto for multiple active occupants plus stopped occupants", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "waiting" },
        { sessionId: "s3", agentId: "claude", state: "stopped" },
      ],
    })
    expect(riskOf(tree)).toBe("conflitto")
  })

  test("returns conflitto for three active working occupants", () => {
    const tree = makeTree({
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "working" },
        { sessionId: "s3", agentId: "claude", state: "working" },
      ],
    })
    expect(riskOf(tree)).toBe("conflitto")
  })
})

describe("conflicts", () => {
  test("returns empty array when no trees are in conflict", () => {
    const t1 = makeTree({ id: "t1", occupants: [] })
    const t2 = makeTree({
      id: "t2",
      occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
    })
    expect(conflicts([t1, t2])).toEqual([])
  })

  test("filters only conflicted trees from a mixed list", () => {
    const free = makeTree({ id: "free", occupants: [] })
    const occupied = makeTree({
      id: "occ",
      occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
    })
    const conflicted1 = makeTree({
      id: "conf1",
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "working" },
      ],
    })
    const conflicted2 = makeTree({
      id: "conf2",
      occupants: [
        { sessionId: "s3", agentId: "agy", state: "working" },
        { sessionId: "s4", agentId: "claude", state: "waiting" },
      ],
    })

    const result = conflicts([free, conflicted1, occupied, conflicted2])
    expect(result.map((t) => t.id)).toEqual(["conf1", "conf2"])
  })
})

describe("sortForBoard", () => {
  test("prioritizes conflitto over occupato over libero", () => {
    const libero = makeTree({ id: "lib", name: "c-libero", occupants: [] })
    const occupato = makeTree({
      id: "occ",
      name: "b-occupato",
      occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
    })
    const conflitto = makeTree({
      id: "conf",
      name: "a-conflitto",
      occupants: [
        { sessionId: "s1", agentId: "agy", state: "working" },
        { sessionId: "s2", agentId: "kimi", state: "working" },
      ],
    })

    const sorted = sortForBoard([libero, occupato, conflitto])
    expect(sorted.map((t) => t.id)).toEqual(["conf", "occ", "lib"])
  })

  test("within same risk tier, prioritizes higher dirty count", () => {
    const cleanOccupied = makeTree({
      id: "clean",
      dirty: 0,
      occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
    })
    const dirtyOccupied = makeTree({
      id: "dirty",
      dirty: 5,
      occupants: [{ sessionId: "s2", agentId: "kimi", state: "working" }],
    })

    const sorted = sortForBoard([cleanOccupied, dirtyOccupied])
    expect(sorted.map((t) => t.id)).toEqual(["dirty", "clean"])
  })

  test("within same risk and dirty count, prioritizes more recent updatedAt", () => {
    const older = makeTree({
      id: "older",
      dirty: 2,
      updatedAt: 1000,
      occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
    })
    const newer = makeTree({
      id: "newer",
      dirty: 2,
      updatedAt: 5000,
      occupants: [{ sessionId: "s2", agentId: "kimi", state: "working" }],
    })

    const sorted = sortForBoard([older, newer])
    expect(sorted.map((t) => t.id)).toEqual(["newer", "older"])
  })

  test("within same risk, dirty, and updatedAt, sorts alphabetically by name", () => {
    const treeB = makeTree({ id: "b", name: "beta", updatedAt: 1000, dirty: 0, occupants: [] })
    const treeA = makeTree({ id: "a", name: "alpha", updatedAt: 1000, dirty: 0, occupants: [] })
    const treeC = makeTree({ id: "c", name: "gamma", updatedAt: 1000, dirty: 0, occupants: [] })

    const sorted = sortForBoard([treeB, treeC, treeA])
    expect(sorted.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"])
  })

  test("does not mutate the input array", () => {
    const trees = [
      makeTree({ id: "lib", occupants: [] }),
      makeTree({
        id: "conf",
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "working" },
        ],
      }),
    ]
    const copy = [...trees]
    sortForBoard(trees)
    expect(trees.map((t) => t.id)).toEqual(copy.map((t) => t.id))
  })
})
