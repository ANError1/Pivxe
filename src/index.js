const API_BASE = "https://app-api.pixiv.net";
const OAUTH_URL = "https://oauth.secure.pixiv.net/auth/token";
const APP_HEADERS = {
  accept: "application/json",
  "user-agent": "PixivIOSApp/7.13.3",
  "app-os": "ios",
  "app-os-version": "15.5",
  "app-version": "7.13.3",
};
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// 每个 isolate / 每套凭据独立缓存；不把凭据放进 HTTP 缓存。
const tokens = new WeakMap();

export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await handle(request, env, ctx);
    } catch (err) {
      // 不记录原始上游响应、URL、凭据或异常对象。
      response = json({ error: err.publicMessage || "Upstream request failed" }, err.status || 502);
    }
    return cors(response, request, env);
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET, OPTIONS", "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/healthz") return json({ ok: true, service: "pixiv-api-mirror" });
  if (url.pathname === "/" || url.pathname === "/api") {
    return json({
      name: "Pixiv API Mirror", version: "1.0.0",
      endpoints: ["/api/illust/:id", "/api/illust/:id/comments", "/api/illust/:id/related", "/api/ugoira/:id", "/api/user/:id", "/api/user/:id/illusts", "/api/search/illust?word=...", "/api/search/user?word=...", "/api/ranking", "/api/recommended", "/api/proxy?url=..."],
    });
  }
  // CORS 不是身份认证；为共享的 Pixiv 账号配置独立入口密钥。
  if (env.API_KEY && request.headers.get("Authorization") !== `Bearer ${env.API_KEY}`) {
    throw problem(401, "Unauthorized");
  }
  if (env.RATE_LIMITER) {
    const result = await env.RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!result.success) return json({ error: "Rate limit exceeded" }, 429, { "Retry-After": "60" });
  }
  if (url.pathname === "/api/proxy" || url.pathname === "/image") {
    return proxyImage(url, env, ctx);
  }
  const route = matchRoute(url.pathname);
  if (!route) throw problem(404, "Not Found");
  const params = queryFor(route.name, url.searchParams);
  for (const [key, value] of Object.entries(route.fixed || {})) params.set(key, value);
  const upstream = new URL(route.path, API_BASE);
  upstream.search = params.toString();
  let token = await getToken(env);
  let result = await timedFetch(upstream, { headers: { ...APP_HEADERS, authorization: `Bearer ${token}` }, redirect: "manual" });
  if (result.status === 401) {
    await result.body?.cancel();
    const state = tokens.get(env);
    if (state?.token === token) state.expiresAt = 0;
    token = await getToken(env);
    result = await timedFetch(upstream, { headers: { ...APP_HEADERS, authorization: `Bearer ${token}` }, redirect: "manual" });
  }
  if (!result.ok) {
    await result.body?.cancel();
    throw upstreamProblem(result.status);
  }
  const data = await result.json();
  // 分页链接改为本镜像，绝不提供任意 app-api 转发入口。
  if (data.next_url) data.next_url = mirrorNextUrl(data.next_url, route, url);
  // 带账号上下文的 JSON 不写共享缓存（包括推荐和收藏状态）。
  return json(data);
}

function matchRoute(path) {
  const patterns = [
    [/^\/api\/illust\/([1-9]\d{0,19})$/, "illust", "/v1/illust/detail", "illust_id"],
    [/^\/api\/illust\/([1-9]\d{0,19})\/comments$/, "comments", "/v1/illust/comments", "illust_id"],
    [/^\/api\/illust\/([1-9]\d{0,19})\/related$/, "related", "/v2/illust/related", "illust_id"],
    [/^\/api\/ugoira\/([1-9]\d{0,19})$/, "ugoira", "/v1/ugoira/metadata", "illust_id"],
    [/^\/api\/user\/([1-9]\d{0,19})$/, "user", "/v1/user/detail", "user_id"],
    [/^\/api\/user\/([1-9]\d{0,19})\/illusts$/, "userIllusts", "/v1/user/illusts", "user_id"],
  ];
  for (const [pattern, name, upstream, idKey] of patterns) {
    const match = path.match(pattern);
    if (match) return { name, path: upstream, fixed: { [idKey]: match[1] } };
  }
  const routes = {
    "/api/search/illust": ["search", "/v1/search/illust"],
    "/api/search/user": ["searchUser", "/v1/search/user"],
    "/api/recommended": ["recommended", "/v1/illust/recommended"],
    "/api/ranking": ["ranking", "/v1/illust/ranking"],
  };
  const entry = routes[path];
  return entry ? { name: entry[0], path: entry[1] } : null;
}

function queryFor(name, input) {
  const allowed = {
    illust: ["filter"], comments: ["offset", "include_total_comments"],
    related: ["offset", "filter", "seed_illust_ids[]"], ugoira: [], user: ["filter"],
    userIllusts: ["type", "offset", "filter"],
    search: ["word", "search_target", "sort", "duration", "filter", "offset", "start_date", "end_date"],
    searchUser: ["word", "offset", "filter"],
    recommended: ["filter", "offset", "include_ranking_label", "min_bookmark_id_for_recent_illust", "max_bookmark_id_for_recommend"],
    ranking: ["mode", "date", "offset", "filter"],
  }[name];
  const output = new URLSearchParams();
  for (const key of allowed) {
    for (const value of input.getAll(key)) {
      if (value.length > 500) throw problem(400, `Parameter too long: ${key}`);
      if (value) output.append(key, value);
    }
  }
  if (output.has("offset") && !/^\d{1,7}$/.test(output.get("offset"))) throw problem(400, "Invalid offset");
  if (["search", "searchUser"].includes(name) && !output.get("word")?.trim()) throw problem(400, "Missing required query parameter: word");
  if (name === "search") {
    if (!output.has("search_target")) output.set("search_target", "partial_match_for_tags");
    if (!output.has("sort")) output.set("sort", "date_desc");
  }
  if (name === "userIllusts" && !output.has("type")) output.set("type", "illust");
  if (name === "ranking" && !output.has("mode")) output.set("mode", "day");
  if (allowed.includes("filter") && !output.has("filter")) output.set("filter", "for_ios");
  return output;
}

