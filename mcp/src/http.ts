/**
 * http.ts — the one HTTP seam. Manifest loading, subgraph queries, and the
 * agent-pay POST all go through {@link HttpFetch}, so every network call is
 * injectable in tests with a single stub shape and there is no direct `fetch`
 * coupling scattered across modules.
 */

/** The minimal response shape the callers use. */
export interface HttpResponse {
  /** True for a 2xx status. */
  readonly ok: boolean;
  /** The HTTP status code. */
  readonly status: number;
  /** The response body as text (callers JSON.parse when they expect JSON). */
  text(): Promise<string>;
}

/** Init options for an HTTP call. */
export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A minimal `fetch`, injectable for tests. */
export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/**
 * The default {@link HttpFetch}, wrapping the Node global `fetch` (Node ≥ 18).
 * Narrowed to the small surface the callers need so tests can stub it cleanly.
 */
export const defaultFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, init as RequestInit | undefined);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
};
