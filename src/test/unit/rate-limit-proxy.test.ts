/**
 * Proxy-aware rate limiting — Step 13 Item 6.
 *
 * Proves the in-memory rate limiter keys by the *intended* client IP:
 *
 * - Local / direct-internet (`trustProxy: false`, the default) → `request.ip`
 *   is always the socket's remote address; a forged `X-Forwarded-For` is ignored
 *   and cannot change the bucket. This is safe by default.
 * - Behind a trusted reverse proxy / PaaS (`trustProxy: true` or a list) →
 *   `request.ip` is derived from `X-Forwarded-For`; the limiter correctly caps
 *   the *real* client IP instead of collapsing all clients that share the proxy
 *   into one bucket.
 *
 * The limiter itself is `@fastify/rate-limit` keyed by `request.ip` (its
 * default). No custom `keyGenerator` that reads the header directly is used —
 * that would bypass Fastify's trust check and allow spoofing.
 *
 * Tests drive the real `buildApp` via `inject` with small `max` windows so the
 * 429 is exercised without spamming 100 requests. `remoteAddress` simulates the
 * TCP peer; `x-forwarded-for` simulates the header a proxy or an attacker
 * might send.
 */

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import { inertHumanAuth } from "./human-auth-stubs.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";

const VALID_KEY = "valid-test-key-for-rate-limit";

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential === VALID_KEY) return { tenantId: "tenant-1", apiKeyId: "k1" };
    throw new UnauthorizedError();
  },
};

function silentLogger(): pino.Logger {
  return pino({ level: "silent" });
}

type TrustProxyOpt = boolean | string | string[] | undefined;

async function makeApp(opts: {
  trustProxy?: TrustProxyOpt;
  max?: number;
  timeWindow?: string | number;
}): Promise<ApiServer> {
  const base = {
    logger: silentLogger(),
    ...inertHumanAuth(),
    authenticator,
    checkDatabase: async () => undefined,
    // Minimal tenant-scoped services — only /v1/api-keys is hit in these tests.
    apiKeyServiceFor: () => ({
      create: async () => {
        throw new Error("not used");
      },
      list: async () => [],
      revoke: async () => {
        throw new Error("not used");
      },
    }),
    workflowServiceFor: () => {
      throw new Error("not used");
    },
    connectionServiceFor: () => {
      throw new Error("not used");
    },
    webhookIngestorFor: () => {
      throw new Error("not used");
    },
    webhookSignatureResolverFor: () => {
      throw new Error("not used");
    },
    runInspectionFor: () => ({
      getRun: async () => null,
      listRuns: async () => ({ items: [], nextCursor: null }),
    }),
    rateLimit: {
      max: opts.max ?? 3,
      timeWindow: opts.timeWindow ?? "1 minute",
    },
  } as const;

  if (opts.trustProxy !== undefined) {
    return buildApp({ ...base, trustProxy: opts.trustProxy });
  }
  return buildApp(base);
}

