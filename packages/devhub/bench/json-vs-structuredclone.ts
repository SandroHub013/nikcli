const obj: Record<string, unknown> = {}
for (let i = 0; i < 10_000; i++) {
  obj[`key_${i}`] = {
    id: i,
    name: `item_${i}`,
    value: Math.random() * 1000,
    nested: { a: i, b: `str_${i}` },
  }
}

function measure(fn: () => void, iterations: number): number[] {
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    const end = performance.now()
    times.push(end - start)
  }
  return times.sort((a, b) => a - b)
}

function stats(
  times: number[],
  opsPerRun: number,
): {
  median: number
  p95: number
  min: number
  max: number
  opsPerSec: number
} {
  const median = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.floor(times.length * 0.95)]
  const min = times[0]
  const max = times[times.length - 1]
  const opsPerSec = Math.round(1000 / median) * opsPerRun
  return { median, p95, min, max, opsPerSec }
}

const iterations = 100

console.log("Benchmarking JSON.parse vs structuredClone on 10k-key object\n")
console.log("=".repeat(60))

// JSON.parse benchmark
const jsonStr = JSON.stringify(obj)
const jsonTimes = measure(() => {
  JSON.parse(jsonStr)
}, iterations)
const jsonStats = stats(jsonTimes, 1)

console.log("\nJSON.parse + JSON.stringify:")
console.log(`  median: ${jsonStats.median.toFixed(2)}ms`)
console.log(`  p95:    ${jsonStats.p95.toFixed(2)}ms`)
console.log(`  min:    ${jsonStats.min.toFixed(2)}ms`)
console.log(`  max:    ${jsonStats.max.toFixed(2)}ms`)
console.log(`  ops/s:  ~${jsonStats.opsPerSec.toLocaleString()}`)

// structuredClone benchmark
const cloneTimes = measure(() => {
  structuredClone(obj)
}, iterations)
const cloneStats = stats(cloneTimes, 1)

console.log("\nstructuredClone:")
console.log(`  median: ${cloneStats.median.toFixed(2)}ms`)
console.log(`  p95:    ${cloneStats.p95.toFixed(2)}ms`)
console.log(`  min:    ${cloneStats.min.toFixed(2)}ms`)
console.log(`  max:    ${cloneStats.max.toFixed(2)}ms`)
console.log(`  ops/s:  ~${cloneStats.opsPerSec.toLocaleString()}`)

// Comparison
console.log("\n" + "=".repeat(60))
const ratio = jsonStats.median / cloneStats.median
if (ratio > 1) {
  console.log(`\nstructuredClone is ${ratio.toFixed(2)}x faster than JSON.parse`)
} else {
  console.log(`\nJSON.parse is ${(1 / ratio).toFixed(2)}x faster than structuredClone`)
}
