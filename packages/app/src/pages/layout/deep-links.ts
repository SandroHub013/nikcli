export const deepLinkEvent = "ragu:deep-link"

export const parseDeepLink = (input: string) => {
  if (!input.startsWith("ragu://")) return
  const url = new URL(input)
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

type RaguWindow = Window & {
  __RAGU__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: RaguWindow) => {
  const pending = target.__RAGU__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__RAGU__) target.__RAGU__.deepLinks = []
  return pending
}
