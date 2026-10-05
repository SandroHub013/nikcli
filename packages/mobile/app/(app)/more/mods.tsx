import { useCallback, useEffect, useState } from "react"
import { ScrollView, Text, View } from "react-native"
import { useFocusEffect } from "expo-router"
import { ModHost, useModHost } from "@/components/mods/ModHost"
import { ModSite } from "@/components/mods/ModSite"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorBanner } from "@/components/ui/ErrorBanner"
import { InfoChip } from "@/components/ui/InfoChip"
import { SurfaceCard } from "@/components/ui/SurfaceCard"
import type { ModInfo } from "@/lib/mod-tree"
import { useServer } from "@/lib/server-context"
import { useAppTheme } from "@/lib/theme"
import { type as typeStyle } from "@/lib/typography"

/**
 * The mods loaded on the host and what they draw.
 *
 * A mod is a plugin that runs in the nikcli server. Edit one on the host and it reloads there; the
 * panes below redraw on their own. This is the same mod the terminal shows, drawn for a phone: the
 * mod asks which `surface` is drawing and can answer with a layout made for it.
 */
export default function ModsScreen() {
  return (
    <ModHost>
      <Mods />
    </ModHost>
  )
}

function Mods() {
  const { palette } = useAppTheme()
  const { client } = useServer()
  const { panes, ready, hooked } = useModHost()
  const [mods, setMods] = useState<ModInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!client) return
    try {
      setError(null)
      setMods(await client.modList())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [client])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  // A mod loading or reloading changes `hooked` or the pane list; the list of mods follows.
  useEffect(() => {
    void load()
  }, [load, hooked, panes.length])

  const drawing = mods.filter((mod) => mod.events.includes("ui.render"))

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 96, gap: 16 }}
    >
      <Text selectable style={{ color: palette.muted, ...typeStyle(13) }}>
        Plugins that run on the host and draw for every client. Edits on the host reload live.
      </Text>

      {error ? <ErrorBanner message={error} /> : null}

      <ModSite component="AbovePrompt" requestId="band" />

      {panes.map((pane) => (
        <ModSite
          key={pane.id}
          component="Pane"
          requestId={pane.id}
          title={pane.title}
          extra={{ title: pane.title, placement: pane.placement }}
        />
      ))}

      {ready && mods.length === 0 && !error ? (
        <EmptyState
          title="No mods loaded"
          description="Add a mod to .nikcli/plugin on the host, or run `nikcli plugin create` there. It shows up here without restarting."
        />
      ) : null}

      {mods.length > 0 ? (
        <SurfaceCard eyebrow="Loaded" title={`${mods.length} ${mods.length === 1 ? "mod" : "mods"}`}>
          <View style={{ gap: 14, marginTop: 4 }}>
            {mods.map((mod) => (
              <View key={mod.id} style={{ gap: 6 }}>
                <Text selectable style={{ color: palette.ink, ...typeStyle(15, { weight: "600" }) }}>
                  {mod.name}
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <InfoChip label={mod.tier} />
                  {drawing.some((item) => item.id === mod.id) ? <InfoChip label="draws UI" tone="accent" /> : null}
                  {mod.commands.length > 0 ? <InfoChip label={`${mod.commands.length} commands`} /> : null}
                  {mod.tools.length > 0 ? <InfoChip label={`${mod.tools.length} tools`} /> : null}
                </View>
              </View>
            ))}
          </View>
        </SurfaceCard>
      ) : null}
    </ScrollView>
  )
}
