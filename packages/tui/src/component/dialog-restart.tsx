import { DialogHeader } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { Spinner } from "@tui/component/spinner"

/**
 * What `/restart` puts on screen while the host replaces the server.
 *
 * The work is the part that takes time — SIGTERM to the service, then a health
 * poll for the one that replaces it — and it is why this dialog exists rather
 * than a toast: a restart that shows nothing for three seconds reads as a hung
 * terminal, and the terminal is about to be handed to a process that is not
 * running yet.
 *
 * It is deliberately not dismissible. There is nothing to cancel: the sequence
 * is stop, start, reconnect, and interrupting it half way would leave the
 * terminal pointed at a server that is down.
 *
 * `target` is the host's own word for what it is replacing, so the default path
 * says "background service" and the private in-process path says "server"
 * rather than both claiming a daemon neither of them runs.
 */
export function DialogRestart(props: { target: string }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={2} paddingRight={2} flexDirection="column" gap={1} width={60} maxWidth="90%">
      <DialogHeader title="Restarting nikcli" />
      <Spinner color={theme.foreground.muted}>{`Restarting the ${props.target}…`}</Spinner>
      <text fg={theme.foreground.muted} wrapMode="word">
        This terminal reconnects on its own. Live sessions are suspended and resumed by the service that comes back.
      </text>
    </box>
  )
}
