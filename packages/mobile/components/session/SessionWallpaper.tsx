import { StyleSheet, View } from "react-native"
import { Image } from "expo-image"
import { useUIStore } from "@/lib/store"
import { usePrefersReducedTransparency } from "@/lib/animation"

/** `emphasis` lifts the wallpaper for the empty session, where it is the backdrop of the hero. */
export function SessionWallpaper({ emphasis = false }: { emphasis?: boolean }) {
  const wallpaper = useUIStore((state) => state.wallpaper)
  const reduced = usePrefersReducedTransparency()
  if (reduced || !wallpaper.enabled || !wallpaper.uri) return null
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Image
        source={{ uri: wallpaper.uri }}
        style={[StyleSheet.absoluteFill, { opacity: emphasis ? Math.max(wallpaper.opacity, 0.5) : wallpaper.opacity }]}
        contentFit="cover"
      />
    </View>
  )
}
