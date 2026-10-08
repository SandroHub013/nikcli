/**
 * The map of the nikcli → Ragu Code codemod (`script/ragu-codemod.ts`): what changes, in order, and what does
 * not, each with its reason. The rules run on a line after the protected spans have been set aside, so a rule
 * never sees a domain, an identity or a user's folder name; a line exclusion keeps the whole line.
 *
 * Every replacement is free of "nikcli", so a second run finds nothing to change (only the same protected spans).
 */

export interface Context {
  /** The file's path, `/`-separated, relative to the repo root. */
  readonly path: string
  /** Prose (Markdown, HTML, Astro, plain text): a lone capitalised name reads "Ragu Code" there, "Ragu" in code. */
  readonly prose: boolean
}

export interface Rule {
  readonly id: string
  readonly find: RegExp
  /** Only in these files; every file when absent. */
  readonly files?: RegExp
  readonly to: string | ((match: string, context: Context, before: string, after: string) => string)
  readonly why: string
}

export interface Exclusion {
  readonly id: string
  readonly find: RegExp
  /** Only in these files; every file when absent. */
  readonly files?: RegExp
  /** Not when this matches the line or the one before it (a call chain split over lines). */
  readonly unless?: RegExp
  readonly why: string
}

export interface PathExclusion {
  readonly id: string
  readonly find: RegExp
  /** Run only these rules on the file instead of none: code that must keep compiling (imports, env names). */
  readonly onlyRules?: readonly string[]
  readonly why: string
}

const word = /[A-Za-z0-9_]/

