import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { ALLOWED_ORIGINS: "*" };

let response = await worker.fetch(new Request("https://example.com/healthz"), env, {});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { ok: true, service: "pixiv-api-mirror" });

response = await worker.fetch(new Request("https://example.com/api/search/illust"), env, {});
assert.equal(response.status, 400);
assert.match(await response.text(), /word/);

response = await worker.fetch(new Request("https://example.com/api/proxy?url=https%3A%2F%2Fevil.example%2Fimage.jpg"), env, {});
assert.equal(response.status, 403);

response = await worker.fetch(new Request("https://example.com/not-found"), env, {});
assert.equal(response.status, 404);

console.log("smoke tests passed");
