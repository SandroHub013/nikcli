import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Server } from "@/server/server"
import { UI } from "@/cli/ui"
import { resolveNetworkOptions } from "@/cli/network"
import { Flag } from "@ragu/util/flag"
import open from "open"
import { getLocalIPs } from "@ragu/util/mobile-pairing"

/**
 * Addresses to print for "open this on your phone", best first. Shares the pairing ranking, which
 * drops link-local adapters the phone cannot reach and puts VM switches last.
 */
export function getNetworkIPs() {
  return getLocalIPs()
}

/**
 * The web interface the server serves itself. `/` used to be answered by the proxy to Nik's hosted app, which is
 * gone, so `/` is a 404.
 */
export function webInterfaceUrl(base: string) {
  return new URL("/companion", base).toString()
}

/**
 * The addresses printed for a server on `0.0.0.0`, beyond localhost: one per network address and, with mDNS, the
 * `ragu.local` name. Every one is the web interface (`/companion`), as the localhost one is: the server answers `/`
 * with a 404, so a bare `http://ip:port` was a link that did not open anything.
 */
export function networkAccessUrls(port: number | undefined, ips: readonly string[], mdns: boolean) {
  // A server that does not say which port it took has no address anyone else can be told.
  if (port === undefined) return { network: [], mdns: undefined }
  return {
    network: ips.map((ip) => webInterfaceUrl(`http://${ip.includes(":") ? `[${ip}]` : ip}:${port}`)),
    mdns: mdns ? webInterfaceUrl(`http://ragu.local:${port}`) : undefined,
  }
}

export default Runtime.handler(Commands.commands["web"], async (input) => {
  const args = {
    _: [],
    $0: "ragu",
    "--": passthrough(),
    port: input["port"],
    hostname: input["hostname"],
    mdns: input["mdns"],
    cors: [...input["cors"]],
  }
  // SAFETY: this command's builder is `withNetworkOptions`, which declares
  // exactly the flags `resolveNetworkOptions` reads. yargs infers a wider
  // argv type than the builder guarantees.
  const opts = await resolveNetworkOptions(args as Parameters<typeof resolveNetworkOptions>[0])

  const loopback = opts.hostname === "127.0.0.1" || opts.hostname === "::1" || opts.hostname === "localhost"
  const tailscaleAuthActive = Flag.RAGU_SERVER_TAILSCALE_AUTH && loopback

  if (Flag.RAGU_SERVER_TAILSCALE_AUTH && !loopback) {
    UI.println(
      UI.Style.TEXT_WARNING_BOLD +
        "!  " +
        "RAGU_SERVER_TAILSCALE_AUTH is set but hostname is not loopback; Tailscale identity headers will not be trusted.",
    )
  }

  if (!Flag.RAGU_SERVER_PASSWORD && !tailscaleAuthActive) {
    UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "RAGU_SERVER_PASSWORD is not set; server is unsecured.")
  }

  const server = Server.listen(opts)
  UI.empty()
  UI.println(UI.logo("  "))
  UI.empty()

  if (opts.hostname === "0.0.0.0") {
    // `server.port` is absent when the listener does not report one: its own URL carries the port then.
    const port = server.port ?? (Number(server.url.port) || undefined)
    const localhostUrl = webInterfaceUrl(port !== undefined ? `http://localhost:${port}` : server.url.toString())
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

    const urls = networkAccessUrls(port, getNetworkIPs(), Boolean(opts.mdns))
    for (const url of urls.network) {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Network access:    ", UI.Style.TEXT_NORMAL, url)
    }

    if (urls.mdns) {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  mDNS:              ", UI.Style.TEXT_NORMAL, urls.mdns)
    }

    open(localhostUrl).catch(() => {})
  } else {
    const displayUrl = webInterfaceUrl(server.url.toString())
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
    open(displayUrl).catch(() => {})
  }

  await new Promise(() => {})
  await server.stop()
})
