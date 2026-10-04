/**
 * Where a gadget keeps its pairing.
 *
 * One JSON file, mode 0600, under the XDG state directory — or `/var/lib/nikcli-gadget`
 * when `install.sh` set the gadget up as a system service (it exports
 * `NIKCLI_GADGET_STATE`). The token inside is the device's identity on the
 * bridge; losing the file means pairing again, which is the intended recovery.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { hostname, networkInterfaces, homedir } from "node:os"
import path from "node:path"

export interface PairingState {
  readonly server: string
  readonly id: string
  readonly token: string
  readonly name: string
  readonly confirmed: boolean
  readonly pairedAt: number
}

export function stateDirectory(): string {
  const override = process.env.NIKCLI_GADGET_STATE
  if (override) return override
  const xdg = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
  return path.join(xdg, "nikcli-gadget")
}

export function stateFile(): string {
  return path.join(stateDirectory(), "pairing.json")
}

export function readPairing(): PairingState | undefined {
  const file = stateFile()
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PairingState>
    if (typeof raw.server !== "string" || typeof raw.id !== "string" || typeof raw.token !== "string") return undefined
    return {
      server: raw.server,
      id: raw.id,
      token: raw.token,
      name: typeof raw.name === "string" ? raw.name : raw.id,
      confirmed: raw.confirmed !== false,
      pairedAt: typeof raw.pairedAt === "number" ? raw.pairedAt : 0,
    }
  } catch {
    return undefined
  }
}

export function writePairing(state: PairingState): void {
  const dir = stateDirectory()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = stateFile()
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function clearPairing(): void {
  const file = stateFile()
  if (existsSync(file)) unlinkSync(file)
}

/**
 * A stable identity for this machine, hashed so the bridge stores no MAC
 * address: the first non-internal MAC, else `/etc/machine-id`, else the
 * hostname. The bridge binds the token to it and refuses a hello from
 * anywhere else.
 */
export function fingerprint(): string {
  const parts: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") parts.push(iface.mac)
    }
  }
  if (parts.length === 0) {
    try {
      parts.push(readFileSync("/etc/machine-id", "utf8").trim())
    } catch {
      parts.push(hostname())
    }
  }
  return createHash("sha256").update(parts.sort().join("|")).digest("hex").slice(0, 32)
}
