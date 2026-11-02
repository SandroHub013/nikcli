import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"

/** The page title comes from brand.json like every other name: `%BRAND_NAME%` in index.html. It is the name people read («Ragù Code ADE»), not productName. */
function brandTitle(): Plugin {
  const { name, title } = JSON.parse(readFileSync(resolve(import.meta.dirname, "brand.json"), "utf8")) as {
    name: string
    title?: string
  }
  return {
    name: "ade-brand-title",
    transformIndexHtml: (html) => html.replaceAll("%BRAND_NAME%", title || name),
  }
}

export default defineConfig({
  plugins: [solid(), brandTitle()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    port: 5177,
    strictPort: true,
  },
})
