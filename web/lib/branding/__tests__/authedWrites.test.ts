/**
 * authedWrites.test.ts — the Dynamic JWT rides every branding WRITE.
 *
 * Production rejects unverified tenant writes (BRANDING_REQUIRE_VERIFIED_WRITES
 * defaults on), so the write clients MUST send the Dynamic session as
 * `authorization: Bearer <jwt>` — the exact header lib/branding/tenant.ts
 * verifies. Pins:
 *  - authedJsonHeaders(): Bearer present when a session exists, absent when not,
 *    read PER CALL (a refreshed token is the one sent);
 *  - all four write clients (saveBranding, saveCheckoutMode, attachOnChain,
 *    uploadLogo) send the header; reads (loadBranding) stay unauthenticated.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the Dynamic SDK's token reader before importing the clients.
const getAuthToken = vi.fn<() => string | undefined>();
vi.mock("@dynamic-labs/sdk-react-core", () => ({
  getAuthToken: () => getAuthToken(),
}));

import { authedJsonHeaders } from "../../authedFetch";
import {
  attachOnChain,
  loadBranding,
  saveBranding,
  saveCheckoutMode,
  uploadLogo,
} from "../client";

afterEach(() => {
  vi.restoreAllMocks();
  getAuthToken.mockReset();
});

function mockFetchOk(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** The headers of the first fetch call, normalized. */
function sentHeaders(fetchSpy: ReturnType<typeof vi.spyOn>): Headers {
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  return new Headers(init?.headers);
}

describe("authedJsonHeaders", () => {
  it("attaches the Bearer token when a Dynamic session exists, omits it when not", () => {
    getAuthToken.mockReturnValue("jwt-1");
    expect(authedJsonHeaders()).toEqual({
      "content-type": "application/json",
      authorization: "Bearer jwt-1",
    });
    getAuthToken.mockReturnValue(undefined);
    expect(authedJsonHeaders()).toEqual({ "content-type": "application/json" });
  });

  it("reads the token per call — a refreshed session is the one sent", () => {
    getAuthToken.mockReturnValueOnce("old").mockReturnValueOnce("new");
    expect(authedJsonHeaders().authorization).toBe("Bearer old");
    expect(authedJsonHeaders().authorization).toBe("Bearer new");
  });
});

describe("branding write clients send the Dynamic JWT", () => {
  const BRANDING = { branding: { tenantId: "0xT", displayName: "Acme" } };

  it("saveBranding", async () => {
    getAuthToken.mockReturnValue("jwt-w");
    const spy = mockFetchOk(BRANDING);
    await saveBranding({ tenantId: "0xT", displayName: "Acme" });
    expect(sentHeaders(spy).get("authorization")).toBe("Bearer jwt-w");
  });

  it("saveCheckoutMode", async () => {
    getAuthToken.mockReturnValue("jwt-w");
    const spy = mockFetchOk(BRANDING);
    await saveCheckoutMode({ tenantId: "0xT", checkoutMode: "open" as never });
    expect(sentHeaders(spy).get("authorization")).toBe("Bearer jwt-w");
  });

  it("attachOnChain", async () => {
    getAuthToken.mockReturnValue("jwt-w");
    const spy = mockFetchOk(BRANDING);
    await attachOnChain({ tenantId: "0xT", merchantId: "1", chainId: 84532 });
    expect(sentHeaders(spy).get("authorization")).toBe("Bearer jwt-w");
  });

  it("uploadLogo", async () => {
    getAuthToken.mockReturnValue("jwt-w");
    const spy = mockFetchOk({ logoSvgInline: "<svg/>" });
    await uploadLogo("0xT", "<svg/>");
    expect(sentHeaders(spy).get("authorization")).toBe("Bearer jwt-w");
  });

  it("reads stay unauthenticated (loadBranding sends no auth header)", async () => {
    getAuthToken.mockReturnValue("jwt-w");
    const spy = mockFetchOk({ branding: null });
    await loadBranding("0xT");
    const init = spy.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.headers ?? null).toBeNull();
  });
});
