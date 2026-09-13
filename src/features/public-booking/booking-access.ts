/** Only accept this app's booking links; never redirect to user-provided origins. */
export function bookingPathFromLink(input: string, origin: string): string | null {
  try {
    const url = new URL(input.trim(), origin)
    if (![origin, 'https://mal3aby.app', 'https://www.mal3aby.app'].includes(url.origin)) return null
    const match = url.pathname.match(/^\/qr\/([a-f0-9]{64})\/?$/i)
    return match ? `/qr/${match[1]}` : null
  } catch {
    return null
  }
}
