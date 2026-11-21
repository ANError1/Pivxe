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
const MAX_API_JSON_BYTES = 8 * 1024 * 1024;
const MAX_OAUTH_JSON_BYTES = 64 * 1024;
const ID_ROUTES = [
  [/^\/api\/illust\/([1-9]\d{0,19})$/, "illust", "/v1/illust/detail", "illust_id"],
  [/^\/api\/illust\/([1-9]\d{0,19})\/comments$/, "comments", "/v1/illust/comments", "illust_id"],
  [/^\/api\/illust\/([1-9]\d{0,19})\/related$/, "related", "/v2/illust/related", "illust_id"],
  [/^\/api\/ugoira\/([1-9]\d{0,19})$/, "ugoira", "/v1/ugoira/metadata", "illust_id"],
  [/^\/api\/user\/([1-9]\d{0,19})$/, "user", "/v1/user/detail", "user_id"],
  [/^\/api\/user\/([1-9]\d{0,19})\/illusts$/, "userIllusts", "/v1/user/illusts", "user_id"],
];
const STATIC_ROUTES = {
  "/api/search/illust": ["search", "/v1/search/illust"],
  "/api/search/user": ["searchUser", "/v1/search/user"],
  "/api/recommended": ["recommended", "/v1/illust/recommended"],
  "/api/ranking": ["ranking", "/v1/illust/ranking"],
};
const ALLOWED_QUERY_PARAMETERS = {
  illust: ["filter"], comments: ["offset", "include_total_comments"],
  related: ["offset", "filter", "seed_illust_ids[]"], ugoira: [], user: ["filter"],
  userIllusts: ["type", "offset", "filter"],
  search: ["word", "search_target", "sort", "duration", "filter", "offset", "start_date", "end_date"],
  searchUser: ["word", "offset", "filter"],
  recommended: ["filter", "offset", "include_ranking_label", "min_bookmark_id_for_recent_illust", "max_bookmark_id_for_recommend"],
  ranking: ["mode", "date", "offset", "filter"],
};
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
  // Shared Pixiv credentials must not become public because API_KEY was omitted.
  const hasApiKey = typeof env.API_KEY === "string" && env.API_KEY.length > 0;
  if (!hasApiKey && env.PUBLIC_API !== "true") {
    throw problem(503, "API key is not configured");
  }
  if (hasApiKey && !secureCompare(request.headers.get("Authorization"), `Bearer ${env.API_KEY}`)) {
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
  const data = await readJsonLimited(result, MAX_API_JSON_BYTES, "Pixiv API response is invalid or too large");
  // 分页链接改为本镜像，绝不提供任意 app-api 转发入口。
  if (data.next_url) data.next_url = mirrorNextUrl(data.next_url, route, url);
  // 带账号上下文的 JSON 不写共享缓存（包括推荐和收藏状态）。
  return json(data);
}

function matchRoute(path) {
  const entry = STATIC_ROUTES[path];
  if (entry) return { name: entry[0], path: entry[1] };
  for (const [pattern, name, upstream, idKey] of ID_ROUTES) {
    const match = path.match(pattern);
    if (match) return { name, path: upstream, fixed: { [idKey]: match[1] } };
  }
  return null;
}

function queryFor(name, input) {
  const allowed = ALLOWED_QUERY_PARAMETERS[name];
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
  const data = await readJsonLimited(response, MAX_OAUTH_JSON_BYTES, "Invalid Pixiv OAuth response");
  if (typeof data.access_token !== "string" || !data.access_token) throw problem(502, "Invalid Pixiv OAuth response");
  return data;
}

async function readJsonLimited(response, maxBytes, errorMessage) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw problem(502, errorMessage);
  }
  if (!response.body) throw problem(502, errorMessage);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw problem(502, errorMessage);
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err?.status) throw err;
    throw problem(502, errorMessage);
  }

  try {
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } catch {
    throw problem(502, errorMessage);
  }

}

async function proxyImage(url, env, ctx) {
  if (env.ENABLE_IMAGE_PROXY === "false") throw problem(403, "Image proxy disabled");
  let target;
  try { target = new URL(url.searchParams.get("url")); } catch { throw problem(400, "Invalid image URL"); }
  if (target.protocol !== "https:" || target.username || target.password || target.port ||
      !["i.pximg.net", "s.pximg.net"].includes(target.hostname)) {
    throw problem(403, "Only approved Pixiv image hosts are allowed");
  }
  // 防止 Unicode/IDN 域名绕过
  if (target.hostname.includes("xn--") || /[^\x00-\x7F]/.test(target.hostname)) {
    throw problem(403, "International domain names not allowed");
  }
  // 防止路径穿越和 URL 编码绕过（包括大小写变体和混合编码）
  const path = target.pathname.toLowerCase();
  const pathOriginal = target.pathname;
  if (path.includes("..") || 
      path.includes("%2e") || 
      path.includes("%252e") ||
      pathOriginal.includes("..") ||
      /\.\.|%2e|%252e/i.test(pathOriginal)) {
    throw problem(403, "Path traversal attempt detected");
  }
  // 禁止 URL 凭据和任意查询串；图片仅按 CDN 路径寻址。
  target.search = "";
  target.hash = "";
  // 带 API Key 的入口是私有服务：禁用共享图片缓存，避免缓存命中绕过入口鉴权。
  const configuredTtl = Math.max(0, Math.min(86400, Number(env.CACHE_TTL) || 0));
  const ttl = env.API_KEY ? 0 : configuredTtl;
  const cache = ttl > 0 && typeof caches !== "undefined" ? caches.default : null;
  const key = cache ? new Request(new URL(`/__image_cache_v1/${encodeURIComponent(target.href)}`, url.origin)) : null;
  if (cache) {
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
  } else if (length === 0) {
    await response.body?.cancel();
    throw problem(502, "Empty image response");
  }
  let streamedSize = 0;
  let lastChunkTime = Date.now();
  const CHUNK_TIMEOUT = 10_000; // 10秒无数据则超时
  const body = response.body
    ? response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          const now = Date.now();
          if (now - lastChunkTime > CHUNK_TIMEOUT) {
            controller.error(new Error("chunk timeout"));
            return;
          }
          lastChunkTime = now;
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
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, image.clone()).catch(() => {}));
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
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  return new Response(response.body, { status: response.status, headers });
}
function problem(status, message) { return Object.assign(new Error(message), { status, publicMessage: message }); }
function upstreamProblem(status) {
  if (status === 404) return problem(404, "Not Found");
  if (status === 429) return problem(429, "Pixiv upstream rate limit reached");
  return problem(502, "Pixiv upstream request failed");
}
function secureCompare(a, b) {
  // 恒定时间字符串比较，防止时序攻击
  if (typeof a !== "string" || typeof b !== "string") return false;
  // 使用固定长度比较，避免长度泄露
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = Math.max(aLen, bLen);
  let result = aLen ^ bLen;
  for (let i = 0; i < maxLen; i++) {
    const aChar = i < aLen ? a.charCodeAt(i) : 0;
    const bChar = i < bLen ? b.charCodeAt(i) : 0;
    result |= aChar ^ bChar;
  }
  return result === 0;
}
