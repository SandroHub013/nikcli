import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RESUME } from "../session-new/resume"

/*
 * Review area 2, MEDIO: agy's `last_conversations.json` was read for the
 * project root while agy runs in the pane's worktree. A pane in a worktree
 * found nothing, or took the conversation of the pane in the root and
 * reopened it on the next start.
 */

test("the latest conversation is looked up for the folder the CLI runs in", () => {
  const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
  const call = source.slice(source.indexOf("latest.read("), source.indexOf("latest.read(") + 200)
  expect(call).toContain('?? "", workDir)')
  // And that folder is the one the process is started in.
  expect(source).toContain("const workDir = launched?.worktree || p.root")
  expect(source).toContain("cwd: workDir,")
})

test("the folder decides which entry is found", () => {
  const latest = RESUME.agy?.latest
  if (!latest) throw new Error("agy reads its latest conversation")
  const worktree = "C:/repo/.worktrees/ramo"
  const text = JSON.stringify({ [worktree]: "conv-ramo" })
  expect(latest.read(text, worktree)).toBe("conv-ramo")
  expect(latest.read(text, "C:/repo")).toBeUndefined()
})
