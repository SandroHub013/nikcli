/**
 * Solid components, mountable in `bun test`.
 *
 * Bun compiles `.tsx` with React's JSX transform, and Solid has no automatic
 * runtime for it, so a `.tsx` component could not be mounted and its logic had
 * to move into plain `.ts` to be tested. Some faults live only between
 * components — a prop that does not reach a child — and can only be seen with
 * the real ones mounted. This compiles `.tsx` the way Vite does, with
 * babel-preset-solid, for the files imported after it is called.
 *
 * The preset comes through vite-plugin-solid, which depends on it: it is not a
 * dependency of its own here.
 *
 * Whoever imports a `.tsx` calls `compileSolidJsx()` first, and imports it
 * afterwards with `await import(...)`. The plugin is global to the `bun test`
 * process, so a file that relies on another test file having called it works
 * only in the order the files happen to run.
 */

import { plugin } from "bun"
import { createRequire } from "node:module"

let registered = false

export function compileSolidJsx(): void {
  if (registered) return
  registered = true
  const require = createRequire(Bun.resolveSync("vite-plugin-solid", import.meta.dir))
  const babel = require("@babel/core") as {
    transformAsync: (code: string, options: object) => Promise<{ code?: string | null } | null>
  }
  const solid = require("babel-preset-solid")
  const typescript = require("@babel/preset-typescript")
  plugin({
    name: "solid-jsx",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
        const source = await Bun.file(path).text()
        const out = await babel.transformAsync(source, {
          filename: path,
          babelrc: false,
          configFile: false,
          presets: [
            [solid, { generate: "dom", hydratable: false }],
            [typescript, { isTSX: true, allExtensions: true, onlyRemoveTypeImports: true }],
          ],
        })
        return { contents: out?.code ?? "", loader: "js" }
      })
    },
  })
}
