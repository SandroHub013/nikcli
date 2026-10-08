import { Ragu as Client } from "@ragu/sdk/httpapi"
import { runPromiseWithLayer, withCurrentInstance, withInstanceAsync } from "ragu-code/effect/index"
import { InstanceBootstrap } from "ragu-code/project/bootstrap"
import { Server } from "ragu-code/server/server"
import { ToolRegistry } from "ragu-code/tool/registry"
import type { Tool } from "ragu-code/tool/tool"
import { Context, Effect, Layer } from "effect"

export interface Options {
  /**
   * Project directory the embedded host binds requests to when a call does
   * not carry its own `directory` query or `x-ragu-directory` header.
   * Defaults to `process.cwd()`.
   */
  readonly directory?: string
}

export const create = Effect.fn("Ragu.create")(function* (options?: Options) {
  const directory = options?.directory ?? process.cwd()
  const fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const bound = new URL(request.url).searchParams.has("directory") || request.headers.has("x-ragu-directory")
      if (!bound) request.headers.set("x-ragu-directory", directory)
      return Server.fetch(request)
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const client = Client.make({ baseUrl: "http://ragu.local", fetch })
  const register = Effect.fn("Ragu.tools.register")(function* (...tools: Tool.Info[]) {
    yield* Effect.tryPromise({
      try: () =>
        withInstanceAsync({ directory, init: InstanceBootstrap }, () =>
          runPromiseWithLayer(
            ToolRegistry.defaultLayer,
            withCurrentInstance(
              Effect.gen(function* () {
                const registry = yield* ToolRegistry.Service
                for (const tool of tools) yield* registry.register(tool)
              }),
            ),
          ),
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  })
  return yield* Effect.succeed({
    ...client,
    tools: { register },
  })
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@ragu/sdk-next/Ragu") {}

export const layer = Layer.effect(Service, create())
