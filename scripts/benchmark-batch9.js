/**
 * Batch 9 — latency benchmark for cached polling endpoints.
 *
 * Usage:
 *   TOKEN=<jwt> node scripts/benchmark-batch9.js
 *   TOKEN=<jwt> BASE=http://localhost:5000 node scripts/benchmark-batch9.js
 *
 * Measures cold (1st) vs warm (cached) latency over repeated GETs.
 */
const BASE = process.env.BASE || "http://localhost:5000";
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error("Set TOKEN env var (Bearer JWT for a test user).");
  process.exit(1);
}

const ENDPOINTS = [
  { name: "users/me", path: "/api/users/me" },
  { name: "notifications", path: "/api/notifications?limit=20" },
  { name: "notifications/unread-count", path: "/api/notifications/unread-count" },
  { name: "chats/unread-count", path: "/api/chats/unread-count" },
  { name: "cart", path: "/api/cart" },
];

async function timedGet(path) {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.text();
  const ms = performance.now() - start;
  return { ms, status: res.status, ok: res.ok, bytes: body.length };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  return {
    n: sorted.length,
    min: sorted[0]?.toFixed(1) ?? "0",
    avg: (sum / sorted.length).toFixed(1),
    p50: p50.toFixed(1),
    p95: p95.toFixed(1),
    max: sorted[sorted.length - 1]?.toFixed(1) ?? "0",
  };
}

async function benchEndpoint({ name, path }) {
  cacheBust(`${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`);
  const cold = await timedGet(path);

  const warmSamples = [];
  for (let i = 0; i < 20; i++) {
    warmSamples.push((await timedGet(path)).ms);
  }

  const burstSamples = [];
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      burstSamples.push((await timedGet(path)).ms);
    })
  );

  return {
    name,
    path,
    coldMs: cold.ms.toFixed(1),
    warm: stats(warmSamples),
    burst: stats(burstSamples),
    status: cold.status,
  };
}

function cacheBust() {
  /* no-op — first request after server start is cold; repeats hit cache */
}

async function main() {
  console.log(`Benchmark base: ${BASE}\n`);
  const rows = [];
  for (const ep of ENDPOINTS) {
    rows.push(await benchEndpoint(ep));
  }

  console.log("| Endpoint | Cold (ms) | Warm avg | Warm p50 | Warm p95 | Burst avg | Burst p95 |");
  console.log("|----------|-----------|----------|----------|----------|-----------|-----------|");
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${r.coldMs} | ${r.warm.avg} | ${r.warm.p50} | ${r.warm.p95} | ${r.burst.avg} | ${r.burst.p95} |`
    );
  }

  try {
    const statsRes = await fetch(`${BASE}/api/health`).catch(() => null);
    if (statsRes?.ok) console.log("\nServer health: OK");
  } catch {
    /* optional */
  }

  console.log("\nCache stats (in-process): import getStats from responseCache.util on running server.");
  console.log("Expected warm/burst: <50ms in-memory; cold depends on DB load.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
