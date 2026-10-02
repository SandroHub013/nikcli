import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Effect, Layer, Schema } from "effect"
import { Mod } from "@/mod"

/**
 * What a client needs to draw for mods and to tell them a control was used.
 *
 * Mods run in the server process; a terminal (or a desktop or mobile client) asks them what to draw at
 * each render site and reports presses back. The drawing is an element tree (`src/mod/ui.ts`); it travels
 * as a JSON string so the contract stays closed, and the server has already checked it against the limits
 * a client can draw in bounded time.
 */
export namespace ModHttpApi {
  export const Placement = Schema.Literals(["dock", "inline"]).annotate({ identifier: "ModPanePlacement" })

  export const Pane = Schema.Struct({
    id: Schema.String,
    plugin: Schema.String,
    title: Schema.String,
    placement: Placement,
    rows: Schema.optional(Schema.Number),
  }).annotate({ identifier: "ModPane" })

  export const Info = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    tier: Schema.Literals(["prepend", "user", "append", "builtin"]),
    rank: Schema.Number,
    events: Schema.Array(Schema.String),
    tools: Schema.Array(Schema.String),
    commands: Schema.Array(Schema.String),
  }).annotate({ identifier: "ModInfo" })

  export const RenderInput = Schema.Struct({
    component: Schema.String,
    requestId: Schema.optional(Schema.String),
    sessionID: Schema.optional(Schema.String),
    /** The site's props, as JSON. */
    props: Schema.String,
    columns: Schema.optional(Schema.Number),
    rows: Schema.optional(Schema.Number),
  }).annotate({ identifier: "ModRenderInput" })

  export const RenderOutput = Schema.Struct({
    /** `default`: draw the site as nikcli does. `tree`: draw `tree` instead; an absent `tree` is "draw nothing". */
    kind: Schema.Literals(["default", "tree"]),
    /** The drawing as JSON, when `kind` is `tree`. */
    tree: Schema.optional(Schema.String),
    /** The site's props as the mods left them, as JSON, when `kind` is `default`. */
    props: Schema.optional(Schema.String),
  }).annotate({ identifier: "ModRenderOutput" })

  export const EventInput = Schema.Struct({
    kind: Schema.Literals(["press", "input", "select", "close", "message"]),
    key: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    submit: Schema.optional(Schema.Boolean),
    component: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    sessionID: Schema.optional(Schema.String),
  }).annotate({ identifier: "ModEventInput" })

  export const EventOutput = Schema.Struct({ handled: Schema.Boolean }).annotate({ identifier: "ModEventOutput" })

  export const Group = HttpApiGroup.make("mod")
    .add(HttpApiEndpoint.get("list", "/", { success: Schema.Array(Info) }))
    .add(HttpApiEndpoint.get("panes", "/ui/panes", { success: Schema.Array(Pane) }))
    .add(HttpApiEndpoint.post("render", "/ui/render", { payload: RenderInput, success: RenderOutput }))
    .add(HttpApiEndpoint.post("event", "/ui/event", { payload: EventInput, success: EventOutput }))
    .prefix("/mod")

  export const Api = HttpApi.make("nikcli").add(Group)

  export const ApiLive = HttpApiBuilder.layer(Api)

  export const handlers = {
    list: () =>
      Effect.gen(function* () {
        return (yield* (yield* Mod.Service).list()).map((mod) => ({ ...mod }))
      }),
    panes: () =>
      Effect.gen(function* () {
        return (yield* (yield* Mod.Service).panes()).map((pane) => ({ ...pane }))
      }),
    render: ({ payload }: { payload: typeof RenderInput.Type }) =>
      Effect.gen(function* () {
        const mods = yield* Mod.Service
        const out = yield* mods.render({
          component: payload.component,
          requestId: payload.requestId,
          sessionID: payload.sessionID,
          props: JSON.parse(payload.props || "{}") as Record<string, unknown>,
          viewport:
            payload.columns !== undefined && payload.rows !== undefined
              ? { columns: payload.columns, rows: payload.rows }
              : undefined,
        })
        if ("tree" in out) {
          return {
            kind: "tree" as const,
            ...(out.tree === null || out.tree === undefined ? {} : { tree: JSON.stringify(out.tree) }),
          }
        }
        return { kind: "default" as const, ...(out.props === undefined ? {} : { props: JSON.stringify(out.props) }) }
      }),
    event: ({ payload }: { payload: typeof EventInput.Type }) =>
      Effect.gen(function* () {
        return yield* (yield* Mod.Service).uiEvent({
          kind: payload.kind,
          key: payload.key,
          value: payload.value,
          submit: payload.submit,
          component: payload.component,
          requestId: payload.requestId,
          sessionID: payload.sessionID,
        })
      }),
  }

  export const HandlersLive = HttpApiBuilder.group(Api, "mod", (builder) =>
    builder
      .handle("list", handlers.list)
      .handle("panes", handlers.panes)
      .handle("render", handlers.render)
      .handle("event", handlers.event),
  )

  export const layer = ApiLive.pipe(Layer.provide(HandlersLive), Layer.provide(Mod.defaultLayer))
}
