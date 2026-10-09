import { getDiscordBotStatus, startDiscordBot, stopDiscordBot } from "./bot"

const token = process.env.DISCORD_BOT_TOKEN?.trim()
if (!token) {
  console.error(`
Couldn't start the Discord bot.

Checklist:
• Set DISCORD_BOT_TOKEN (Developer Portal → Bot → Reset Token)
• Enable Message Content Intent (Bot → Privileged Gateway Intents)
• Invite the bot, or configure from the ragu TUI: /discord
• CLI fallback: bun run setup
`)
  process.exit(1)
}

const rawPort = Number(process.env.HEALTH_PORT ?? "3000")
const port = Number.isFinite(rawPort) ? rawPort : 3000

Bun.serve({
  port,
  fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now(), ...getDiscordBotStatus() }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response("Not Found", { status: 404 })
  },
})

console.log("Health endpoint ready on port", port)

async function shutdown(signal: string): Promise<void> {
  console.log(`Shutting down (${signal})...`)
  await stopDiscordBot()
  process.exit(0)
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})
process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

try {
  await startDiscordBot({
    botToken: token,
    raguUrl: process.env.RAGU_URL,
    raguUsername: process.env.RAGU_USERNAME,
    raguPassword: process.env.RAGU_PASSWORD,
    directory: process.env.RAGU_DIRECTORY,
    model: process.env.RAGU_MODEL,
    workdir: process.env.RAGU_WORKDIR,
  })
} catch (err) {
  if (err instanceof Error && (err.name === "DiscordBotError" || !err.stack)) {
    process.exit(1)
  }
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
