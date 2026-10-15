// Turns the .spans.json files written by capture.ts into one coloured HTML page
// per shot, an index.html that shows them all, and contrast.json: the real
// fg/bg pairs of every shot with their WCAG ratio.
//
//   bun script/ui-review/html.ts <dir>
import { readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

type Rgba = [number, number, number, number]
type Span = [string, Rgba, Rgba, number, number]
type Frame = { cols: number; rows: number; lines: Span[][] }

const BOLD = 1
const DIM = 2
const ITALIC = 4
const UNDERLINE = 8
const INVERSE = 32
const HIDDEN = 64
const STRIKE = 128

const dir = process.argv[2]
if (!dir) throw new Error("usage: html.ts <dir>")

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const hex = ([r, g, b]: Rgba) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`
const channel = (c: number) => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const ratio = (a: Rgba, b: Rgba) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const over = (top: Rgba, under: Rgba, alpha = top[3] / 255): Rgba => [
  Math.round(top[0] * alpha + under[0] * (1 - alpha)),
  Math.round(top[1] * alpha + under[1] * (1 - alpha)),
  Math.round(top[2] * alpha + under[2] * (1 - alpha)),
  255,
]

const files = (await readdir(dir)).filter((name) => name.endsWith(".spans.json")).sort()
type Pair = { fg: string; bg: string; ratio: number; cells: number; dim: boolean; sample: string }
const contrast: Record<string, { low45: number; low3: number; text: number; pairs: Pair[] }> = {}

for (const file of files) {
  const name = file.replace(/\.spans\.json$/, "")
  const frame = (await Bun.file(join(dir, file)).json()) as Frame
  const page = name.startsWith("light") ? ([255, 255, 255, 255] as Rgba) : ([12, 12, 12, 255] as Rgba)
  const pairs = new Map<string, Pair>()
  let text = 0
  const rows = frame.lines.map((line) =>
    line
      .map(([chars, fg, bg, attributes, width]) => {
        const inverse = Boolean(attributes & INVERSE)
        const back = over(inverse ? fg : bg, page)
        let fore = over(inverse ? bg : fg, back)
        if (attributes & DIM) fore = over(fore, back, 0.55)
        // Text only: box drawing, blocks (images, bars) and braille are graphics.
        const visible = chars.replace(/[\s─-▟⠀-⣿]/g, "")
        if (visible && !(attributes & HIDDEN)) {
          text += visible.length
          const key = `${hex(fore)}/${hex(back)}/${attributes & DIM ? 1 : 0}`
          const known = pairs.get(key)
          if (known) {
            known.cells += visible.length
            if (known.sample.length < 40) known.sample = `${known.sample} ${chars.trim()}`.slice(0, 40)
          } else {
            pairs.set(key, {
              fg: hex(fore),
              bg: hex(back),
              ratio: Math.round(ratio(fore, back) * 100) / 100,
              cells: visible.length,
              dim: Boolean(attributes & DIM),
              sample: chars.trim().slice(0, 40),
            })
          }
        }
        const pad = width > [...chars].length ? " ".repeat(width - [...chars].length) : ""
        const style = [
          `color:${hex(fore)}`,
          `background:${hex(back)}`,
          attributes & BOLD ? "font-weight:700" : "",
          attributes & ITALIC ? "font-style:italic" : "",
          attributes & UNDERLINE || attributes & STRIKE
            ? `text-decoration:${[attributes & UNDERLINE ? "underline" : "", attributes & STRIKE ? "line-through" : ""].join(" ")}`
            : "",
          attributes & HIDDEN ? "visibility:hidden" : "",
        ]
          .filter(Boolean)
          .join(";")
        return `<span style="${style}">${escape(chars + pad)}</span>`
      })
      .join(""),
  )
  const sorted = [...pairs.values()].sort((a, b) => a.ratio - b.ratio)
  contrast[name] = {
    text,
    low45: sorted.filter((p) => p.ratio < 4.5).reduce((sum, p) => sum + p.cells, 0),
    low3: sorted.filter((p) => p.ratio < 3).reduce((sum, p) => sum + p.cells, 0),
    pairs: sorted,
  }
  await writeFile(
    join(dir, `${name}.html`),
    `<!doctype html><meta charset="utf-8"><title>${name}</title>
<style>body{margin:0;background:${hex(page)};color:#888;font:13px system-ui}pre{margin:12px;font:15px/1.25 "Cascadia Mono",Consolas,monospace;display:inline-block}h1{font-size:13px;margin:12px}</style>
<h1>${name} · ${frame.cols}×${frame.rows}</h1><pre>${rows.join("\n")}</pre>`,
  )
}

await writeFile(join(dir, "contrast.json"), JSON.stringify(contrast, null, 1))

// Index: one section per screen, every variant side by side.
const shots = new Map<string, string[]>()
for (const file of files) {
  const name = file.replace(/\.spans\.json$/, "")
  const match = /^(dark|light)-([\w-]+?)-(\d\d-[\w-]+)-(\d+)$/.exec(name)
  const screen = match ? match[3] : name
  shots.set(screen, [...(shots.get(screen) ?? []), name])
}
const sections = [...shots.entries()]
  .map(([screen, names]) => {
    const cells = names
      .map((name) => {
        const stats = contrast[name]
        const low = stats && stats.text ? Math.round((stats.low45 / stats.text) * 100) : 0
        return `<figure><a href="${name}.html"><img loading="lazy" src="${name}.png" alt="${name}"></a><figcaption>${name} · ${low}% del testo sotto 4,5:1</figcaption></figure>`
      })
      .join("")
    return `<section><h2 id="${screen}">${screen}</h2><div class="row">${cells}</div></section>`
  })
  .join("\n")
await writeFile(
  join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catture UI ragu</title>
<style>:root{color-scheme:light dark}body{margin:16px;font:14px system-ui;background:#161616;color:#ddd}a{color:#9cf}
h2{font-size:15px;margin:28px 0 8px}.row{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}
figure{margin:0;flex:none}img{display:block;height:360px;border:1px solid #333}figcaption{font-size:12px;color:#aaa;margin-top:4px}
nav a{margin-right:10px}</style>
<h1>Catture UI della CLI ragu</h1>
<p>Ogni immagine apre l'HTML della schermata (testo selezionabile, colori delle celle vere). Contrasti per schermata in <a href="contrast.json">contrast.json</a>.</p>
<nav>${[...shots.keys()].map((s) => `<a href="#${s}">${s}</a>`).join("")}</nav>
${sections}`,
)
console.log(`${files.length} shots, ${shots.size} screens → ${join(dir, "index.html")}`)
