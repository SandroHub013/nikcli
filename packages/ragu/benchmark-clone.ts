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
      metadata: { a: i, b: String(i), c: [i, i + 1, i + 2] },
    }
  }
  return obj
}

function runBenchmark(
  name: string,
  fn: (obj: unknown) => unknown,
  original: Record<string, unknown>,
): { median: number; p95: number; min: number; max: number; opsSec: number } {
  const times: number[] = []

  for (let i = 0; i < WARMUP; i++) {
    fn(original)
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    fn(original)
    const end = performance.now()
    times.push(end - start)
  }

  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const p95 = times[Math.floor(times.length * 0.95)]
  const min = times[0]
  const max = times[times.length - 1]
  const opsSec = 1000 / median

  return { median, p95, min, max, opsSec }
}

const obj = generateObject(KEY_COUNT)

const jsonResult = runBenchmark("JSON.parse", (o) => JSON.parse(JSON.stringify(o)), obj)
const cloneResult = runBenchmark("structuredClone", (o) => structuredClone(o), obj)

console.log(
  `JSON.parse (10k keys): median=${jsonResult.median.toFixed(2)}ms p95=${jsonResult.p95.toFixed(2)}ms min=${jsonResult.min.toFixed(2)}ms max=${jsonResult.max.toFixed(2)}ms ops/sec=${jsonResult.opsSec.toFixed(0)}`,
)
console.log(
  `structuredClone (10k keys): median=${cloneResult.median.toFixed(2)}ms p95=${cloneResult.p95.toFixed(2)}ms min=${cloneResult.min.toFixed(2)}ms max=${cloneResult.max.toFixed(2)}ms ops/sec=${cloneResult.opsSec.toFixed(0)}`,
)
console.log(`Winner: ${cloneResult.median < jsonResult.median ? "structuredClone" : "JSON.parse"}`)
