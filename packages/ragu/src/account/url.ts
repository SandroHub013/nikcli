export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    url = new URL(`https://${trimmed}`)
  }

  // Ensure trailing slash
  let result = url.toString()
  if (!result.endsWith("/")) {
    result += "/"
  }

  return result
}
