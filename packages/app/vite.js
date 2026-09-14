import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "nikcli-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
          // `@pierre/diffs` pins its own shiki, so without this the bundle ships two
          // copies of every TextMate grammar — 226 duplicated chunks. Dedupe resolves
          // from the consuming project's root, so only ids that every consumer of this
          // plugin declares belong here, and shiki's own sub-packages stay out of it.
          dedupe: ["shiki", "@shikijs/transformers"],
        },
        worker: {
          format: "es",
        },
        build: {
          // Alert sounds are played on demand and never on first paint, but 22 of
          // them fall under the default 4 kB inline threshold and were landing in
          // the entry chunk as base64 — 78 kB before compression.
          assetsInlineLimit: (filePath) => (filePath.endsWith(".aac") ? false : undefined),
        },
      }
    },
  },
  tailwindcss(),
  solidPlugin(),
]
