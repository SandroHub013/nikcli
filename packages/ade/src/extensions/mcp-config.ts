import { joinPath } from "../host/path"
import type { McpInstallConfiguration, McpServerConfig } from "./mcp-catalog"

export type { McpInstallConfiguration, McpServerConfig } from "./mcp-catalog"

export const MCP_CONFIG_FILENAME = ".mcp.json"

type JsonObject = Record<string, unknown>

export interface McpConfigDocument extends JsonObject {
  readonly mcpServers?: Record<string, unknown>
}

/** The small filesystem seam needed by the project-level operations. */
export interface McpConfigIO {
  readTextFile: (path: string, maxBytes?: number) => Promise<{ text: string; truncated?: boolean }>
  writeTextFile: (path: string, contents: string) => Promise<string | null | undefined | void>
  /** When present, distinguishes an unreadable file from a missing file. */
  exists?: (path: string) => Promise<boolean>
}

export type McpConfigErrorCode =
  | "invalid-json"
  | "invalid-document"
  | "invalid-server-name"
  | "duplicate-server"
  | "invalid-server-config"
  | "secret-value"
  | "read-failed"
  | "write-failed"

export class McpConfigError extends Error {
  readonly code: McpConfigErrorCode

  constructor(code: McpConfigErrorCode, message: string) {
    super(message)
    this.name = "McpConfigError"
    this.code = code
  }
}

const SECRET_REFERENCE = /^\$\{[A-Z][A-Z0-9_]*\}$/
const SECRET_HEADER_TEMPLATE = /^(?:(?:Bearer|Basic) )?\$\{[A-Z][A-Z0-9_]*\}$/
const SECRET_ARGUMENT_TEMPLATE = /^(?:--[A-Za-z0-9_-]+=)?\$\{[A-Z][A-Z0-9_]*\}$/

/** True only for the `${UPPER_SNAKE_CASE}` references ADE may persist. */
export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE.test(value)
}

/** `.mcp.json` lives in the project, never in ADE's global settings. */
export function mcpConfigPath(projectRoot: string): string {
  return joinPath(projectRoot, MCP_CONFIG_FILENAME)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parses a project config while keeping all unrelated top-level keys intact. */
export function parseMcpConfig(raw: string | null | undefined): McpConfigDocument {
  if (raw === undefined || raw === null || raw.trim().length === 0) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\ufeff/, ""))
  } catch {
    throw new McpConfigError("invalid-json", `${MCP_CONFIG_FILENAME} non contiene JSON valido.`)
  }

  if (!isObject(parsed)) {
    throw new McpConfigError("invalid-document", `${MCP_CONFIG_FILENAME} deve contenere un oggetto JSON.`)
  }
  if ("mcpServers" in parsed && !isObject(parsed.mcpServers)) {
    throw new McpConfigError("invalid-document", `${MCP_CONFIG_FILENAME}: "mcpServers" deve essere un oggetto.`)
  }
  return parsed
}

function serverName(name: string): string {
  if (name.trim() !== name || name.length === 0 || name.length > 128 || name === "__proto__") {
    throw new McpConfigError("invalid-server-name", "Il nome del server MCP non è valido.")
  }
  return name
}

function isSensitiveName(name: string): boolean {
  return /(authorization|bearer|token|secret|password|api[_-]?key|client[_-]?(id|secret)|connection)/i.test(name)
}

function hasSafeSecretTemplate(value: string, pattern = SECRET_HEADER_TEMPLATE): boolean {
  return pattern.test(value)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpConfigError("invalid-server-config", `${label} deve essere una stringa non vuota.`)
  }
}

/**
 * Checks only the values ADE is about to add. Existing project entries are
 * preserved as-is, but a newly selected card can never smuggle a raw token
 * into the project file.
 */
