# Pivxe

面向 Cloudflare Workers 的只读 Pixiv API 适配器。它调用 Pixiv 非官方 App API，上游路径/协议可能变化，不承诺官方支持或长期兼容。部署者需自行确认 Pixiv 条款、版权、隐私和内容分发要求。

Worker 端保存 Pixiv refresh token；JSON API 一律 `no-store`。图片代理默认启用，但仅接受 `i.pximg.net` / `s.pximg.net` 的 HTTPS URL、拒绝重定向并将响应限制为 25 MiB 的常见图片类型。

## 端点

- `GET /healthz`：健康检查
- `GET /api/illust/:id`、`/api/illust/:id/comments`、`/api/illust/:id/related`
- `GET /api/ugoira/:id`：动图元数据
- `GET /api/user/:id`、`/api/user/:id/illusts`
- `GET /api/search/illust?word=...`、`/api/search/user?word=...`
- `GET /api/ranking?mode=day`、`/api/recommended`
- `GET /api/proxy?url=https%3A%2F%2Fi.pximg.net%2F...`：受限图片代理

查询参数按端点白名单转发；Pixiv 返回的分页 `next_url` 会转换为本镜像链接。

## 本地开发

需要 Node.js 18+：

```powershell
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars 设置 Pixiv 凭据
npm install
npm test
npm run dev
```

可在本地 `.dev.vars` 设置 `API_KEY`。若设置了该值，除 `/`、`/api` 和 `/healthz` 外的 API 均要求 `Authorization: Bearer <API_KEY>`。空值表示公开服务；CORS 不是访问控制。公开部署建议设置 API Key，或在 Cloudflare 前配置 Access / WAF / Rate Limiting。

## Cloudflare 部署

```bash
npm install
npx wrangler login
npx wrangler secret put PIXIV_REFRESH_TOKEN
npx wrangler secret put PIXIV_CLIENT_ID
npx wrangler secret put PIXIV_CLIENT_SECRET
npx wrangler secret put API_KEY
npm test
npm run check
npm run deploy
```

所有 Secrets 都在提示时输入，不写入 `wrangler.toml`、代码或 Git。若想公开 API，可不配置 `API_KEY`，但应配置 Cloudflare WAF/限流并评估滥用与费用风险。上线前把 `ALLOWED_ORIGINS` 改成允许的前端源，并将 `CACHE_TTL` 设为需要的图片缓存时长（秒；设 `0` 关闭图片缓存）。JSON 始终不缓存。可以设置 `ENABLE_IMAGE_PROXY="false"` 关闭图片代理。

可选在 `wrangler.toml` 配置 Workers 原生 `[[ratelimits]]` 绑定，并绑定名称 `RATE_LIMITER`。示例已注释，部署前需配置本账号有效的 namespace id。该限流按 Cloudflare 提供的客户端 IP 应用，不能代替 API Key 或更广泛的滥用防护。

## 凭据与安全

- 只使用自己有权使用的 Pixiv OAuth 凭据；本项目不提供凭据、不接收 Pixiv 密码，也不实现 OAuth 登录回调。
- Refresh token、client secret、API Key 在生产环境使用 Wrangler Secrets；勿写进客户端、URL、日志或 vars。
- `API_KEY` 是镜像入口密钥，与 Pixiv OAuth token 不同。浏览器前端若把它打包进去，它就不再是秘密，应将 API 放在受控后端或使用 Cloudflare Access。
- 图片代理目前固定返回 manual redirect 行为，拒绝任何上游跳转；只允许精确 CDN hostname，无客户端 Authorization/Cookie 转发，MIME 限制并限大小，且采用流式字节计数避免完整缓冲大图。配置 `API_KEY` 后图片响应为 `no-store`，防止下游共享缓存绕过入口鉴权。公开部署仍应加限流以控制带宽成本。
- 内存中的 OAuth access token 仅在 Worker isolate 内短期复用；并发刷新在单 isolate 内合并。不同 isolate 之间并无全局锁；若高并发下出现刷新风暴，需要 Durable Object 协调。
- Pixiv API 是非官方且易变的上游。上游账号/地区策略、客户端版本、接口字段调整都可能导致请求失败。

## 示例

```bash
curl https://YOUR_WORKER.workers.dev/api/illust/12345678
curl -H "Authorization: Bearer YOUR_API_KEY" "https://YOUR_WORKER.workers.dev/api/search/illust?word=初音未来"
```
