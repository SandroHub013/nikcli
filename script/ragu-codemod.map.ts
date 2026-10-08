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
    find: /(?:[a-z0-9-]+\.)*nikcli(?:-ai)?\.(?:dev|store|ai|run|com|io)\b|[a-z0-9-]*nikcli[a-z0-9-]*\.(?:up\.railway\.app|vercel\.app|workers\.dev|pages\.dev|fly\.dev)\b/gi,
    why: "Nik's domains (nikcli-ai.dev, nikcli.store, his railway deploy, …): renaming would send requests to a domain nobody here owns; the services go in their own brief. The host only: a path or query after it (/.well-known/nikcli, client_id=nikcli-studio) is a route this repo serves and renames, and its tests follow",
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
    id: "upgrade-pid",
    find: /NIKCLI_UPGRADE_PID/g,
    why: "the variable the CLI's upgrade hands to install.ps1, which is kept whole (upstream-install): both ends keep the old name",
  },
  {
    id: "identity",
    find: /\b(?:group\.)?(?:ai|com|dev)\.nikcli(?:\.[\w-]+)+/g,
    why: "bundle identifiers (ai.nikcli.ade, ai.nikcli.mobile, com.nikcli.island): data folders, WebView2 profiles, keychains and stores hang off them; the ADE id moves last, in its own brief",
  },
  {
    id: "user-folder",
    find: /(?<=^|[\s"'`/\\~(=,:[}])\.nikcli\b/gi,
    why: "the project folder .nikcli and ~/.nikcli, in any case (a guard test spells .NIKCLI): a user's config; moved by hand with rule B (ragu if it exists, else nikcli) and the guards in the same commit. Also after a template's `}` (`${prefix}.nikcli`)",
  },
  {
    id: "user-file",
    find: /\bnikcli\.(?:jsonc?|db(?:-wal|-shm)?)\b(?!\(\))/g,
    why: "nikcli.json(c) and nikcli.db: a user's config and database; moved by hand with rule B. Not the call `nikcli.json()`, a variable's method",
  },
  {
    id: "user-dir",
    find: /(?:\.config|\.local[\\/]+share|\.local[\\/]+state|\.cache|AppData[\\/]+(?:Local|Roaming)(?:[\\/]+(?:Cache|State))?|Library[\\/]+Application Support)[\\/]+nikcli\b/gi,
    why: "the platform data and config folders (APPDATA, LOCALAPPDATA, XDG), in any case (`appdata\\roaming\\nikcli` in a test): a user's data; rule B by hand",
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
    id: "guard",
    find: /casings\("nikcli"\)/,
    why: "a guard that builds its denials from the bare name (serve-rules.ts `configDenials`): it must keep denying .nikcli until correction 2 adds ragu beside it",
  },
  {
    id: "kept-source-assert",
    find: /\.(?:not\.)?(?:toContain|toMatch)\(/,
    files: /^packages\/(?:nikcli|ragu)\/test\/installation\/[^/]+\.test\.ts$/,
    why: "assertions on the text of the files kept for the services brief (installation/index.ts, install.ps1): they must quote that text as it stays",
  },
  {
    id: "config-stem",
    find: /(?:fileInDirectory|configFilesInDirectory)\([^)\n]*"nikcli"\)|"nikcli" \| "tui"|kind === "server"\) return "nikcli"/,
    why: "the stem nikcli.json(c) is built from (config paths, the TUI config migration, plugin install, the mod guard): renamed, ragu would stop reading a user's nikcli.json; rule B by hand in correction 2",
  },
  {
    id: "npm-plugin",
    find: /\["@nikcli-ai\/plugin"\]|"@nikcli-ai\/plugin@"|"dependencies":\{"@nikcli-ai\/plugin"/,
    why: "the plugin package ragu adds from npm to a user's config folder (config.ts `bun add`, the pin it checks, ADE's project trust that discounts it): @ragu/plugin is not on npm; it moves when we publish one, in the services brief",
  },
  {
    id: "npm-plugin-import",
    find: /from "@nikcli-ai\/plugin"/,
    files: /^packages\/(?:nikcli|ragu)\/src\/tool\/plugin\.txt$/,
    why: "the import the plugin tool tells the model to write in a user's plugin: that folder gets @nikcli-ai/plugin from npm (npm-plugin), so @ragu/plugin would not resolve there",
  },
  {
    id: "publisher",
    find: /"publisher"\s*:\s*"nikcli"|"copyright"\s*:\s*"[^"]*\bnikcli"/,
    why: "ADE's publisher (brand.json, tauri.conf.json, and the copyright made from it): the NSIS install folder and registry keys hang off it; it moves with the ADE id, last",
  },
  {
    id: "prompt-fixture",
    find: /\b[Yy]ou are nikcli\b|[Yy]our name is nikcli/,
    files: /\/test\//,
    why: "a system prompt a test feeds as data (cache diagnostics): the identity commit changed the prompts the model reads, not test inputs",
  },
  {
    id: "logo-glyphs",
    find: /const WORD = "NIKCLI"/,
    files: /^packages\/(?:nikcli|ragu)\/script\/logo-lab\.ts$/,
    why: "the logo lab draws the wordmark from glyph tables that have only N, I, K, C and L: renamed, the word has letters no table draws and the lab throws; it moves with the ADE brand brief, which draws the new letters",
  },
  {
    id: "both-names",
    find: /(?=[^\n]*ragu)(?=[^\n]*nikcli)/i,
    files: /^(?!script\/ragu-codemod)/,
    why: "a line with the new name and the old one side by side: either written by hand after the mechanical commit (the compat shims, rule B, a guard that knows both names), which a rerun on the branch must not make say ragu twice, or one whose old name a span above already keeps. Code from before the rename has no ragu in it, so its lines still change; on the merge of integra 1e0278145 a rerun without this rule changed hand lines only",
  },
  {
    id: "credit",
    find: /fork of|nikomatt69|maintained by|not affiliated|endorsed by|All credit/i,
    files: /^(?:README\.md|packages\/[^/]+\/README\.md|CONTRIBUTING\.md)$/,
    why: "credits to nikcli and OpenCode in the READMEs: they name the projects as they are",
  },
]

