import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
const call = (path, env = {}, init = {}) => worker.fetch(new Request(`https://mirror.example${path}`, init), env, {});
const credentials = () => ({ PUBLIC_API: "true", PIXIV_REFRESH_TOKEN: "fake-refresh", PIXIV_CLIENT_ID: "fake-client", PIXIV_CLIENT_SECRET: "fake-secret" });

async function mockFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("health, unknown route, missing word, missing credentials and method", async () => {
  assert.equal((await call("/healthz")).status, 200);
  assert.equal((await call("/unknown", { PUBLIC_API: "true" })).status, 404);
  assert.equal((await call("/api/search/illust", { PUBLIC_API: "true" })).status, 400);
  assert.equal((await call("/api/search/illust?word=x&offset=-1", { PUBLIC_API: "true" })).status, 400);
  assert.equal((await call("/api/illust/123")).status, 503);
  const res = await call("/api/illust/123", {}, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET, OPTIONS");
});

test("CORS applies consistently to success, errors and preflight", async () => {
  const env = { ALLOWED_ORIGINS: "https://frontend.example" };
  for (const path of ["/healthz", "/unknown", "/api/illust/1"]) {
    const res = await call(path, env, { headers: { Origin: "https://frontend.example" } });
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://frontend.example");
    assert.match(res.headers.get("Vary"), /Origin/);
  }
  assert.equal((await call("/healthz", env, { headers: { Origin: "https://evil.example" } })).headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await call("/api/illust/1", env, { method: "OPTIONS" })).status, 204);
});

test("entry key and limiter are enforced before upstream calls", async () => {
  assert.equal((await call("/api/illust/1", { PUBLIC_API: "false" })).status, 503);
  assert.equal((await call("/api/search/illust", { PUBLIC_API: "true" })).status, 400);
  assert.equal((await call("/api/illust/1", { API_KEY: "key" })).status, 401);
  assert.equal((await call("/api/illust/1", { API_KEY: "key" }, { headers: { Authorization: "Bearer key" } })).status, 503);
  const res = await call("/api/illust/1", { PUBLIC_API: "true", RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
});

test("search URL, token reuse, defaults, pagination and private JSON", async () => {
  let oauth = 0;
  const env = credentials();
  await mockFetch(async (url, init) => {
    const u = new URL(url);
    assert.equal(init.redirect, "manual");
    if (u.hostname === "oauth.secure.pixiv.net") {
      oauth++;
      assert.equal(init.body.get("refresh_token"), "fake-refresh");
      return Response.json({ access_token: "fake-access", expires_in: 3600 });
    }
    assert.equal(u.pathname, "/v1/search/illust");
    assert.equal(u.searchParams.get("word"), "初音未来");
    assert.equal(u.searchParams.get("sort"), "date_desc");
    assert.equal(init.headers.authorization, "Bearer fake-access");
    return Response.json({ illusts: [], next_url: "https://app-api.pixiv.net/v1/search/illust?word=初音未来&offset=30" });
  }, async () => {
    for (let i = 0; i < 2; i++) {
      const res = await call("/api/search/illust?word=初音未来", env);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      const data = await res.json();
      const next = new URL(data.next_url);
      assert.equal(next.hostname, "mirror.example");
      assert.equal(next.searchParams.get("offset"), "30");
    }
    assert.equal(oauth, 1);
  });
});

test("all supported endpoints build proper upstream paths", async () => {
  const env = credentials();
  const pairs = [
    ["/api/illust/12", "/v1/illust/detail", "illust_id"],
    ["/api/illust/12/comments", "/v1/illust/comments", "illust_id"],
    ["/api/illust/12/related", "/v2/illust/related", "illust_id"],
    ["/api/ugoira/12", "/v1/ugoira/metadata", "illust_id"],
    ["/api/user/12", "/v1/user/detail", "user_id"],
    ["/api/user/12/illusts", "/v1/user/illusts", "user_id"],
    ["/api/ranking", "/v1/illust/ranking"],
    ["/api/recommended", "/v1/illust/recommended"],
    ["/api/search/user?word=test", "/v1/search/user"],
  ];
  let last;
  await mockFetch(async (url) => {
    const u = new URL(url);
    if (u.hostname.startsWith("oauth.")) return Response.json({ access_token: "a", expires_in: 3600 });
    last = u;
    return Response.json({ ok: true });
  }, async () => {
    for (const [path, expected, key] of pairs) {
      assert.equal((await call(path, env)).status, 200);
      assert.equal(last.pathname, expected);
      if (key) assert.equal(last.searchParams.get(key), "12");
    }
  });
});

test("401 refreshes once; concurrent requests share refresh", async () => {
  let oauth = 0;
  let api = 0;
  const env = credentials();
  await mockFetch(async (url) => {
    if (new URL(url).hostname.startsWith("oauth.")) {
      oauth++;
      return Response.json({ access_token: `token-${oauth}`, expires_in: 3600 });
    }
    api++;
    return api === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true });
  }, async () => {
    assert.equal((await call("/api/illust/1", env)).status, 200);
    assert.equal(oauth, 2);
    assert.equal(api, 2);
  });
  oauth = 0;
  await mockFetch(async (url) => {
    if (new URL(url).hostname.startsWith("oauth.")) {
      oauth++;
      await Promise.resolve();
      return Response.json({ access_token: "t", expires_in: 3600 });
    }
    return Response.json({ ok: true });
  }, async () => {
    const concurrentEnv = credentials();
    const result = await Promise.all(Array.from({ length: 8 }, () => call("/api/illust/1", concurrentEnv)));
    assert.ok(result.every((r) => r.status === 200));
    assert.equal(oauth, 1);
  });
});

