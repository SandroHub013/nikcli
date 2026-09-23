/**
 * TEMP (P1-C2 A/B): `localStorage["ade.p1.c2"] = "off"`, then a reload, goes
 * back to the reads before C2a, C2b and C2c. Remove before merging.
 */
export function p1c2Off(): boolean {
  try {
    return globalThis.localStorage?.getItem("ade.p1.c2") === "off"
  } catch {
    return false
  }
}
