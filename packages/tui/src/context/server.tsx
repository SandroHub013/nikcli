import { createSimpleContext } from "./helper"

export type StartServerOptions = {
  hostname?: string
  port?: number
  mdns?: boolean
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (input: { startServer?: (options?: StartServerOptions) => Promise<string> }) => ({
    startServer: input.startServer,
  }),
})