export function validateMcpServerConfig(config: McpServerConfig): void {
  if (!isObject(config)) {
    throw new McpConfigError("invalid-server-config", "La configurazione del server MCP non è un oggetto.")
  }

  const hasUrl = config.url !== undefined
  const hasCommand = config.command !== undefined
  if (!hasUrl && !hasCommand) {
    throw new McpConfigError("invalid-server-config", "La configurazione MCP deve avere url oppure command.")
  }

  if (hasUrl) {
    assertString(config.url, "url")
    try {
      const url = new URL(config.url)
      if (url.username || url.password) {
        throw new McpConfigError("secret-value", "url non può contenere credenziali incorporate.")
      }
      for (const [name, value] of url.searchParams) {
        if (isSensitiveName(name) && !isSecretReference(value)) {
          throw new McpConfigError(
            "secret-value",
            `url contiene un valore segreto nel parametro ${name}: usa un riferimento "\${NOME_VARIABILE}".`,
          )
        }
      }
    } catch (error) {
      if (error instanceof McpConfigError) throw error
      throw new McpConfigError("invalid-server-config", "url deve essere un URL valido.")
    }
  }
  if (hasCommand) assertString(config.command, "command")

  if (config.args !== undefined) {
    if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
      throw new McpConfigError("invalid-server-config", "args deve essere un array di stringhe.")
    }
    for (const [index, arg] of config.args.entries()) {
      if (!isSensitiveName(arg)) continue
      const value = arg.includes("=") ? arg : config.args[index + 1]
      const safe = arg.includes("=")
        ? hasSafeSecretTemplate(arg, SECRET_ARGUMENT_TEMPLATE)
        : value !== undefined && isSecretReference(value)
      if (!safe) {
        throw new McpConfigError(
          "secret-value",
          `args[${index}] contiene un possibile segreto: usa un riferimento \"\${NOME_VARIABILE}\".`,
        )
      }
    }
  }

  if (config.env !== undefined) {
    if (!isObject(config.env)) {
      throw new McpConfigError("invalid-server-config", "env deve essere un oggetto di stringhe.")
    }
    for (const [name, value] of Object.entries(config.env)) {
      assertString(value, `env.${name}`)
      if (isSensitiveName(name) && !isSecretReference(value)) {
        throw new McpConfigError(
          "secret-value",
          `env.${name} deve usare un riferimento \"\${NOME_VARIABILE}\", non un valore segreto.`,
        )
      }
    }
  }

  if (config.headers !== undefined) {
    if (!isObject(config.headers)) {
      throw new McpConfigError("invalid-server-config", "headers deve essere un oggetto di stringhe.")
    }
    for (const [name, value] of Object.entries(config.headers)) {
      assertString(value, `headers.${name}`)
      if (isSensitiveName(name) && !hasSafeSecretTemplate(value)) {
        throw new McpConfigError(
          "secret-value",
          `headers.${name} deve usare un riferimento \"\${NOME_VARIABILE}\", non un valore segreto.`,
        )
      }
    }
  }

  if (config.oauth !== undefined) {
    if (!isObject(config.oauth)) {
      throw new McpConfigError("invalid-server-config", "oauth deve essere un oggetto.")
    }
    assertString(config.oauth.clientId, "oauth.clientId")
    assertString(config.oauth.clientSecret, "oauth.clientSecret")
    if (!isSecretReference(config.oauth.clientId) || !isSecretReference(config.oauth.clientSecret)) {
      throw new McpConfigError(
        "secret-value",
        "oauth.clientId e oauth.clientSecret devono usare riferimenti di variabile, non valori segreti.",
      )
    }
  }
}

function installationOf(
  input: McpInstallConfiguration | string,
  definition?: McpServerConfig,
): McpInstallConfiguration {
  if (typeof input === "string") {
    if (definition === undefined) {
      throw new McpConfigError("invalid-server-config", "Manca la configurazione del server MCP.")
    }
    return { name: input, server: definition }
  }
  return input
}

