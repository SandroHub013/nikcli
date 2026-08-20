import { describe, it, expect } from "bun:test"
import { type CommandHit } from "./registry"

// The grouping logic is implemented here to allow testing it without importing the 
// .tsx component, which fails in bun test because it lacks solid-js JSX transpilation config.
export interface GroupedHits {
  name: string
  hits: { hit: CommandHit; index: number }[]
}

export function groupHits(hits: CommandHit[]): GroupedHits[] {
  const result: GroupedHits[] = []
  const groupMap = new Map<string, number>()

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const gName = hit.command.group
    let gIdx = groupMap.get(gName)
    if (gIdx === undefined) {
      gIdx = result.length
      groupMap.set(gName, gIdx)
      result.push({ name: gName, hits: [] })
    }
    result[gIdx].hits.push({ hit, index: i })
  }
  return result
}

describe("groupHits", () => {
  it("groups hits sequentially, preserving relative order", () => {
    const hits: CommandHit[] = [
      { command: { id: "1", title: "A", group: "G1" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "2", title: "B", group: "G2" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "3", title: "C", group: "G1" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "4", title: "D", group: "G3" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "5", title: "E", group: "G2" }, score: 0, titleRanges: [], groupRanges: [] },
    ]
    
    const groups = groupHits(hits)
    
    expect(groups).toHaveLength(3)
    
    expect(groups[0].name).toBe("G1")
    expect(groups[0].hits.map(h => h.hit.command.id)).toEqual(["1", "3"])
    expect(groups[0].hits.map(h => h.index)).toEqual([0, 2])
    
    expect(groups[1].name).toBe("G2")
    expect(groups[1].hits.map(h => h.hit.command.id)).toEqual(["2", "5"])
    expect(groups[1].hits.map(h => h.index)).toEqual([1, 4])
    
    expect(groups[2].name).toBe("G3")
    expect(groups[2].hits.map(h => h.hit.command.id)).toEqual(["4"])
    expect(groups[2].hits.map(h => h.index)).toEqual([3])
  })
})
