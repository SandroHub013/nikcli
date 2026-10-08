/**
 * Process entry — loads the full CLI.
 *
 * Daemon hosting for the compiled binary is handled in-process by
 * `ensureDaemon` (see `@ragu/browser-control/daemon-client`): there is no
 * on-disk `daemon.ts` under `/$bunfs`, and re-execing this binary just to bind
 * a Unix socket is killed by the OS (SIGKILL on a ~280MB image).
 */
import "./util/legacy-env-run"
import "./util/document-shim"

const { runEffectCli } = await import("./cli/main-effect")
await runEffectCli()
