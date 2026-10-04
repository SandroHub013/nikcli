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

/** Names of physical network interfaces on Linux and macOS; docker0, veth*, br-*, tun*, wg* and the like do not match. */
const PHYSICAL = /^(en|eth|wl|ww)/

function machineID(): string | undefined {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(file, "utf8").trim()
      if (id.length >= 16) return id
    } catch {
      // Not a systemd or dbus host.
    }
  }
  return undefined
}

function physicalMACs(): string[] {
  const macs: string[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!PHYSICAL.test(name)) continue
    for (const iface of list ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") macs.push(iface.mac)
    }
  }
  return macs.sort()
}

/**
 * A stable identity for this machine, hashed so the bridge stores no MAC
 * address or machine id: the OS machine id when there is one, else the MACs of
 * its physical interfaces, else its hostname. Virtual interfaces are left out
 * on purpose — containers, bridges and VPNs come and go, and a fingerprint that
 * changes with them locks the device out of its own pairing. The bridge binds
 * the token to this value and refuses a hello from anywhere else.
 */
export function fingerprint(): string {
  const id = machineID()
  const parts = id ? ["machine-id", id] : physicalMACs().length ? ["mac", ...physicalMACs()] : ["host", hostname()]
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)
}
