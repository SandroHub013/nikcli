# @ragu/sdk-next

Effect-native embedded ragu host for in-process applications. This transitional package will replace the existing generated `@ragu/sdk` after its consumers migrate.

The SDK executes the server's assembled Hono router in memory. It opens no listener and performs no network I/O, while preserving the same routing, middleware, handlers, codecs, and errors as the network client.

```ts
import { Ragu Code } from "@ragu/sdk-next"

const ragu = yield * Ragu Code.create({ directory })
const session = yield * Effect.promise(() => ragu.session.create({ title: "embedded" }))
```

Requests that do not carry their own `directory` query parameter or `x-ragu-directory` header are bound to the host's directory (defaulting to `process.cwd()`), flowing through the same per-request instance middleware as network traffic.

It also exports `Tool` and exposes local-only `tools.register(...)`, which registers tools into the host directory's `ToolRegistry` — the same instance-scoped registry consulted by sessions and by `/experimental/tool/ids`. Registration is local-only because tool implementations are executable code that cannot travel over HTTP.

The same constructor is available as a service Layer:

```ts
const program = Effect.gen(function* () {
  const ragu = yield* Ragu Code.Service
  return yield* Effect.promise(() => ragu.session.list())
})

yield * program.pipe(Effect.provide(Ragu Code.layer))
```

`Ragu Code.layer` adapts `Ragu Code.create()` for dependency injection; it does not define another host implementation.

Unlike a network server, the embedded host shares process-global instance state: two `create()` calls in the same process observe the same projects, sessions, and registered tools for a given directory.
