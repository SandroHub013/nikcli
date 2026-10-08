import { createRaguClient } from "@ragu/sdk/httpapi"
import { createRaguServer } from "@ragu/sdk/server"

const server = await createRaguServer()
const client = createRaguClient({ baseUrl: server.url })

const input = await Array.fromAsync(new Bun.Glob("packages/core/*.ts").scan())

await Promise.all(
  input.map(async (file) => {
    console.log("processing", file)
    const session = await client.session.create()
    if (!session.data) throw new Error(`failed to create a session for ${file}`)
    await client.session.prompt({
      sessionID: session.data.id,
      parts: [
        { type: "file", mime: "text/plain", url: `file://${file}` },
        { type: "text", text: `Write tests for every public function in this file.` },
      ],
    })
    console.log("done", file)
  }),
)
