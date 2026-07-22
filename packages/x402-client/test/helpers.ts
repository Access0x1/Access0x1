/**
 * @file helpers.ts — test doubles for the payer suites. A recording mock {@link FetchLike}
 * plus small response builders, so every scenario runs fully offline.
 */

import type { FetchLike } from "../src/index.js";

/** A single recorded fetch invocation. */
export interface RecordedCall {
  readonly url: string;
  readonly init?: RequestInit;
}

/** A recording mock fetch: the injectable `fetchImpl` plus the list of calls it saw. */
export interface MockFetch {
  readonly fetchImpl: FetchLike;
  readonly calls: RecordedCall[];
}

/** Build a JSON {@link Response} with the given status and body. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a plain-text {@link Response} (used to exercise the non-JSON 402 guard). */
export function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/**
 * Wrap a synchronous URL→Response handler as a recording {@link FetchLike}. Each call is
 * appended to `calls` before the handler runs, so tests can assert order and payloads.
 *
 * @param handler - maps a request URL (and init) to the Response to return.
 * @returns the mock's `fetchImpl` and its recorded `calls`.
 */
export function mockFetch(handler: (url: string, init?: RequestInit) => Response): MockFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

/** Parse a recorded request's JSON body, or `undefined` when there is no string body. */
export function parseInitBody(init?: RequestInit): unknown {
  if (!init || typeof init.body !== "string") {
    return undefined;
  }
  return JSON.parse(init.body);
}

/** Read a header value from a recorded request whose headers are a plain object. */
export function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) {
    return undefined;
  }
  return h[name] ?? h[name.toLowerCase()];
}
