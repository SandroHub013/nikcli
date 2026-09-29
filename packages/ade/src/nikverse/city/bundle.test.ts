import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { gzipSync } from "node:zlib"
import { ENTRY, OUT_FILE, buildWorld } from "./build-world"
import { CITY_MODULE } from "../world/world.js"

/** The world's page loads one module, and the policy of the scheme allows its own host and nothing else. */
describe("the world bundle", () => {
  let text = ""
  test("it builds, and the entry exports what the page calls", async () => {
    const built = await buildWorld()
    if (!built.ok) throw new Error(built.errors.join("\n"))
    text = built.text
    expect(text).toMatch(/export\s*\{[^}]*\bas startCity\b/)
  })

  test("it fits the budget: 600 kB gzip of code, with three.js, the renderer and the loaders in it", () => {
    expect(gzipSync(text).length).toBeLessThan(600 * 1024)
  })

  test("it is minified: 2.5 MB unminified, about 1.4 MB as built (what stays is three.js' shader text, which no minifier touches)", () => {
    expect(text.length).toBeLessThan(1700 * 1024)
    expect(text).not.toContain("sourceMappingURL")
  })

  test("it exports what the render check and the world call: the city, the loader of the cast and the level choice", () => {
    const exported = /export\s*\{([^}]*)\}/.exec(text)?.[1] ?? ""
    for (const name of ["startCity", "loadCast", "decodePicture", "resolveLevel"]) expect(exported).toContain(`as ${name}`)
  })

  test("it needs no eval and no Function, which the world's policy does not allow, and loads nothing from the network", () => {
    expect(text).not.toMatch(/\beval\(/)
    expect(text).not.toMatch(/new Function\(/)
    expect(text).not.toMatch(/importScripts/)
    // The only addresses in it are XML namespaces and links in comments and messages.
    const urls = [...new Set(text.match(/https?:\/\/[^"'\s)]+/g) ?? [])]
    const allowed = [/^http:\/\/www\.w3\.org\//, /^https:\/\/github\.com\/mrdoob\/three\.js\//, /^https:\/\/www\.shadertoy\.com\//, /^https:\/\/jcgt\.org\//]
    expect(urls.filter((url) => !allowed.some((re) => re.test(url)))).toEqual([])
  })

  test("it is written where the page looks for it, under the assets folder the scheme serves", () => {
    const assets = join(import.meta.dir, "..", "..", "..", "src-tauri", "nikverse-assets")
    // The page asks for `./assets/world/city.js`; the scheme maps `/assets/<path>` to `<path>` under the folder.
    expect(CITY_MODULE).toBe("./assets/world/city.js")
    expect(relative(assets, OUT_FILE).replaceAll("\\", "/")).toBe(CITY_MODULE.replace("./assets/", ""))
    expect(ENTRY.replaceAll("\\", "/")).toEndWith("src/nikverse/city/main.ts")
  })

  test("lint: the bundle is not committed, and build.rs runs the build before it lists the assets", () => {
    const root = join(import.meta.dir, "..", "..", "..", "..", "..")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("packages/ade/src-tauri/nikverse-assets/world/")
    const build = readFileSync(join(import.meta.dir, "..", "..", "..", "src-tauri", "build.rs"), "utf8")
    const main = build.slice(build.indexOf("fn main()"), build.indexOf("}", build.indexOf("fn main()")))
    expect(main.indexOf("build_nikverse_world()")).toBeGreaterThan(-1)
    expect(main.indexOf("build_nikverse_world()")).toBeLessThan(main.indexOf("write_nikverse_manifest()"))
  })
})
