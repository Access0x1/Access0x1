/**
 * @file serverOnly.ts — import-time browser guard (doctrine guardrail #4 / #7).
 *
 * Every module under `lib/agent/` calls {@link assertServerOnly} at import time so the
 * Dynamic API token, MPC wallet password, and auth token can never be pulled into the
 * client bundle of this public repo. If a module that imports one of these is ever
 * referenced from a `"use client"` component, the bundler will surface a throw at import
 * rather than silently shipping a secret to the browser.
 */

/**
 * Throw if this module is being evaluated in a browser context.
 *
 * @param moduleName The importing module's name, used in the error message for a clear
 *   stack trace when a server-only file is mistakenly bundled for the client.
 * @returns void
 * @throws {Error} if a `window` global is present (browser / client bundle).
 */
export function assertServerOnly(moduleName: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${moduleName} is server-only and must never be imported into a client bundle ` +
        "(it reads server secrets: DYNAMIC_AUTH_TOKEN / WALLET_PASSWORD).",
    );
  }
}
