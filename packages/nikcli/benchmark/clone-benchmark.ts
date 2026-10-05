const ITERATIONS = 100
const WARMUP = 20
const KEY_COUNT = 10000

function generateObject(keys: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < keys; i++) {
    obj[`key_${i}`] = {
      id: i,
      name: `item_${i}`,
      value: Math.random() * 1000,
      active: i % 2 === 0,
      tags: ["a", "b", "c"],
      nested: { foo: "bar", num: i },
    }
  }
  return obj
}

function measure(
  fn: () => void,
  iterations: number,
): {
  times: number[]
  median: number
  p95: number
  min: number
  max: number
  opsSec: number
} {
  const times: number[] = []

  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    const end = performance.now()
    times.push(end - start)
  }

  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.floor(times.length * 0.95)]
  const min = times[0]
  const max = times[times.length - 1]
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const opsSec = Math.round(1000 / avg)

  return { times, median, p95, min, max, opsSec }
}

const obj = generateObject(KEY_COUNT)

console.log(`Generating object with ${KEY_COUNT} keys...`)
console.log(`Running ${WARMUP} warmup iterations...`)

for (let i = 0; i < WARMUP; i++) {
  const _ = JSON.parse(JSON.stringify(obj))
  const __ = structuredClone(obj)
}

console.log(`Running ${ITERATIONS} benchmark iterations...\n`)

const jsonResult = measure(() => {
  const cloned = JSON.parse(JSON.stringify(obj))
}, ITERATIONS)

const cloneResult = measure(() => {
  const cloned = structuredClone(obj)
}, ITERATIONS)

const fmt = (n: number) => n.toFixed(2)

console.log(
  `JSON.parse (${KEY_COUNT} keys): median=${fmt(jsonResult.median)}ms p95=${fmt(jsonResult.p95)}ms min=${fmt(jsonResult.min)}ms max=${fmt(jsonResult.max)}ms ops/sec=${jsonResult.opsSec}`,
)
console.log(
  `structuredClone (${KEY_COUNT} keys): median=${fmt(cloneResult.median)}ms p95=${fmt(cloneResult.p95)}ms min=${fmt(cloneResult.min)}ms max=${fmt(cloneResult.max)}ms ops/sec=${cloneResult.opsSec}`,
)

const winner = jsonResult.median < cloneResult.median ? "JSON.parse" : "structuredClone"
console.log(`Winner: ${winner}`)
