function parseUrl(rawUrl: string | null | undefined): URL | null {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return null;
  }

  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Resolve the launch URL for a newly-created desktop window.
 *
 * If the source URL is valid and belongs to the same app origin/scheme,
 * reuse it so the new window opens on the same thread/view.
 * Otherwise, fall back to the default app URL.
 */
export function resolveWindowUrlForNewWindow(
  sourceUrl: string | null | undefined,
  fallbackUrl: string,
): string {
  const fallback = parseUrl(fallbackUrl);
  if (!fallback) {
    throw new Error(`Invalid fallback URL: ${fallbackUrl}`);
  }

  const source = parseUrl(sourceUrl);
  if (!source) {
    return fallback.toString();
  }

  if (source.protocol !== fallback.protocol || source.host !== fallback.host) {
    return fallback.toString();
  }

  return source.toString();
}
