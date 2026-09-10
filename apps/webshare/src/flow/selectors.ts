// ── Webshare flow selectors + endpoints ────────────────────────────
// Validated against webshare_dataset/*.html and against the live app's own
// bundle (assets/WithGoogleAuth-*.js, assets/dashboard-shell-*.js).

export const Selectors = {
  /**
   * The register page runs Google Identity Services. Its default is a POPUP
   * (`ux_mode: "popup"`) started by the button, and in an automated browser
   * that popup never materialises — the click looks like it did nothing.
   *
   * The same module switches to a TOP-LEVEL REDIRECT and auto-starts itself
   * when the query string carries an empty `start_google_login_flow`:
   *
   *   const m = search.start_google_login_flow === "";
   *   ux_mode: m ? "redirect" : "popup"     // and a useEffect calls it
   *
   * So we never touch the button. Note the trailing `=`: `?start_google_login_flow`
   * with no value parses to something else and silently keeps the popup mode.
   */
  signupUrl: "https://dashboard.webshare.io/register/?start_google_login_flow=",
  /** fallback: the button itself, for a manual/headed run */
  signUpGoogleButton: ['button[data-testid="google-button"]'] as string[],

  /** where the app lands after it exchanges the OAuth code */
  dashboardUrlRe: /dashboard\.webshare\.io\/(dashboard|\d+\/)/,
  loggedOutUrlRe: /dashboard\.webshare\.io\/(register|login)/,

  /**
   * Sidebar link, rendered from the route template `/$planId/proxy/list`.
   * Reading the planId out of an href is far stabler than the proxy table.
   */
  proxyListLink: 'a[href*="/proxy/list"]',
  planIdFromHrefRe: /\/(\d{3,})\/proxy\/list/,

  /**
   * The app's own API — base `https://proxy.webshare.io/api`, version `v2`,
   * authorised with `Authorization: Token <token>` that the app keeps in
   * memory only. Any call carries the same token, so grab it from the first
   * one we see rather than depending on the list call happening first.
   */
  proxyApiRe: /proxy\.webshare\.io\/api\//,
  proxyListApiRe: /proxy\.webshare\.io\/api\/[^?]*proxy\/list\//,
  proxyListApiUrl: "https://proxy.webshare.io/api/v2/proxy/list/",
} as const;

/** A proxy row as the v2 API returns it. */
export interface ApiProxyRow {
  id?: string;
  username?: string;
  password?: string;
  proxy_address?: string;
  port?: number;
  valid?: boolean;
}

export const HOST_RE = /^[a-z0-9.-]+$/i;

/** Keep only rows that are actually usable as a proxy. */
export function isUsableProxyRow(row: ApiProxyRow): boolean {
  return Boolean(
    row &&
      typeof row.proxy_address === "string" &&
      HOST_RE.test(row.proxy_address) &&
      typeof row.port === "number" &&
      row.port > 0 &&
      row.port < 65536,
  );
}
