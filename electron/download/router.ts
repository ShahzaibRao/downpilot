/**
 * Engine router: picks the primary download engine from the URL pattern.
 *
 * Rule (from CreatorWatch): image posts are gallery-dl territory —
 * Instagram posts (/p/), TikTok photo-mode, Snapchat — because gallery-dl
 * handles carousels/albums natively. Everything else (YouTube, reels,
 * generic video) goes to yt-dlp first.
 *
 * The secondary engine is always the other one: if the primary fails,
 * the orchestrator falls back automatically (both reasons surface on
 * total failure).
 */
export type Engine = 'ytdlp' | 'gallerydl'

export interface Route {
  primary: Engine
  secondary: Engine
}

export function engineLabel(e: Engine): string {
  return e === 'ytdlp' ? 'yt-dlp' : 'gallery'
}

/** True when the URL is an image post / album rather than a video. */
export function isImagePost(rawUrl: string): boolean {
  const u = rawUrl.toLowerCase()
  // Instagram post or share link (image/carousel). Reels (/reel/) are video → yt-dlp.
  if (/instagram\.com\/(p|share)\//.test(u)) return true
  // TikTok photo mode: /@user/photo/<id>
  if (/tiktok\.com\/@[^/]+\/photo\//.test(u)) return true
  // Snapchat stories / spotlight
  if (/snapchat\.com\//.test(u)) return true
  return false
}

export function routeUrl(url: string): Route {
  if (isImagePost(url)) return { primary: 'gallerydl', secondary: 'ytdlp' }
  return { primary: 'ytdlp', secondary: 'gallerydl' }
}
