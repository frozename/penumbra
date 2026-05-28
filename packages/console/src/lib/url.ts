type QueryValue = string | number | boolean | null | undefined;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Build a request URL from a baseUrl + path for both relative and absolute base URLs.
 */
export function buildRequestUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, QueryValue>,
): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  let url: string;

  if (baseUrl.startsWith("/")) {
    url = `${trimTrailingSlash(baseUrl)}${cleanPath}`;
  } else {
    url = new URL(cleanPath.replace(/^\//, ""), `${trimTrailingSlash(baseUrl)}/`).toString();
  }

  if (!params) return url;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}