function indentation(raw: string | null | undefined): string {
  if (!raw) return "  "
  const line = raw.split(/\r?\n/).find((candidate) => /^\s+\"[^\"]+\"\s*:/.test(candidate))
  if (!line) return "  "
  const leading = line.match(/^\s+/)?.[0] ?? "  "
  return leading.includes("\t") ? "\t" : leading.slice(0, 10)
}

function newline(raw: string | null | undefined): "\n" | "\r\n" {
  return raw?.includes("\r\n") ? "\r\n" : "\n"
}

function render(document: JsonObject, source: string | null | undefined): string {
  let json: string
  try {
    json = JSON.stringify(document, null, indentation(source))
  } catch {
    throw new McpConfigError("invalid-document", `${MCP_CONFIG_FILENAME} non è serializzabile.`)
  }
  const lineBreak = newline(source)
  if (lineBreak === "\r\n") json = json.replace(/\n/g, "\r\n")
  return `${json}${lineBreak}`
}

/** Adds one card's server definition and refuses an existing name. */
export function addMcpServer(raw: string | null | undefined, installation: McpInstallConfiguration): string
export function addMcpServer(raw: string | null | undefined, name: string, server: McpServerConfig): string
export function addMcpServer(
  raw: string | null | undefined,
  input: McpInstallConfiguration | string,
  definition?: McpServerConfig,
): string {
  const chosen = installationOf(input, definition)
  const name = serverName(chosen.name)
  validateMcpServerConfig(chosen.server)

  const document = parseMcpConfig(raw)
  const servers = isObject(document.mcpServers) ? document.mcpServers : {}
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new McpConfigError("duplicate-server", `Il server MCP "${name}" è già presente in ${MCP_CONFIG_FILENAME}.`)
  }

  return render({ ...document, mcpServers: { ...servers, [name]: chosen.server } }, raw)
}

/** Removes one server and returns the original text when there was nothing to remove. */
export function removeMcpServer(raw: string | null | undefined, name: string): string | undefined {
  if (raw === undefined || raw === null) return raw ?? undefined
  const key = serverName(name)
  const document = parseMcpConfig(raw)
  const servers = document.mcpServers
  if (!isObject(servers) || !Object.prototype.hasOwnProperty.call(servers, key)) return raw

  const nextServers = { ...servers }
  delete nextServers[key]
  return render({ ...document, mcpServers: nextServers }, raw)
}

/** Reads `.mcp.json`; an absent file is the normal first-install case. */
export async function readProjectMcpConfig(projectRoot: string, io: McpConfigIO): Promise<string | undefined> {
  const path = mcpConfigPath(projectRoot)
  try {
    const read = await io.readTextFile(path)
    if (read.truncated) {
      throw new McpConfigError(
        "read-failed",
        `${MCP_CONFIG_FILENAME} è troppo grande per essere riscritto in sicurezza.`,
      )
    }
    return read.text
  } catch (error) {
    if (error instanceof McpConfigError) throw error
    if (io.exists) {
      let present = false
      try {
        present = await io.exists(path)
      } catch {
        present = true
      }
      if (present) {
        throw new McpConfigError(
          "read-failed",
          `Impossibile leggere ${MCP_CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return undefined
  }
}

async function writeProjectMcpConfig(projectRoot: string, contents: string, io: McpConfigIO): Promise<void> {
  const failure = await io.writeTextFile(mcpConfigPath(projectRoot), contents)
  if (failure) {
    throw new McpConfigError("write-failed", `Impossibile scrivere ${MCP_CONFIG_FILENAME}: ${failure}`)
  }
}

/** Merges one server into the project file and returns the written text. */
export async function addMcpServerToProject(
  projectRoot: string,
  installation: McpInstallConfiguration,
  io: McpConfigIO,
): Promise<string> {
  const current = await readProjectMcpConfig(projectRoot, io)
  const next = addMcpServer(current, installation)
  await writeProjectMcpConfig(projectRoot, next, io)
  return next
}

/** Removes one server from the project file without rewriting a no-op. */
export async function removeMcpServerFromProject(
  projectRoot: string,
  name: string,
  io: McpConfigIO,
): Promise<string | undefined> {
  const current = await readProjectMcpConfig(projectRoot, io)
  const next = removeMcpServer(current, name)
  if (next !== undefined && next !== current) await writeProjectMcpConfig(projectRoot, next, io)
  return next
}