test("image allowlist blocks SSRF inputs without fetching", async () => {
  await mockFetch(() => { throw new Error("Must not fetch"); }, async () => {
    for (const target of ["https://evil.example/a", "https://i.pximg.net.evil.example/a", "http://i.pximg.net/a", "https://user:pass@i.pximg.net/a", "https://i.pximg.net:444/a", "https://127.0.0.1/a", "https://i.pximg.net./a"]) {
      assert.equal((await call(`/api/proxy?url=${encodeURIComponent(target)}`, { PUBLIC_API: "true" })).status, 403);
    }
    assert.equal((await call("/api/proxy", { PUBLIC_API: "true" })).status, 400);
  });
});

test("image proxy rejects redirects, HTML and oversized content", async () => {
  const path = "/api/proxy?url=https%3A%2F%2Fi.pximg.net%2Fa.jpg";
  for (const [response, status] of [
    [new Response(null, { status: 302, headers: { Location: "https://evil.example" } }), 502],
    [new Response("html", { headers: { "Content-Type": "text/html" } }), 502],
    [new Response("x", { headers: { "Content-Type": "image/jpeg", "Content-Length": "30000000" } }), 413],
  ]) {
    await mockFetch(async (_, init) => { assert.equal(init.redirect, "manual"); return response; }, async () => {
      assert.equal((await call(path, { PUBLIC_API: "true" })).status, status);
    });
  }
  await mockFetch(async (_, init) => {
    assert.equal(init.headers.authorization, undefined);
    return new Response(new Uint8Array([255, 216, 255]), { headers: { "Content-Type": "image/jpeg", "Set-Cookie": "secret=x" } });
  }, async () => {
    const res = await call(path, { PUBLIC_API: "true" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Set-Cookie"), null);
    assert.equal((await res.arrayBuffer()).byteLength, 3);
  });
  await mockFetch(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } }), async () => {
    const res = await call(path, { API_KEY: "private", CACHE_TTL: "60" }, { headers: { Authorization: "Bearer private" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

test("upstream secrets never appear in public errors", async () => {
  await mockFetch(async () => new Response("super-sensitive-token", { status: 400 }), async () => {
    const res = await call("/api/illust/1", credentials());
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes("super-sensitive"));
  });
});


test("upstream JSON bodies are bounded even without Content-Length", async () => {
  let canceled = false;
  const env = credentials();
  await mockFetch(async (url) => {
    if (new URL(url).hostname === "oauth.secure.pixiv.net") {
      return Response.json({ access_token: "bounded-test-token", expires_in: 3600 });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { canceled = true; },
    });
    return new Response(body);
  }, async () => {
    const response = await call("/api/illust/1", env);
    assert.equal(response.status, 502);
    assert.equal(canceled, true);
  });
});

test("oversized OAuth JSON is rejected before calling the Pixiv API", async () => {
  let apiCalls = 0;
  await mockFetch(async (url) => {
    if (new URL(url).hostname === "oauth.secure.pixiv.net") {
      return new Response("{}", { headers: { "Content-Length": "65537" } });
    }
    apiCalls++;
    return Response.json({ ok: true });
  }, async () => {
    const response = await call("/api/illust/1", credentials());
    assert.equal(response.status, 502);
    assert.equal(apiCalls, 0);
  });
});


test("streaming JSON preserves split UTF-8, BOM, and invalid byte replacement", async () => {
  const encoder = new TextEncoder();
  const oauth = encoder.encode('\ufeff{"access_token":"token","expires_in":3600}');
  const prefix = encoder.encode('\ufeff{"text":"初音🌌","invalid":"');
  const suffix = encoder.encode('"}');
  const api = new Uint8Array(prefix.length + 3 + suffix.length);
  api.set(prefix);
  api.set([0xe3, 0x28, 0xa1], prefix.length);
  api.set(suffix, prefix.length + 3);

  function splitResponse(bytes) {
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    }), { headers: { "Content-Length": "1" } });
  }

  await mockFetch(async (url, init) => {
    if (new URL(url).hostname === "oauth.secure.pixiv.net") return splitResponse(oauth);
    assert.equal(init.headers.authorization, "Bearer token");
    return splitResponse(api);
  }, async () => {
    const response = await call("/api/illust/1", credentials());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "初音🌌", invalid: "�(�" });
  });
});