/**
 * Files whose content and own name stay: kept as they are by law, by history, or for their own brief. A pattern
 * under a renamed folder names both its old and its new path, or the second run converts what the first kept.
 */
export const SKIP_FILES: readonly PathExclusion[] = [
  { id: "license", find: /(?:^|\/)(?:LICENSE|NOTICE|COPYING)(?:\.[a-z]+)?$/i, why: "copyright lines of OpenCode and nikcli stay (MIT); kokoro-host stays GPL-3 with its NOTICE" },
  { id: "history", find: /^(?:CHANGELOG\.md|\.nikcli\/plans\/)/, why: "history: release notes and old plans say what nikcli was" },
  {
    id: "upstream-install",
    find: /^(?:install|install\.ps1|packages\/web\/(?:public\/)?install(?:\.sh|\.ps1)?)$|^homebrew-tap\//,
    why: "installers that download nikcli's releases (github nikcli/nikcli, asset names nikcli-ai-*): renamed names would fetch nothing, or packages nobody here owns; they go with the autoupdate/services brief",
  },
  {
    id: "upstream-registry",
    find: /^(?:script\/publish-registries\.ts|packages\/(?:nikcli|ragu)\/src\/installation\/index\.ts)$/,
    onlyRules: ["scope", "env"],
    why: "upgrade and publishing code that names nikcli's packages on npm, brew, scoop and choco: only the imports and the env names change, so it still compiles; the names stay until the autoupdate/services brief",
  },
  {
    id: "upstream-service",
    find: /^packages\/(?:auth|identity)\//,
    onlyRules: ["scope", "env"],
    why: "Nik's sign-in service (auth.nikcli-ai.dev) and its token check: client ids, audience, worker and database names are registered there and must agree between src and tests; only the imports and the env names change; the services brief decides the rest",
  },
  {
    id: "guard-test",
    find: /^packages\/ade\/src\/bots\/serve-rules\.test\.ts$/,
    why: "the hostile spellings the .nikcli guard must deny (NIKCLI.JSON, Nikcli.Jsonc, NIKCLI~1, …): the guard keeps denying nikcli, so its test keeps those inputs; correction 2 adds the ragu ones",
  },
  {
    id: "example-word",
    find: /^packages\/voice\/src\/asr\/custom-words\.test\.ts$/,
    why: "spelling-correction tests with nikcli as the sample word («nick cli» → «nikcli», edit distances): renamed, the distances they assert change",
  },
  {
    id: "compat",
    find: /^packages\/(?:ade\/src-tauri\/src\/(?:legacy_cli|app_folder)\.rs|ade\/src\/bots\/app-folder(?:\.test)?\.ts|ade\/src\/session\/legacy-agent-id(?:\.test)?\.ts|util\/src\/app-folder\.ts|ragu\/src\/util\/legacy-env(?:-run)?\.ts|ragu\/src\/migrate\/migrate\.ts|ragu\/test\/migrate\/(?:migrate|cli)\.test\.ts|ragu\/test\/util\/(?:legacy-env|app-folder|app-folder-readers|global-no-ragu-folder)\.test\.ts|ragu\/test\/(?:mod\/guard-rule-b|permission\/auto-protected-rule-b|config\/rule-b-no-move)\.test\.ts)$/,
    why: "the hand fixes after the mechanical commit that name nikcli on purpose: the NIKCLI_* and nikcli-binary fallbacks until 2026-12-01, rule B (ragu if it exists, else nikcli), the saved-id mapping and `ragu migrate` (it renames the nikcli folders), with their tests; a rerun would turn every old name they handle into ragu",
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
