import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The parts `workbench.tsx` was cut into (results/piano-workbench-split.md), relative to `src/`, in the order they were
 * cut. Each step of the split adds its new module here, in the same commit that moves the code.
 */
export const WORKBENCH_PARTS = ["surface/workbench.tsx"] as const

const SRC = join(import.meta.dir, "..")

/**
 * The workbench and every part cut out of it, as one text, LF only: a lint pins the app's wiring, not the file it sits
 * in. Every test that reads the workbench's source reads it through here, so a move of code out of `workbench.tsx`
 * turns no pin red (`workbench-source.test.ts` sees to it that none reads the file directly).
 */
export function workbenchSource(): string {
  return WORKBENCH_PARTS.map((part) => readFileSync(join(SRC, part), "utf8").replace(/\r\n/g, "\n")).join("\n")
}