test("image cache serves public hits and is skipped when caching is disabled", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const entries = new Map();
  let cacheAccesses = 0;
  let fetches = 0;
  const cache = {
    async match(key) {
      const entry = entries.get(key.url);
      return entry && new Response(entry.body, { headers: entry.headers });
    },
    async put(key, response) {
      entries.set(key.url, { body: await response.arrayBuffer(), headers: response.headers });
    },
  };
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { get default() { cacheAccesses++; return cache; } },
  });

  async function requestImage(target, env, headers = {}) {
    const pending = [];
    const request = new Request(`https://mirror.example/api/proxy?url=${encodeURIComponent(target)}`, { headers });
    const response = await worker.fetch(request, env, { waitUntil(promise) { pending.push(promise); } });
    const body = await response.arrayBuffer();
    await Promise.all(pending);
    return { response, body: [...new Uint8Array(body)] };
  }

  try {
    await mockFetch(async () => {
      fetches++;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    }, async () => {
      const publicEnv = { PUBLIC_API: "true", CACHE_TTL: "60" };
      const first = await requestImage("https://i.pximg.net/a.png?version=1", publicEnv);
      const second = await requestImage("https://i.pximg.net/a.png?version=2", publicEnv);
      assert.deepEqual(first.body, [1, 2, 3]);
      assert.deepEqual(second.body, first.body);
      assert.equal(second.response.headers.get("Cache-Control"), "public, max-age=60");
      assert.equal(fetches, 1);
      assert.equal(cacheAccesses, 2);

      const privateImage = await requestImage("https://i.pximg.net/a.png", { API_KEY: "private", CACHE_TTL: "60" }, { Authorization: "Bearer private" });
      assert.equal(privateImage.response.headers.get("Cache-Control"), "no-store");
      const uncached = await requestImage("https://i.pximg.net/a.png", { PUBLIC_API: "true", CACHE_TTL: "0" });
      assert.equal(uncached.response.headers.get("Cache-Control"), "no-store");
      assert.equal(fetches, 3);
      assert.equal(cacheAccesses, 2);
    });
  } finally {
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else delete globalThis.caches;
  }
});