/** Longest and most specific first: each rule sees what the ones before it left. */
export const RULES: readonly Rule[] = [
  {
    id: "scope",
    find: /@nikcli-ai\//g,
    to: "@ragu/",
    why: "the workspace scope: @nikcli-ai/util → @ragu/util",
  },
  {
    id: "package",
    find: /\bnikcli-ai\b/g,
    to: "ragu-code",
    why: "the main package (nikcli-ai) and the names derived from it (release assets nikcli-ai-<os>-<arch>); the domain nikcli-ai.dev is protected before",
  },
  {
    id: "author",
    find: /("author"\s*:\s*"|authors\s*=\s*\[\s*")Nikcli(")/g,
    to: "$1Alessandro Boni$2",
    why: "package and crate authors: Nikcli → Alessandro Boni",
  },
  {
    id: "codeowner",
    find: /@nikomatt69\b/g,
    files: /^\.github\/CODEOWNERS$/,
    to: "@SandroHub013",
    why: "CODEOWNERS: the owner of the new repository",
  },
  {
    id: "env",
    find: /NIKCLI/g,
    to: "RAGU",
    why: "environment variables and constants: NIKCLI_X → RAGU_X (the NIKCLI_* fallback is a hand fix after)",
  },
  {
    id: "Name",
    find: /NikCLI|NikCli|Nikcli|NiKcLi/g,
    to: (match, context, before, after) => {
      const alone = !word.test(before.slice(-1)) && !word.test(after.slice(0, 1))
      return context.prose && alone ? "Ragu Code" : "Ragu"
    },
    why: "capitalised: NikcliClient → RaguClient; a lone name in prose → Ragu Code",
  },
  {
    id: "camel",
    find: /nikCli/g,
    to: "ragu",
    why: "camelCase heads: nikCliFoo → raguFoo",
  },
  {
    id: "name",
    find: /nikcli/g,
    to: "ragu",
    why: "everything else: the command, identifiers (nikcliZen → raguZen), paths (packages/nikcli → packages/ragu), the scheme nikcli:// → ragu://, the user agent nikcli/ → ragu/, the cache prefix nikcli: → ragu:, «nikcli server listening»",
  },
]

/**
 * Spans set aside before the rules and put back unchanged: what names something outside this repository, or
 * a user's data, which a rename would break or point at a stranger.
 */
export const PROTECTED: readonly Exclusion[] = [
  {
    id: "host",
    find: /(?:[a-z0-9-]+\.)*nikcli(?:-ai)?\.(?:dev|store|ai|run|com|io)\b(?:\/[\w.~%/?=&#-]*)?|[a-z0-9-]*nikcli[a-z0-9-]*\.(?:up\.railway\.app|vercel\.app|workers\.dev|pages\.dev|fly\.dev)\b/gi,
    why: "Nik's domains (nikcli-ai.dev, nikcli.store, his railway deploy, …): renaming would send requests to a domain nobody here owns; the services go in their own brief",
  },
  {
    id: "registry",
    find: /(?:\b(?:npm|bun|pnpm|yarn)\s+(?:i|install|add)\s+(?:-g\s+|--global\s+)?|\bnpx\s+|\bbunx\s+|\bbrew\s+(?:install|upgrade)\s+|\bscoop\s+install\s+|\bchoco\s+install\s+|\b(?:paru|yay)\s+-S\s+)[\w@./-]*nikcli[\w@.${}-]*/g,
    why: "install commands from public registries (npm nikcli-ai, brew, scoop, choco, AUR): the renamed name is a package nobody here owns; they go with the autoupdate/services brief",
  },
  {
    id: "url",
    find: /(?:https?:\/\/)?(?:github\.com|raw\.githubusercontent\.com|ghcr\.io|discord\.gg|x\.com|twitter\.com|t\.me|npmjs\.com\/package)\/[\w.~%/?=&#-]*(?:nikcli|nikomatt69)[\w.~%/?=&#-]*/gi,
    why: "links to repositories, images and profiles outside this repo (upstream nikcli/nikcli, SandroHub013/nikcli until the new repo exists)",
  },
  {
    id: "slug",
    find: /\b(?:SandroHub013|nikomatt69|nikcli)\/nikcli\b/g,
    why: "repository slugs in workflow guards and API calls: they name the repositories as they are on GitHub",
  },
  {
    id: "secret",
    find: /secrets\.[A-Z0-9_]*NIKCLI[A-Z0-9_]*/g,
    why: "GitHub Actions secret names live in the repository settings, not in the tree",
  },
  {
    id: "identity",
    find: /\b(?:group\.)?(?:ai|com|dev)\.nikcli(?:\.[\w-]+)+/g,
    why: "bundle identifiers (ai.nikcli.ade, ai.nikcli.mobile, com.nikcli.island): data folders, WebView2 profiles, keychains and stores hang off them; the ADE id moves last, in its own brief",
  },
  {
    id: "user-folder",
    find: /(?<=^|[\s"'`/\\~(=,:[])\.nikcli\b/g,
    why: "the project folder .nikcli and ~/.nikcli: a user's config; moved by hand with rule B (ragu if it exists, else nikcli) and the guards in the same commit",
  },
  {
    id: "user-file",
    find: /\bnikcli\.(?:jsonc?|db(?:-wal|-shm)?)\b/g,
    why: "nikcli.json(c) and nikcli.db: a user's config and database; moved by hand with rule B",
  },
  {
    id: "user-dir",
    find: /(?:\.config|\.local[\\/]+share|\.local[\\/]+state|\.cache|AppData[\\/]+(?:Local|Roaming)(?:[\\/]+(?:Cache|State))?|Library[\\/]+Application Support)[\\/]+nikcli\b/g,
    why: "the platform data and config folders (APPDATA, LOCALAPPDATA, XDG): a user's data; rule B by hand",
  },
]

/** Whole lines left as they are. */
export const LINE_EXCLUSIONS: readonly Exclusion[] = [
  {
    id: "codex",
    find: /originator\s*:\s*"nikcli"/,
    why: "the Codex originator: unchanged until the lab has tried the new value on Luna",
  },
  {
    id: "client-id",
    find: /client_id\b[^\n]*"nikcli"/,
    why: "the OAuth client_id registered with Nik's auth server; that login is removed in the services brief",
  },
  {
    id: "app-folder",
    find: /const app = "nikcli"|\bjoin(?:Path)?\([^)\n]*["']nikcli["']|\.join\("nikcli"\)/,
    unless: /["']packages["']|import\.meta|nikcliBinDir/,
    why: "the folder name of a user's data and config (global.ts, ADE in TS and Rust, desktop, devhub): rule B by hand, with the guards",
  },
  {
    id: "prompt",
    find: /\b[Yy]ou are nikcli\b|[Yy]our name is nikcli/,
    why: "an identity the model reads: in the separate commit the lab measures",
  },
  {
    id: "credit",
    find: /fork of|nikomatt69|maintained by|not affiliated|endorsed by|All credit/i,
    files: /^(?:README\.md|packages\/[^/]+\/README\.md|CONTRIBUTING\.md)$/,
    why: "credits to nikcli and OpenCode in the READMEs: they name the projects as they are",
  },
]

/** Files whose content and own name stay: kept as they are by law, by history, or for their own brief. */
export const SKIP_FILES: readonly PathExclusion[] = [
  { id: "license", find: /(?:^|\/)(?:LICENSE|NOTICE|COPYING)(?:\.[a-z]+)?$/i, why: "copyright lines of OpenCode and nikcli stay (MIT); kokoro-host stays GPL-3 with its NOTICE" },
  { id: "history", find: /^(?:CHANGELOG\.md|\.nikcli\/plans\/)/, why: "history: release notes and old plans say what nikcli was" },
  {
    id: "prompt",
    find: /^packages\/nikcli\/src\/(?:session\/prompt\/|agent\/prompt\/|command\/template\/|tool\/[^/]+\.txt$)/,
    why: "text the model reads (system prompts, tool descriptions, command templates): a separate commit the lab measures",
  },
  {
    id: "upstream-install",
    find: /^(?:install|install\.ps1|packages\/web\/(?:public\/)?install(?:\.sh|\.ps1)?)$|^homebrew-tap\//,
    why: "installers that download nikcli's releases (github nikcli/nikcli, asset names nikcli-ai-*): renamed names would fetch nothing, or packages nobody here owns; they go with the autoupdate/services brief",
  },
  {
    id: "upstream-registry",
    find: /^(?:script\/publish-registries\.ts|packages\/nikcli\/src\/installation\/index\.ts)$/,
    onlyRules: ["scope", "env"],
    why: "upgrade and publishing code that names nikcli's packages on npm, brew, scoop and choco: only the imports and the env names change, so it still compiles; the names stay until the autoupdate/services brief",
  },
  { id: "lock", find: /(?:^|\/)(?:bun\.lockb?|Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, why: "lockfiles: regenerated by bun install and cargo after the rename" },
  { id: "self", find: /^script\/ragu-codemod(?:\.map)?\.ts$/, why: "the codemod itself" },
]

/** Never read: build output and dependencies. */
export const SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|target|\.git|\.turbo|\.next|\.output|build)\//

/** File extensions treated as binary without looking. */
export const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|mp[34]|wav|ogg|webm|mov|woff2?|ttf|otf|eot|zip|gz|tgz|xz|7z|pdf|wasm|exe|dll|so|dylib|node|bin|db|sqlite|onnx|gguf|glb|gltf|ktx2|basis|car|jar)$/i

/** Prose files: a lone capitalised name becomes "Ragu Code". */
export const PROSE_EXT = /\.(?:md|mdx|txt|astro|html?)$/i

/** Path segments that keep their name: a user's config folder and files (rule B by hand). */
export const KEEP_SEGMENT = /^(?:\.nikcli|nikcli\.jsonc?|nikcli\.db)$/