function mirrorNextUrl(next, route, local) {
  try {
    const upstream = new URL(next);
    if (upstream.origin !== API_BASE || upstream.pathname !== route.path) return null;
    const params = queryFor(route.name, upstream.searchParams);
    const mirror = new URL(local.pathname, local.origin);
    mirror.search = params.toString();
    return mirror.href;
  } catch { return null; }
}

async function getToken(env) {
  if (!env.PIXIV_REFRESH_TOKEN || !env.PIXIV_CLIENT_ID || !env.PIXIV_CLIENT_SECRET) {
    throw problem(503, "Pixiv credentials are not configured");
  }
  let state = tokens.get(env);
  if (!state) { state = {}; tokens.set(env, state); }
  if (state.token && state.expiresAt > Date.now() + 60_000) return state.token;
  if (!state.pending) {
    state.pending = refreshToken(env).then((data) => {
      state.token = data.access_token;
      state.expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
      return state.token;
    }).finally(() => { state.pending = null; });
  }
  return state.pending;
}

async function refreshToken(env) {
  const response = await timedFetch(OAUTH_URL, {
    method: "POST", redirect: "manual",
    headers: { ...APP_HEADERS, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.PIXIV_CLIENT_ID, client_secret: env.PIXIV_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: env.PIXIV_REFRESH_TOKEN,
      include_policy: "true",
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw problem(502, "Pixiv OAuth refresh failed");
  }
  const data = await response.json();
  if (typeof data.access_token !== "string" || !data.access_token) throw problem(502, "Invalid Pixiv OAuth response");
  return data;
}

async function proxyImage(url, env, ctx) {
  if (env.ENABLE_IMAGE_PROXY === "false") throw problem(403, "Image proxy disabled");
  let target;
  try { target = new URL(url.searchParams.get("url")); } catch { throw problem(400, "Invalid image URL"); }
  if (target.protocol !== "https:" || target.username || target.password || target.port ||
      !["i.pximg.net", "s.pximg.net"].includes(target.hostname)) {
    throw problem(403, "Only approved Pixiv image hosts are allowed");
  }
  // 禁止 URL 凭据和任意查询串；图片仅按 CDN 路径寻址。
  target.search = "";
  target.hash = "";
  // 带 API Key 的入口是私有服务：禁用共享图片缓存，避免缓存命中绕过入口鉴权。
  const configuredTtl = Math.max(0, Math.min(86400, Number(env.CACHE_TTL) || 0));
  const ttl = env.API_KEY ? 0 : configuredTtl;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(`/__image_cache_v1/${encodeURIComponent(target.href)}`, url.origin));
  if (cache && ttl > 0) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const response = await timedFetch(target, {
    redirect: "manual", headers: { referer: "https://www.pixiv.net/", "user-agent": APP_HEADERS["user-agent"] },
  });
  if (!response.ok) { await response.body?.cancel(); throw upstreamProblem(response.status); }
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) { await response.body?.cancel(); throw problem(502, "Upstream did not return a supported image"); }
  const contentLength = response.headers.get("content-length");
  const length = contentLength === null ? NaN : Number(contentLength);
  if (!Number.isFinite(length) || length < 0) {
    // 无效/缺失 Content-Length 时改为边读边计数，避免一次性把大图复制到内存。
  } else if (length > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw problem(413, "Image exceeds 25 MiB limit");
  }
  let streamedSize = 0;
  const body = response.body
    ? response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          streamedSize += chunk.byteLength;
          if (streamedSize > MAX_IMAGE_BYTES) {
            controller.error(new Error("image exceeds limit"));
            return;
          }
          controller.enqueue(chunk);
        },
      }))
    : null;
  const image = new Response(body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": ttl > 0 ? `public, max-age=${ttl}` : "no-store",
    },
  });
  if (cache && ttl > 0 && ctx?.waitUntil) ctx.waitUntil(cache.put(key, image.clone()).catch(() => {}));
  return image;
}

function timedFetch(url, init) {
  // 超时信号贯穿响应体消费；不自动重试以免放大上游负担。
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
function cors(response, request, env) {
  const headers = new Headers(response.headers);
  const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin");
  headers.delete("Access-Control-Allow-Origin");
  if (allowed.includes("*")) headers.set("Access-Control-Allow-Origin", "*");
  else {
    headers.append("Vary", "Origin");
    if (origin && origin !== "null" && allowed.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  }
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}
function problem(status, message) { return Object.assign(new Error(message), { status, publicMessage: message }); }
function upstreamProblem(status) {
  if (status === 404) return problem(404, "Not Found");
  if (status === 429) return problem(429, "Pixiv upstream rate limit reached");
  return problem(502, "Pixiv upstream request failed");
}
