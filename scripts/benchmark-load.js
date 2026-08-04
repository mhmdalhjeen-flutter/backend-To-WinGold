/**
 * Concurrent load benchmark for scaling validation.
 *
 * Usage:
 *   TOKEN=<jwt> node scripts/benchmark-load.js
 *   TOKEN=<jwt> CONCURRENCY=100 DURATION_SEC=30 node scripts/benchmark-load.js
 *   TOKEN=<jwt> BASE=http://localhost:5000 node scripts/benchmark-load.js
 */
const BASE = process.env.BASE || "http://localhost:5000";
const TOKEN = process.env.TOKEN;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 50;
const DURATION_SEC = Number(process.env.DURATION_SEC) || 20;
const RAMP_MS = Number(process.env.RAMP_MS) || 2000;

if (!TOKEN) {
  console.error("Set TOKEN env var (Bearer JWT for a test user).");
  process.exit(1);
}

const ENDPOINTS = [
  { name: "users/me", path: "/api/users/me", weight: 3 },
  { name: "notifications/unread", path: "/api/notifications/unread-count", weight: 2 },
  { name: "chats/unread", path: "/api/chats/unread-count", weight: 2 },
  { name: "notifications", path: "/api/notifications?limit=20", weight: 1 },
  { name: "cart", path: "/api/cart", weight: 1 },
];

function pickEndpoint() {
  const total = ENDPOINTS.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const ep of ENDPOINTS) {
    r -= ep.weight;
    if (r <= 0) return ep;
  }
  return ENDPOINTS[0];
}

async function timedGet(path) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await res.text();
    return { ms: performance.now() - start, status: res.status, ok: res.ok };
  } catch (err) {
    return { ms: performance.now() - start, status: 0, ok: false, error: err.message };
  }
}

function stats(samples) {
  if (!samples.length) return { n: 0, p50: "0", p95: "0", p99: "0", avg: "0", max: "0" };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(1) ?? "0";
  return {
    n: sorted.length,
    min: sorted[0]?.toFixed(1) ?? "0",
    avg: (sum / sorted.length).toFixed(1),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1]?.toFixed(1) ?? "0",
  };
}

async function workerLoop(state, workerId, endAt) {
  while (Date.now() < endAt && !state.stopped) {
    const ep = pickEndpoint();
    const result = await timedGet(ep.path);
    state.results.push(result);
    state.byEndpoint[ep.name] = state.byEndpoint[ep.name] || [];
    state.byEndpoint[ep.name].push(result.ms);
    if (!result.ok) state.errors++;
    if (workerId === 0 && state.results.length % 100 === 0) {
      process.stdout.write(`\r  requests: ${state.results.length}, errors: ${state.errors}`);
    }
  }
}

async function main() {
  console.log(`Load test: ${BASE}`);
  console.log(`Concurrency: ${CONCURRENCY}, Duration: ${DURATION_SEC}s, Ramp: ${RAMP_MS}ms\n`);

  const state = {
    results: [],
    byEndpoint: {},
    errors: 0,
    stopped: false,
  };

  const endAt = Date.now() + DURATION_SEC * 1000;
  const workers = [];

  for (let i = 0; i < CONCURRENCY; i++) {
    await new Promise((r) => setTimeout(r, RAMP_MS / CONCURRENCY));
    workers.push(workerLoop(state, i, endAt));
  }

  await Promise.all(workers);
  process.stdout.write("\n\n");

  const latencies = state.results.map((r) => r.ms);
  const overall = stats(latencies);
  const errorRate = state.results.length
    ? ((state.errors / state.results.length) * 100).toFixed(2)
    : "0";
  const rps = (state.results.length / DURATION_SEC).toFixed(1);

  console.log("=== Overall ===");
  console.log(`Total requests: ${state.results.length}`);
  console.log(`Throughput:     ${rps} req/s`);
  console.log(`Error rate:     ${errorRate}% (${state.errors} failures)`);
  console.log(`Latency p50:    ${overall.p50}ms`);
  console.log(`Latency p95:    ${overall.p95}ms`);
  console.log(`Latency p99:    ${overall.p99}ms`);
  console.log(`Latency max:    ${overall.max}ms`);

  console.log("\n=== By endpoint ===");
  for (const ep of ENDPOINTS) {
    const s = stats(state.byEndpoint[ep.name] || []);
    console.log(`${ep.name}: n=${s.n} p50=${s.p50}ms p95=${s.p95}ms avg=${s.avg}ms`);
  }

  console.log("\n=== Targets ===");
  console.log(`100 CCU p95 <300ms:  ${Number(overall.p95) < 300 ? "PASS" : "NEEDS TUNING"}`);
  console.log(`Error rate <2%:       ${Number(errorRate) < 2 ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
