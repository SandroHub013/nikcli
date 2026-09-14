/**
 * Full re-parse per tick versus incremental, on the same message.
 *
 * The transcript used to re-parse the whole message on every streamed tick, so
 * one tick cost grew with the message and a message cost grew with its square.
 */
import { createMarkedParser } from "../src/context/marked"
import { renderIncremental, type StablePrefix } from "../src/context/markdown-split"

const { parse } = createMarkedParser()

const PARAGRAPH =
  "The loader resolves the theme before the highlighter is ready, which is why the first block renders unstyled and then swaps. Moving the registration into the shared module fixes it for both entry points.\n\n"
const BLOCK = "```ts\nexport function example(input: string) {\n  return input.split(\"/\").filter(Boolean)\n}\n```\n\n"

/** A realistic long answer: alternating prose and code, streamed in chunks. */
function buildMessage(paragraphs: number) {
  let text = ""
  for (let i = 0; i < paragraphs; i++) text += i % 3 === 2 ? BLOCK : PARAGRAPH
  return text
}

async function run(label: string, message: string, chunk: number) {
  const ticks: string[] = []
  for (let end = chunk; end < message.length; end += chunk) ticks.push(message.slice(0, end))
  ticks.push(message)

  await parse(message) // warm shiki and the language load out of the measurement

  let full = 0
  for (const text of ticks) {
    const started = performance.now()
    await parse(text)
    full += performance.now() - started
  }

  let prefix: StablePrefix | undefined
  let incremental = 0
  for (const text of ticks) {
    const started = performance.now()
    const result = await renderIncremental({ text, cached: prefix, render: parse })
    incremental += performance.now() - started
    prefix = result.prefix
  }

  const perTick = (total: number) => (total / ticks.length).toFixed(2)
  console.log(
    `${label.padEnd(30)} ${ticks.length} tick  ` +
      `pieno ${full.toFixed(0)}ms (${perTick(full)}ms/tick)  ` +
      `incrementale ${incremental.toFixed(0)}ms (${perTick(incremental)}ms/tick)  ` +
      `${(full / incremental).toFixed(1)}x`,
  )
}

// 40 characters per tick is roughly what a fast model streams into one 100ms frame.
await run("risposta corta (5 blocchi)", buildMessage(5), 40)
await run("risposta media (15 blocchi)", buildMessage(15), 40)
await run("risposta lunga (40 blocchi)", buildMessage(40), 40)
