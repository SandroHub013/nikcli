/**
 * What one streaming tick costs to parse.
 *
 * The transcript throttles text updates because every tick re-parses the whole
 * message. The throttle interval is only defensible against a measured number,
 * so this prints it: run it before changing `TEXT_RENDER_THROTTLE_MS`.
 */
import { createMarkedParser } from "../src/context/marked"

const { parse } = createMarkedParser()

const PROSE = `Here is what I found while reading the module. The loader is doing more work than it needs to, and the cache key is built from two values that can collide.\n\n`
const CODE = "```ts\nexport function example(input: string) {\n  const parts = input.split(\"/\")\n  return parts.filter(Boolean).map((p) => p.trim())\n}\n```\n\n"

async function measure(label: string, build: (tick: number) => string, ticks: number) {
  await parse(build(0)) // warm the highlighter and the language load
  const samples: number[] = []
  for (let tick = 1; tick <= ticks; tick++) {
    const text = build(tick)
    const started = performance.now()
    await parse(text)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!
  console.log(
    `${label.padEnd(34)} mean ${(total / samples.length).toFixed(2)}ms  p50 ${at(0.5).toFixed(2)}ms  ` +
      `p95 ${at(0.95).toFixed(2)}ms  max ${samples.at(-1)!.toFixed(2)}ms`,
  )
  return total / samples.length
}

const TICKS = 60

// A long answer that keeps growing: the worst case, because every finished block
// is re-parsed on every tick along with the one still being written.
await measure("prose only, 60 ticks", (t) => PROSE.repeat(Math.max(1, t)), TICKS)
await measure("prose + 1 code block", (t) => PROSE + CODE + PROSE.repeat(Math.max(1, t)), TICKS)
await measure("prose + 6 code blocks", (t) => (PROSE + CODE).repeat(6) + PROSE.repeat(Math.max(1, t)), TICKS)
// The realistic shape: the last block is the one being streamed, character by character.
await measure(
  "6 blocks, last one streaming",
  (t) => (PROSE + CODE).repeat(6) + "```ts\n" + "const x = 1\n".repeat(Math.max(1, t)),
  TICKS,
)
