import { Identifier } from "@ragu/util/id"
import { PermissionRuleset } from "../permission/ruleset"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"
import * as fs from "fs"
import path from "path"
import { DIR as TruncationDir, GLOB as TruncationGlob, outputPath } from "./truncation-dir"
import { Context, Effect, Layer } from "effect"
import { AppRuntime } from "@/effect"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 50 * 1024
  export const HEAD_TAIL_THRESHOLD = 8_000
  export const HEAD_CHARS = 1_000
  export const TAIL_CHARS = 7_000
  export const DIR = TruncationDir
  export const GLOB = TruncationGlob
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const HOUR_MS = 60 * 60 * 1000

  export function truncateHeadTail(
    text: string,
    options?: {
      maxChars?: number
      headChars?: number
      tailChars?: number
      existingPath?: string
      toolName?: string
      dir?: string
    },
  ): { content: string; truncated: boolean; outputPath?: string } {
    const maxChars = options?.maxChars ?? HEAD_TAIL_THRESHOLD
    if (text.length <= maxChars) {
      return { content: text, truncated: false }
    }

    let headChars = options?.headChars ?? HEAD_CHARS
    let tailChars = options?.tailChars ?? TAIL_CHARS

    // Do not split a surrogate pair on the cut boundary (shift by 1 character if slice falls mid-pair)
    if (headChars > 0 && headChars < text.length) {
      const prev = text.charCodeAt(headChars - 1)
      const curr = text.charCodeAt(headChars)
      if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
        headChars -= 1
      }
    }

    if (tailChars > 0 && tailChars < text.length) {
      const tailIndex = text.length - tailChars
      const prev = text.charCodeAt(tailIndex - 1)
      const curr = text.charCodeAt(tailIndex)
      if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
        tailChars -= 1
      }
    }

    const dir = options?.dir ?? DIR
    let filepath = options?.existingPath
    let saved = false
    if (!filepath) {
      const id = Identifier.ascending("tool")
      filepath = path.join(dir, id)
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filepath, text, "utf-8")
        saved = true
      } catch {
        saved = false
        filepath = undefined
      }
    } else {
      saved = true
    }

    const head = text.slice(0, headChars)
    const tail = tailChars > 0 ? text.slice(-tailChars) : ""
    const omitted = Math.max(0, text.length - head.length - tail.length)

    const saveMsg =
      saved && filepath
        ? `Full output saved to: ${filepath}. Use Grep or Read with offset/limit to see more.`
        : `Full output was not saved to disk.`

    const message = `${head}\n\n... [The tool call succeeded but the output was truncated (${omitted} characters omitted). ${saveMsg}] ...\n\n${tail}`

    return {
      content: message,
      truncated: true,
      outputPath: saved ? filepath : undefined,
    }
  }

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly cleanup: () => Effect.Effect<void>
    readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  }

  export class Service extends Context.Service<Service, Interface>()("@ragu/Truncate") {}

  export const layer = Layer.effect(
    Service,
    Effect.sync(() => {
      const cleanup = Effect.fn("Truncate.cleanup")(function* () {
        const cutoff = Identifier.timestamp(Identifier.create("tool", false, Date.now() - RETENTION_MS))
        const glob = new Bun.Glob("tool_*")
        const entries = yield* Effect.promise(() =>
          Array.fromAsync(glob.scan({ cwd: DIR, onlyFiles: true })).catch((): string[] => []),
        )
        for (const entry of entries) {
          if (Identifier.timestamp(entry) >= cutoff) continue
          yield* Effect.promise(() =>
            Bun.file(outputPath(entry))
              .delete()
              .catch(() => {}),
          )
        }
      })

      function hasTaskTool(agent?: Agent.Info): boolean {
        if (!agent?.permission) return false
        const rule = PermissionRuleset.evaluate("task", "*", agent.permission)
        return rule.action !== "deny"
      }

      const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
        const maxLines = options.maxLines ?? MAX_LINES
        const maxBytes = options.maxBytes ?? MAX_BYTES
        const direction = options.direction ?? "head"
        const lines = text.split("\n")
        const totalBytes = Buffer.byteLength(text, "utf-8")

        if (lines.length <= maxLines && totalBytes <= maxBytes) {
          return { content: text, truncated: false } satisfies Result
        }

        const out: string[] = []
        let i = 0
        let bytes = 0
        let hitBytes = false

        if (direction === "head") {
          for (i = 0; i < lines.length && i < maxLines; i++) {
            const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
            if (bytes + size > maxBytes) {
              hitBytes = true
              break
            }
            out.push(lines[i])
            bytes += size
          }
        } else {
          for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
            const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
            if (bytes + size > maxBytes) {
              hitBytes = true
              break
            }
            out.unshift(lines[i])
            bytes += size
          }
        }

        const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
        const unit = hitBytes ? "bytes" : "lines"
        const preview = out.join("\n")

        const id = Identifier.ascending("tool")
        const filepath = outputPath(id)
        yield* Effect.promise(() => Bun.write(filepath, text))

        const hint = hasTaskTool(agent)
          ? `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
          : `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
        const message =
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`

        return {
          content: message,
          truncated: true,
          outputPath: filepath,
        } satisfies Result
      })

      const init = Effect.fn("Truncate.init")(() =>
        Effect.sync(() =>
          Scheduler.register({
            id: "tool.truncation.cleanup",
            interval: HOUR_MS,
            run: () => AppRuntime.runPromise(cleanup()),
            scope: "global",
            skipInitialRun: true,
          }),
        ),
      )

      return Service.of({
        init,
        cleanup,
        output,
      })
    }),
  )

  export const defaultLayer = layer
}
