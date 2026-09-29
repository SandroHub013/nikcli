import { describe, expect, test } from "bun:test"
import { GATE_LIMITS, gateChecks, gatePasses, mean, type GateMeasures } from "./gate"

const good: GateMeasures = {
  frameMb: 96,
  adeGrowthAfter5sMb: 4.7,
  adeGrowthAtRestMb: 0.5,
  adeHeapGrowthMb: 0.1,
  immobileCpuPercent: 0.8,
  movingFps: 60,
}

describe("the NikVerse gate", () => {
  test("numbers under every ceiling pass", () => {
    expect(gatePasses(gateChecks(good))).toBe(true)
  })

  test("each ceiling turns the gate red on its own, by name", () => {
    const red = (change: Partial<GateMeasures>) =>
      gateChecks({ ...good, ...change })
        .filter((check) => !check.ok)
        .map((check) => check.name)
    expect(red({ frameMb: GATE_LIMITS.frameMb + 1 })).toEqual(["frame MB"])
    expect(red({ adeGrowthAfter5sMb: 5.2 })).toEqual(["ADE growth after 5 s, MB"])
    expect(red({ adeGrowthAtRestMb: 5.2 })).toEqual(["ADE growth at rest, MB"])
    expect(red({ adeHeapGrowthMb: 6 })).toEqual(["ADE heap growth, MB"])
    expect(red({ immobileCpuPercent: 3 })).toEqual(["immobile CPU (frame + GPU), %"])
    expect(red({ movingFps: 90 })).toEqual(["fps while moving"])
  })

  test("a measurement that could not be taken is red, not a pass", () => {
    expect(gatePasses(gateChecks({ ...good, frameMb: Number.NaN }))).toBe(false)
    expect(gatePasses(gateChecks({ ...good, immobileCpuPercent: mean([]) }))).toBe(false)
  })

  test("N2 as measured on the first live run is red on exactly the two things Dev is to fix", () => {
    const n2: GateMeasures = { ...good, frameMb: 95.8, adeGrowthAfter5sMb: 4.7, immobileCpuPercent: 4.5, movingFps: 82 }
    expect(
      gateChecks(n2)
        .filter((check) => !check.ok)
        .map((check) => check.name),
    ).toEqual(["immobile CPU (frame + GPU), %", "fps while moving"])
  })
})
