import { stableBoundary } from "../src/context/markdown-split"
const CORPUS = [
  ["plain paragraphs", "First paragraph here.\n\nSecond paragraph here.\n\nThird one.\n"],
  ["tight list", "Intro line.\n\n- one\n- two\n- three\n\nAfter the list.\n"],
  ["loose list", "Intro line.\n\n- one\n\n- two\n\n- three\n\nAfter.\n"],
  ["table", "Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n"],
  ["setext heading", "Some paragraph.\n\nA heading\n=========\n\nBody text.\n"],
  ["fenced code", "Before.\n\n```ts\nconst x = 1\n\nconst y = 2\n```\n\nAfter.\n"],
  ["indented code block", "Before.\n\n    indented one\n\n    indented two\n\nAfter.\n"],
  ["link reference definitions", "See [the docs][d].\n\n[d]: https://example.com\n\nEnd.\n"],
] as const
let split = 0, total = 0
for (const [name, doc] of CORPUS) {
  let n = 0
  for (let i = 0; i <= doc.length; i++) { total++; if (stableBoundary(doc.slice(0, i)) > 0) { n++; split++ } }
  console.log(`${name.padEnd(28)} ${n}/${doc.length + 1} prefissi tagliati`)
}
console.log(`\ntotale ${split}/${total} (${((split / total) * 100).toFixed(0)}%)`)
