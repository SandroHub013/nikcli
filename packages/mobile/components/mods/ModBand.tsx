import { View } from "react-native"
import { ModHost, useModHost } from "./ModHost"
import { ModSite } from "./ModSite"

/**
 * What mods draw above the composer: their band, then the panes they opened inline. Renders nothing
 * until a mod that draws is loaded, so a host with no such mod costs the session screen one idle
 * event stream and no layout.
 */
export function ModBand({ sessionID, working }: { sessionID: string; working: boolean }) {
  return (
    <ModHost>
      <Band sessionID={sessionID} working={working} />
    </ModHost>
  )
}

function Band({ sessionID, working }: { sessionID: string; working: boolean }) {
  const { hooked, panes } = useModHost()
  if (!hooked && panes.length === 0) return null
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
      <ModSite component="AbovePrompt" requestId="band" sessionID={sessionID} extra={{ isWorking: working }} />
      {panes
        .filter((pane) => pane.placement === "inline")
        .map((pane) => (
          <ModSite
            key={pane.id}
            component="Pane"
            requestId={pane.id}
            sessionID={sessionID}
            title={pane.title}
            extra={{ title: pane.title, placement: "inline" }}
          />
        ))}
    </View>
  )
}
