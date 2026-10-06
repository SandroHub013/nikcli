import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "@nikcli-ai/util/id"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@nikcli-ai/util/token"
import { Log } from "@nikcli-ai/util/log"
import { SessionProcessor } from "./processor"
import { InstructionRepo } from "./instruction-repo"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Mod } from "@/mod"
import { Config } from "@/config/config"
import { zodObject } from "@nikcli-ai/util/effect-zod"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"
import { isOverflow as overflowCheck } from "./overflow"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  function agentGet(name: string, ctx: InstanceContext) {
    return runPromiseWithLayer(
      Agent.defaultLayer,
      locallyInstance(
        ctx,
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          return yield* agent.get(name)
        }),
      ),
    )
  }

  async function agentRequired(name: string, ctx: InstanceContext) {
    const agent = await agentGet(name, ctx)
    if (!agent) throw new Agent.NotFoundError({ name })
    return agent
  }

  function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>, ctx: InstanceContext) {
    return runPromiseWithLayer(Plugin.defaultLayer, locallyInstance(ctx, effect))
  }

  function runProvider<A, E>(effect: Effect.Effect<A, E, Provider.Service>, ctx: InstanceContext) {
    return runPromiseWithLayer(Provider.defaultLayer, locallyInstance(ctx, effect))
  }

  function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>, ctx: InstanceContext) {
    return runPromiseWithLayer(Session.defaultLayer, locallyInstance(ctx, effect))
  }

  function configGet(ctx: InstanceContext) {
    return runPromiseWithLayer(
      Config.defaultLayer,
      locallyInstance(
        ctx,
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.get()
        }),
      ),
    )
  }

  export const Event = {
    Compacted: BusEvent.schema(
      "session.compacted",
      Schema.Struct({
        sessionID: Schema.String,
      }),
    ),
  }

  const CreateInputSchema = Schema.Struct({
    sessionID: Schema.String.pipe(Schema.check(Schema.isStartsWith("ses"))),
    agent: Schema.String,
    model: Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
    }),
    auto: Schema.Boolean,
  })
  export const CreateInput = zodObject(CreateInputSchema)
  export type CreateInput = Schema.Schema.Type<typeof CreateInputSchema>

  export interface ProcessInput {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }

  export interface Interface {
    isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }): Effect.Effect<boolean, unknown>
    editContext(input: { sessionID: string; keepLastNTurns?: number }): Effect.Effect<void, unknown>
    prune(input: { sessionID: string }): Effect.Effect<void, unknown>
    pruneLoop(input: { sessionID: string }): Effect.Effect<number, unknown>
    process(input: ProcessInput): Effect.Effect<"continue" | "stop", unknown>
    create(input: CreateInput): Effect.Effect<void, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("SessionCompaction.Service") {}

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000
  /** Prompt size above which `pruneLoop` clears old tool outputs, and how much of the newest it leaves. */
  export const LOOP_PRUNE_BUDGET = 64_000
  export const LOOP_PRUNE_KEEP = 24_000
  export const LOOP_PRUNE_DIGEST_KEEP = 30

  /**
   * Cap consecutive compaction failures per session before refusing to start
   * another compaction attempt. Prevents infinite loops when the model's
   * context window is too small to fit the compacted summary. See opencode
   * upstream #38102.
   */
  export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3
  const compactionFailures = new Map<string, number>()

  /** Increment the per-session consecutive-failure counter and return the new value. */
  export function recordCompactionFailure(sessionID: string): number {
    const count = (compactionFailures.get(sessionID) ?? 0) + 1
    compactionFailures.set(sessionID, count)
    return count
  }

  /** Reset the per-session consecutive-failure counter (called on success). */
  export function resetCompactionFailures(sessionID: string): void {
    compactionFailures.delete(sessionID)
  }

  /** True when the session has hit the failure cap. */
  export function isCompactionCircuitOpen(sessionID: string): boolean {
    return (compactionFailures.get(sessionID) ?? 0) >= MAX_CONSECUTIVE_COMPACTION_FAILURES
  }

  /** Test seam: clear all tracked failures. */
  export function clearAllCompactionFailures(): void {
    compactionFailures.clear()
  }

  /**
   * Raised when a session has hit the consecutive-compaction-failure cap. The
   * caller (typically `Session.process`) should surface this to the user as
   * an actionable error and stop attempting compaction for this session.
   */
  export class CircuitOpenError extends Error {
    readonly sessionID: string
    readonly failures: number
    constructor(input: { sessionID: string; failures: number; message: string }) {
      super(input.message)
      this.name = "SessionCompactionCircuitOpenError"
      this.sessionID = input.sessionID
      this.failures = input.failures
    }
  }

  const PRUNE_PROTECTED_TOOLS = ["skill"]
  const LOOP_PRUNE_TODO_TOOLS = ["todowrite", "todoread"]

  // Removes tool results older than keepLastNTurns user turns regardless of size,
  // allowing the context window to stay clean for long sessions.
  async function editContextImpl(input: {
    sessionID: string
    keepLastNTurns?: number
    config: Config.Info
    ctx: InstanceContext
  }): Promise<void> {
    const config = input.config
    if (config.compaction?.prune === false) return

    const keepTurns = input.keepLastNTurns ?? 10
    const msgs = await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.messages({ sessionID: input.sessionID })
      }),
      input.ctx,
    )
    let turns = 0
    const toPrune: MessageV2.ToolPart[] = []

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role === "user") turns++
      if (turns < keepTurns) continue
      if (msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).summary) break

      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue
        if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
        if (part.state.time.compacted) break
        toPrune.push(part)
      }
    }

    for (const part of toPrune) {
      if (part.state.status === "completed") {
        part.state.time.compacted = Date.now()
        await runSession(
          Effect.gen(function* () {
            const session = yield* Session.Service
            yield* session.updatePart(part)
          }),
          input.ctx,
        )
      }
    }
    log.info("editContext pruned", { count: toPrune.length })
  }

  async function pruneImpl(input: { sessionID: string; config: Config.Info; ctx: InstanceContext }) {
    const config = input.config
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.messages({ sessionID: input.sessionID })
      }),
      input.ctx,
    )
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await runSession(
            Effect.gen(function* () {
              const session = yield* Session.Service
              yield* session.updatePart(part)
            }),
            input.ctx,
          )
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  /**
   * Prune between two steps of one prompt, for tasks that run long on a single user message
   * (`pruneImpl` needs two user turns and only runs when the loop ends).
   *
   * What fills a long prompt is not only tool output: on a reasoning model the replayed reasoning
   * of every earlier step is most of it (in a 90-step ARC run, ~100k of 160k tokens against ~27k of
   * tool output). So the unit is the step: an old step loses its tool outputs and, unless
   * `pruneReasoning` is off, the reasoning it would send back.
   *
   * Every prune rewrites the prompt from the first cleared step onward, so the provider re-reads
   * all of that uncached. It therefore runs in blocks: only once the prompt the provider reported
   * for the last step passes the budget, and only when at least half a budget can be freed at once.
   * Afterwards the prompt is well under the budget and nothing happens until it grows back.
   *
   * Left alone: steps holding a `skill` output or the newest todo output (the todo state has to
   * stay readable), the last step (the model has not seen its outputs yet), steps still running,
   * and the newest `pruneKeep` tokens of steps. Returns how many steps were cleared.
   */
  async function pruneLoopImpl(input: { sessionID: string; config: Config.Info; ctx: InstanceContext }) {
    const compaction = input.config.compaction
    if (compaction?.prune === false) return 0
    const budget = compaction?.pruneBudget ?? LOOP_PRUNE_BUDGET
    const keep = Math.min(compaction?.pruneKeep ?? LOOP_PRUNE_KEEP, budget)
    const pruneReasoning = compaction?.pruneReasoning !== false
    const digest = pruneReasoning && compaction?.pruneDigest !== false
    const digestKeep = compaction?.pruneDigestKeep ?? LOOP_PRUNE_DIGEST_KEEP
    const msgs = await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.messages({ sessionID: input.sessionID })
      }),
      input.ctx,
    )

    // The prompt the provider reported for the newest finished step, not an estimate.
    let promptTokens: number | undefined
    let newestAssistant = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info
      if (info.role !== "assistant") continue
      if (newestAssistant === -1) newestAssistant = i
      if (!info.finish) continue
      if (info.summary) return 0
      promptTokens = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write
      break
    }
    if (promptTokens === undefined || promptTokens <= budget) return 0

    type Step = { tools: MessageV2.ToolPart[]; reasoning: MessageV2.ReasoningPart[] }
    const steps: Step[] = []
    // Every step that is cleared once this pass is done, newest first: earlier prunes' and this one's.
    const cleared: MessageV2.ToolPart[][] = []
    let total = 0
    let freed = 0
    let todoKept = false
    let protectedSteps = 0
    scan: for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role !== "assistant") continue
      if (msg.info.summary) break scan
      if (i === newestAssistant) continue
      const tools = msg.parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
      if (tools.length === 0) continue
      // A step still running, or one holding what must stay readable, is left whole.
      if (tools.some((p) => p.state.status === "pending" || p.state.status === "running")) continue
      const holdsTodo = tools.some((p) => LOOP_PRUNE_TODO_TOOLS.includes(p.tool))
      const keepsTodo = holdsTodo && !todoKept
      if (holdsTodo) todoKept = true
      if (keepsTodo || tools.some((p) => PRUNE_PROTECTED_TOOLS.includes(p.tool))) {
        protectedSteps++
        continue
      }
      const reasoning = msg.parts.filter((p): p is MessageV2.ReasoningPart => p.type === "reasoning")
      const liveOutputs = tools.reduce(
        (sum, p) => sum + (p.state.status === "completed" && !p.state.time.compacted ? Token.estimate(p.state.output) : 0),
        0,
      )
      const replayLive =
        pruneReasoning &&
        (reasoning.some((p) => !MessageV2.replayCleared(p.metadata)) ||
          tools.some((p) => !MessageV2.replayCleared(p.metadata)))
      const weight = liveOutputs + (replayLive ? msg.info.tokens.reasoning : 0)
      if (weight === 0) {
        if (tools.every((p) => p.state.status === "completed" && p.state.time.compacted && MessageV2.replayCleared(p.metadata)))
          cleared.push(tools)
        continue
      }
      if (total <= keep) {
        total += weight
        continue
      }
      freed += weight
      steps.push({ tools, reasoning })
      cleared.push(tools)
    }
    if (freed < budget / 2) {
      // Over the budget and not acting: say why, so a long run's log shows it.
      log.info("loop prune skipped", {
        promptTokens,
        budget,
        freed,
        needed: budget / 2,
        prunableSteps: steps.length,
        protectedSteps,
        pruneReasoning,
        reason: steps.length === 0 ? "nothing outside the protected window" : "less than half a budget can be freed",
      })
      return 0
    }

    const now = Date.now()
    const update = (part: MessageV2.Part) =>
      runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          yield* session.updatePart(part)
        }),
        input.ctx,
      )
    for (const step of steps) {
      for (const part of step.tools) {
        let changed = false
        if (part.state.status === "completed" && !part.state.time.compacted) {
          part.state.time.compacted = now
          changed = true
        }
        if (pruneReasoning && !MessageV2.replayCleared(part.metadata)) {
          part.metadata = { ...part.metadata, [MessageV2.REPLAY_CLEARED]: true }
          changed = true
        }
        if (changed) await update(part)
      }
      if (!pruneReasoning) continue
      for (const part of step.reasoning) {
        if (MessageV2.replayCleared(part.metadata)) continue
        part.metadata = { ...part.metadata, [MessageV2.REPLAY_CLEARED]: true }
        await update(part)
      }
    }

    // Old cleared steps cost ~80 tokens a call in arguments and notice, and there is one per call for
    // the whole task: fold all but the newest `digestKeep` into the one-line-per-call digest.
    let digested = 0
    if (digest) {
      for (const tools of cleared.slice(digestKeep)) {
        for (const part of tools) {
          if (MessageV2.digested(part.metadata)) continue
          part.metadata = { ...part.metadata, [MessageV2.DIGESTED]: true }
          await update(part)
          digested++
        }
      }
    }
    log.info("loop pruned", { steps: steps.length, freed, promptTokens, budget, pruneReasoning, digested })
    return steps.length
  }

  async function processImpl(
    input: ProcessInput & {
      directory: string
      worktree: string
      ctx: InstanceContext
    },
  ) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)
    if (!userMessage) {
      log.error("parent message not found", { parentID: input.parentID })
      throw new Error(`Parent message not found: ${input.parentID}`)
    }
    const userMessageInfo = userMessage.info as MessageV2.User
    if (!userMessageInfo) {
      log.error("parent message info not found", { parentID: input.parentID })
      throw new Error(`Parent message info not found: ${input.parentID}`)
    }

    // `session.compact` mods can leave the conversation as it is. The pending compaction is dropped
    // with the answer, or the loop would find it again and ask again; the loop stops, and the next
    // prompt starts from the conversation as it stands.
    const skipped = await Mod.sessionCompact({ sessionID: input.sessionID, auto: Boolean(input.auto) })
    if (skipped.skip !== undefined) {
      log.info("compaction skipped by a mod", { sessionID: input.sessionID, reason: skipped.skip })
      for (const part of userMessage.parts.filter((part) => part.type === "compaction")) {
        await runSession(
          Effect.gen(function* () {
            const session = yield* Session.Service
            yield* session.removePart({ sessionID: input.sessionID, messageID: userMessage.info.id, partID: part.id })
          }),
          input.ctx,
        )
      }
      return "stop"
    }
    const agent = await agentRequired("compaction", input.ctx)
    const model = await runProvider(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : yield* provider.getModel(userMessageInfo.model.providerID, userMessageInfo.model.modelID)
      }),
      input.ctx,
    )
    const msg = (await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          summary: true,
          path: {
            cwd: input.directory,
            root: input.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        })
      }),
      input.ctx,
    )) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      instance: input.ctx,
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    const compacting = await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )
      }),
      input.ctx,
    )
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessageInfo,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessages(input.messages, model),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "continue" && input.auto) {
      await runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const continueMsg = yield* session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: input.sessionID,
            time: {
              created: Date.now(),
            },
            agent: userMessageInfo.agent,
            model: userMessageInfo.model,
          })
          yield* session.updatePart({
            id: Identifier.ascending("part"),
            messageID: continueMsg.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          })
        }),
        input.ctx,
      )
    }
    if (processor.message.error) {
      // Track consecutive failures so a session that can't be compacted
      // (model context too small) doesn't loop forever. See opencode #38102.
      const failures = recordCompactionFailure(input.sessionID)
      if (failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
        const err = processor.message.error
        log.error("compaction circuit breaker open", {
          sessionID: input.sessionID,
          failures,
          errorName: err.name,
          errorMessage: (err.data as { message: string }).message,
        })
        throw new SessionCompaction.CircuitOpenError({
          sessionID: input.sessionID,
          failures,
          message:
            `Compaction failed ${failures} times consecutively (circuit breaker open). ` +
            `Try /clear to start a new session, or switch to a model with a larger context window.`,
        })
      }
      return "stop"
    }
    resetCompactionFailures(input.sessionID)
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    Effect.runSync(
      Effect.gen(function* () {
        const seq = yield* InstructionRepo.latestAggregateSeq(input.ctx.project.id, input.sessionID)
        yield* InstructionRepo.advanceEpoch(input.sessionID, seq)
      }),
    )
    return "continue"
  }

  async function createImpl(input: CreateInput & { ctx: InstanceContext }) {
    await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        const msg = yield* session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          model: input.model,
          sessionID: input.sessionID,
          agent: input.agent,
          time: {
            created: Date.now(),
          },
        })
        yield* session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "compaction",
          auto: input.auto,
        })
      }),
      input.ctx,
    )
  }

  const layer = Layer.succeed(
    Service,
    Service.of({
      isOverflow: (input) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const config = yield* Effect.promise(() => configGet(ctx))
          return overflowCheck({
            cfg: config,
            tokens: input.tokens,
            model: input.model,
          })
        }),
      editContext: (input) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const config = yield* Effect.promise(() => configGet(ctx))
          return yield* Effect.tryPromise(() => editContextImpl({ ...input, config, ctx }))
        }),
      prune: (input) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const config = yield* Effect.promise(() => configGet(ctx))
          return yield* Effect.tryPromise(() => pruneImpl({ ...input, config, ctx }))
        }),
      pruneLoop: (input) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const config = yield* Effect.promise(() => configGet(ctx))
          return yield* Effect.tryPromise(() => pruneLoopImpl({ ...input, config, ctx }))
        }),
      process: (input) =>
        InstanceState.context.pipe(
          Effect.flatMap((ctx) =>
            Effect.tryPromise(() =>
              processImpl({
                ...input,
                directory: ctx.directory,
                worktree: ctx.worktree,
                ctx,
              }),
            ),
          ),
        ),
      create: (input) =>
        InstanceState.context.pipe(Effect.flatMap((ctx) => Effect.tryPromise(() => createImpl({ ...input, ctx })))),
    }),
  )

  export const defaultLayer = layer
}
