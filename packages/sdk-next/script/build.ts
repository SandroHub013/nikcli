#!/usr/bin/env bun
// Bundles the embedded nikcli host (packages/nikcli/src) and the HttpApi client into dist/ so the
// published package does not need the monorepo sources. Third-party packages stay external and are
// listed in dist/package.json; workspace packages are inlined.
import path from "path"
import { fileURLToPath } from "url"
import { $ } from "bun"
import pkg from "../package.json"
import host from "../../nikcli/package.json"
import root from "../../../package.json"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(dir)

// The solid transform lives with the host sources it compiles, not in this package.
const solidPlugin = (await import(Bun.resolveSync("@opentui/solid/bun-plugin", path.join(dir, "../nikcli")))).default

const version = pkg.version
// Dependencies the repo patches (patches/*.patch) cannot be patched for a consumer, so the pure-JS
// ones are inlined from the patched tree instead of resolved from the registry at install time.
// The Effect platform packages are inlined for the same reason: their transitive caret ranges drift
// to releases (`@effect/platform-node-shared@4.0.1`) that no longer match the pinned `effect` rc.
const inlined = new Set(["extend", "@modelcontextprotocol/sdk", "@effect/platform-bun"])
const catalog = (root.workspaces as { catalog: Record<string, string> }).catalog
const overrides = root.overrides as Record<string, string>
const resolve = (name: string, range: string) =>
  overrides[name] ?? (range.startsWith("catalog:") ? (catalog[name] ?? range) : range)
const third = Object.entries(host.dependencies as Record<string, string>)
  .filter(([name, range]) => !String(range).startsWith("workspace:") && !inlined.has(name))
  .map(([name, range]) => [name, resolve(name, range)] as const)
const external = third.flatMap(([name]) => [name, `${name}/*`])

await $`rm -rf dist`
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  conditions: ["browser"],
  plugins: [solidPlugin],
  tsconfig: "./tsconfig.json",
  external,
  define: {
    NIKCLI_VERSION: `'${version}'`,
    NIKCLI_CHANNEL: `'latest'`,
    NIKCLI_REVISION: `'sdk-next'`,
    NIKCLI_LIBC: `''`,
  },
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
console.log(result.outputs.map((o) => `${path.relative(dir, o.path)} ${o.size}`).join("\n"))

// Published layout: `publishConfig.directory = "dist"` packs this directory, the same way
// packages/sdk/js ships, so the manifest below is the one consumers install from.
const dependencies = Object.fromEntries(
  [...third, ["effect", pkg.dependencies.effect] as const].sort(([a], [b]) => a.localeCompare(b)),
)
await Bun.write(
  "dist/package.json",
  JSON.stringify(
    {
      name: pkg.name,
      version,
      description: "Effect-native embedded nikcli host for in-process applications",
      type: "module",
      license: pkg.license,
      main: "./index.js",
      exports: { ".": { import: "./index.js", default: "./index.js" } },
      engines: { bun: ">=1.3.0" },
      dependencies,
    },
    null,
    2,
  ) + "\n",
)
await Bun.write("dist/README.md", await Bun.file("README.md").text())
