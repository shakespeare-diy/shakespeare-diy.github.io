import UriTemplate from 'uri-templates';

/**
 * Generate a favicon URL from a template and input URL
 * @param template - URL template with placeholders like {hostname}, {origin}, etc.
 * @param url - The URL to extract parts from
 * @returns The hydrated favicon URL
 */
export function faviconUrl(template: string, url: string | URL): string {
  const u = new URL(url);

  return UriTemplate(template).fill({
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    username: u.username,
    password: u.password,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    hash: u.hash,
    search: u.search,
  });
}

/**
 * Normalize a URL string to ensure it has a protocol
 * @param url - The URL string to normalize
 * @returns A fully-qualified URL string
 */
export function normalizeUrl(url: string): string {
  // If it already has a protocol, return as-is
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  // Add https:// prefix
  return `https://${url}`;
}