function bearer(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

let app: ApiServer | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe("proxy-aware rate limiting", () => {
  it("uses socket remoteAddress when trustProxy is disabled (default) — X-Forwarded-For is ignored", async () => {
    app = await makeApp({ trustProxy: false, max: 3 });

    // Three requests from the same socket IP but with varying X-Forwarded-For
    // values should all count toward the *same* bucket. They must not be treated
    // as distinct clients.
    for (const xff of ["9.9.9.9", "8.8.8.8", "7.7.7.7"]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": xff },
        remoteAddress: "10.0.0.1",
      });
      expect(res.statusCode).toBe(200);
    }

    // Fourth request from the same socket but yet another forwarded IP must still
    // be rate-limited — proving the header did NOT create a new bucket.
    const limited = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.2.3.4" },
      remoteAddress: "10.0.0.1",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");

    // A different socket IP must have a distinct bucket and still be allowed.
    const other = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(VALID_KEY),
      remoteAddress: "10.0.0.2",
    });
    expect(other.statusCode).toBe(200);
  });

  it("defaults to trustProxy:false when the option is omitted — safe by default", async () => {
    // No `trustProxy` passed at all should behave identically to `false`.
    app = await makeApp({ max: 3 });

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": `1.1.1.${i}` },
        remoteAddress: "10.0.0.5",
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { ...bearer(VALID_KEY), "x-forwarded-for": "9.9.9.9" },
      remoteAddress: "10.0.0.5",
    });
    expect(limited.statusCode).toBe(429);
  });

  it("uses X-Forwarded-For when trustProxy is explicitly enabled — limiter keys by forwarded client IP", async () => {
    app = await makeApp({ trustProxy: true, max: 3 });

    // All requests arrive from the same TCP peer (the proxy) but carry the same
    // forwarded client IP — they must share one bucket.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
        remoteAddress: "10.0.0.1",
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
      remoteAddress: "10.0.0.1",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");

    // Same TCP peer but a *different* forwarded IP must be a different bucket
    // — proving the limiter actually used the forwarded header.
    const otherForwarded = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { ...bearer(VALID_KEY), "x-forwarded-for": "2.2.2.2" },
      remoteAddress: "10.0.0.1",
    });
    expect(otherForwarded.statusCode).toBe(200);

    // Same forwarded IP from a different TCP peer must still be the same bucket
    // (client identity is the forwarded IP when trusting).
    const sameForwardedDifferentSocket = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
      remoteAddress: "10.0.0.99",
    });
    // Still limited because 1.1.1.1 bucket is already exhausted, regardless of socket.
    expect(sameForwardedDifferentSocket.statusCode).toBe(429);
  });

  it("untrusted caller cannot evade the limiter by rotating X-Forwarded-For when trustProxy is disabled", async () => {
    app = await makeApp({ trustProxy: false, max: 3 });

    // Exhaust the bucket for 10.0.0.1 with no forwarding header.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: bearer(VALID_KEY),
        remoteAddress: "10.0.0.1",
      });
      expect(res.statusCode).toBe(200);
    }

    // Attacker tries to present a fresh forwarded IP each time.
    for (const spoof of ["99.99.99.99", "88.88.88.88", "77.77.77.77, 66.66.66.66"]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": spoof },
        remoteAddress: "10.0.0.1",
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("rate_limited");
    }

    // Even a multi-value header must not create a new bucket when not trusted.
    const multi = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      remoteAddress: "10.0.0.1",
    });
    expect(multi.statusCode).toBe(429);
  });

  it("forwards handling only when explicitly configured — same socket, different XFF is same bucket when not trusted, different bucket when trusted", async () => {
    // Not trusted — same socket, different XFF → same bucket.
    {
      const a = await makeApp({ trustProxy: false, max: 2 });
      try {
        const r1 = await a.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
          remoteAddress: "10.0.0.10",
        });
        expect(r1.statusCode).toBe(200);
        const r2 = await a.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "2.2.2.2" },
          remoteAddress: "10.0.0.10",
        });
        expect(r2.statusCode).toBe(200); // second counts toward same bucket
        const r3 = await a.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "3.3.3.3" },
          remoteAddress: "10.0.0.10",
        });
        expect(r3.statusCode).toBe(429); // third exhausts, despite different XFF
      } finally {
        await a.close();
      }
    }

    // Trusted — same socket, different XFF → different buckets.
    {
      const b = await makeApp({ trustProxy: true, max: 2 });
      try {
        const r1 = await b.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
          remoteAddress: "10.0.0.10",
        });
        expect(r1.statusCode).toBe(200);
        // Same XFF again counts; different XFF is a fresh bucket.
        const r2 = await b.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "2.2.2.2" },
          remoteAddress: "10.0.0.10",
        });
        expect(r2.statusCode).toBe(200); // different bucket, allowed
        // Exhausting 1.1.1.1 bucket
        const r3 = await b.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
          remoteAddress: "10.0.0.10",
        });
        expect(r3.statusCode).toBe(200); // second for 1.1.1.1
        const r4 = await b.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
          remoteAddress: "10.0.0.10",
        });
        expect(r4.statusCode).toBe(429); // third for 1.1.1.1
        // 2.2.2.2 still has one remaining slot
        const r5 = await b.inject({
          method: "GET",
          url: "/v1/api-keys",
          headers: { ...bearer(VALID_KEY), "x-forwarded-for": "2.2.2.2" },
          remoteAddress: "10.0.0.10",
        });
        expect(r5.statusCode).toBe(200);
      } finally {
        await b.close();
      }
    }
  });

  it("preserves existing rate-limit limits — healthz remains exempt and limiter shape unchanged", async () => {
    app = await makeApp({ trustProxy: false, max: 2 });

    // Health is exempt even when the protected bucket is exhausted.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: bearer(VALID_KEY),
        remoteAddress: "10.0.0.20",
      });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(VALID_KEY),
      remoteAddress: "10.0.0.20",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: {
        code: "rate_limited",
        message: expect.stringContaining("Rate limit exceeded"),
        requestId: expect.any(String),
      },
    });

    // Health probes must never be throttled into false failures.
    for (let i = 0; i < 5; i++) {
      const health = await app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "10.0.0.20",
      });
      expect(health.statusCode).toBe(200);
    }
  });

  it("preserves existing rate-limit limits — readyz remains exempt alongside healthz", async () => {
    // Mirrors the /healthz exemption test above. Readiness probes are load-
    // balancer traffic and must never share a bucket with the protected API
    // routes — a busy probe must not cause a healthy API to start returning
    // 429s, and conversely an aggressive API client must not be able to make
    // a load balancer conclude "the API is not ready" by exhausting the
    // probe's bucket.
    app = await makeApp({ trustProxy: false, max: 2 });

    // Exhaust the protected bucket.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: bearer(VALID_KEY),
        remoteAddress: "10.0.0.21",
      });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(VALID_KEY),
      remoteAddress: "10.0.0.21",
    });
    expect(limited.statusCode).toBe(429);

    // Readiness probes must keep returning 200 even when the API bucket is
    // exhausted — and the body must still be the readyz shape (no error
    // envelope has leaked into a probe response).
    for (let i = 0; i < 5; i++) {
      const ready = await app.inject({
        method: "GET",
        url: "/readyz",
        remoteAddress: "10.0.0.21",
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ status: "ready" });
    }
  });

  it("respects explicit string trust values (proxy addresses / ranges) — only named proxies are trusted", async () => {
    // Trust only loopback. An inject from 10.0.0.1 (non-loopback) must ignore XFF.
    const a = await makeApp({ trustProxy: "loopback", max: 2 });
    try {
      const r1 = await a.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
        remoteAddress: "10.0.0.1",
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await a.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "2.2.2.2" },
        remoteAddress: "10.0.0.1",
      });
      expect(r2.statusCode).toBe(200); // same bucket, because 10.0.0.1 not trusted, XFF ignored
      const r3 = await a.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "3.3.3.3" },
        remoteAddress: "10.0.0.1",
      });
      expect(r3.statusCode).toBe(429);
    } finally {
      await a.close();
    }

    // Same app but injecting from loopback must respect XFF (trusted).
    const b = await makeApp({ trustProxy: "127.0.0.1", max: 2 });
    try {
      const r1 = await b.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
        remoteAddress: "127.0.0.1",
      });
      expect(r1.statusCode).toBe(200);
      // Same loopback peer, different XFF → different bucket when trusted.
      const r2 = await b.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "2.2.2.2" },
        remoteAddress: "127.0.0.1",
      });
      expect(r2.statusCode).toBe(200);
      const r3 = await b.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
        remoteAddress: "127.0.0.1",
      });
      expect(r3.statusCode).toBe(200); // second for 1.1.1.1
      const r4 = await b.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { ...bearer(VALID_KEY), "x-forwarded-for": "1.1.1.1" },
        remoteAddress: "127.0.0.1",
      });
      expect(r4.statusCode).toBe(429);
    } finally {
      await b.close();
    }
  });
});
