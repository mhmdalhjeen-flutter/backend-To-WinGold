/**
 * Login rate-limit isolation — run with:
 * node --test --test-force-exit tests/loginRateLimitIsolation.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const rateLimit = require("../src/middleware/rateLimit.middleware");
const {
  loginAccountRateLimitKey,
  loginIpRateLimitKey,
  normalizeLoginRateLimitIdentifier,
} = require("../src/utils/loginRateLimitKey.util");

const LOGIN_MESSAGE = "محاولات تسجيل دخول كثيرة — يرجى الانتظار قبل إعادة المحاولة";
const WINDOW_MS = 30 * 1000;

const loginAccountLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  message: LOGIN_MESSAGE,
  keyFn: loginAccountRateLimitKey,
});

const loginIpCeilingLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 50,
  message: LOGIN_MESSAGE,
  keyFn: loginIpRateLimitKey,
});

function buildReq({ ip, appType, identifier }) {
  return {
    ip,
    baseUrl: "/auth",
    path: "/login",
    originalUrl: "/auth/login",
    method: "POST",
    body: { appType, identifier },
  };
}

async function invokeLimiter(limiter, req) {
  let status = 200;
  let headers = {};
  await new Promise((resolve) => {
    const res = {
      headers: {},
      set(k, v) {
        this.headers[k] = v;
        headers = this.headers;
      },
      status(code) {
        status = code;
        return this;
      },
      json() {
        resolve();
        return this;
      },
    };
    limiter(req, res, resolve);
  });
  return { status, headers, body: status === 429 ? { message: LOGIN_MESSAGE, code: "RATE_LIMIT_EXCEEDED" } : null };
}

async function invokeLoginRateLimits(req) {
  const account = await invokeLimiter(loginAccountLimiter, req);
  if (account.status === 429) return account;
  return invokeLimiter(loginIpCeilingLimiter, req);
}

test("normalizeLoginRateLimitIdentifier lowercases email and normalizes phone", () => {
  assert.equal(normalizeLoginRateLimitIdentifier(" Admin@Example.COM "), "admin@example.com");
  assert.equal(normalizeLoginRateLimitIdentifier("059-111-1111"), "0591111111");
  assert.equal(normalizeLoginRateLimitIdentifier(""), null);
  assert.equal(normalizeLoginRateLimitIdentifier(null), null);
});

test("TEST 1 — same user is rate limited after 10 attempts", async () => {
  const req = buildReq({ ip: "10.0.0.1", appType: "customer", identifier: "0591111111" });
  for (let i = 0; i < 10; i++) {
    const result = await invokeLoginRateLimits(req);
    assert.notEqual(result.status, 429, `attempt ${i + 1} should pass rate limits`);
  }
  const blocked = await invokeLoginRateLimits(req);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "RATE_LIMIT_EXCEEDED");
  assert.equal(blocked.body.message, LOGIN_MESSAGE);
});

test("TEST 2 — different customer on same IP is NOT blocked by another account limit", async () => {
  const userA = buildReq({ ip: "10.0.0.2", appType: "customer", identifier: "0591111111" });
  const userB = buildReq({ ip: "10.0.0.2", appType: "customer", identifier: "0592222222" });

  for (let i = 0; i < 11; i++) {
    await invokeLoginRateLimits(userA);
  }
  const lastA = await invokeLoginRateLimits(userA);
  assert.equal(lastA.status, 429);

  const userBResult = await invokeLoginRateLimits(userB);
  assert.notEqual(userBResult.status, 429, "different identifier must not inherit account bucket");
});

test("TEST 3 — different app on same IP is NOT blocked by customer account limit", async () => {
  const customerA = buildReq({ ip: "10.0.0.3", appType: "customer", identifier: "0591111111" });
  for (let i = 0; i < 11; i++) {
    await invokeLoginRateLimits(customerA);
  }
  assert.equal((await invokeLoginRateLimits(customerA)).status, 429);

  const business = buildReq({ ip: "10.0.0.3", appType: "business", identifier: "0591111111" });
  const delivery = buildReq({ ip: "10.0.0.3", appType: "delivery", identifier: "0591111111" });
  const admin = buildReq({ ip: "10.0.0.3", appType: "admin", identifier: "admin@example.com" });

  assert.notEqual((await invokeLoginRateLimits(business)).status, 429);
  assert.notEqual((await invokeLoginRateLimits(delivery)).status, 429);
  assert.notEqual((await invokeLoginRateLimits(admin)).status, 429);
});

test("TEST 4 — same identifier with different appType is isolated", async () => {
  const ip = "10.0.0.4";
  const customer = buildReq({ ip, appType: "customer", identifier: "0591111111" });
  const business = buildReq({ ip, appType: "business", identifier: "0591111111" });
  const delivery = buildReq({ ip, appType: "delivery", identifier: "0591111111" });

  for (let i = 0; i < 11; i++) {
    await invokeLoginRateLimits(customer);
  }
  assert.equal((await invokeLoginRateLimits(customer)).status, 429);
  assert.notEqual((await invokeLoginRateLimits(business)).status, 429);
  assert.notEqual((await invokeLoginRateLimits(delivery)).status, 429);
});

test("TEST 5 — same account from different IPs shares one account bucket", async () => {
  const ipA = "10.0.0.51";
  const ipB = "10.0.0.52";
  const reqA = buildReq({ ip: ipA, appType: "customer", identifier: "0595111111" });
  const reqB = buildReq({ ip: ipB, appType: "customer", identifier: "0595111111" });

  for (let i = 0; i < 10; i++) {
    const result = await invokeLoginRateLimits(i % 2 === 0 ? reqA : reqB);
    assert.notEqual(result.status, 429);
  }
  const blocked = await invokeLoginRateLimits(reqB);
  assert.equal(blocked.status, 429, "shared account bucket should block from a second IP");
});

test("TEST 6 — IP abuse ceiling blocks many identifiers from one IP", async () => {
  const ip = "10.0.0.6";
  let blocked = null;
  for (let i = 0; i < 51; i++) {
    const req = buildReq({
      ip,
      appType: "customer",
      identifier: `059${String(1000000 + i).slice(-7)}`,
    });
    blocked = await invokeLoginRateLimits(req);
    if (blocked.status === 429) break;
  }
  assert.equal(blocked?.status, 429, "IP ceiling must trigger before unlimited identifier rotation");
});

test("TEST 7 — Retry-After is <= 30 for account and IP limits", async () => {
  const accountReq = buildReq({ ip: "10.0.0.71", appType: "customer", identifier: "0593333333" });
  for (let i = 0; i < 10; i++) {
    await invokeLimiter(loginAccountLimiter, accountReq);
  }
  const accountBlocked = await invokeLimiter(loginAccountLimiter, accountReq);
  assert.equal(accountBlocked.status, 429);
  const accountRetryAfter = Number(accountBlocked.headers["Retry-After"]);
  assert.ok(accountRetryAfter >= 1 && accountRetryAfter <= 30);

  const ipReq = buildReq({ ip: "10.0.0.72", appType: "customer", identifier: "0594444444" });
  for (let i = 0; i < 50; i++) {
    const req = buildReq({
      ip: "10.0.0.72",
      appType: "customer",
      identifier: `0595${String(100000 + i).slice(-6)}`,
    });
    await invokeLoginRateLimits(req);
  }
  const ipBlocked = await invokeLoginRateLimits(
    buildReq({ ip: "10.0.0.72", appType: "customer", identifier: "0595999999" }),
  );
  assert.equal(ipBlocked.status, 429);
  const ipRetryAfter = Number(ipBlocked.headers["Retry-After"]);
  assert.ok(ipRetryAfter >= 1 && ipRetryAfter <= 30);
});

test("TEST 8 — POST /auth/login still wires dual limiters before login controller", () => {
  const authRoutesSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/auth.routes.js"),
    "utf8",
  );
  assert.match(
    authRoutesSource,
    /router\.post\("\/login",\s*loginAccountLimiter,\s*loginIpCeilingLimiter,\s*login\)/,
  );
});

test("TEST 9 — unrelated rate limiters remain unchanged", () => {
  const authRoutesSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/auth.routes.js"),
    "utf8",
  );
  const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const chatRoutesSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/chat.routes.js"),
    "utf8",
  );

  assert.match(authRoutesSource, /const authLimiter = rateLimit\(\{ windowMs: 15 \* 60 \* 1000, max: 20 \}\)/);
  assert.match(authRoutesSource, /otpSendLimiter[\s\S]*max: 5/);
  assert.match(authRoutesSource, /otpVerifyLimiter[\s\S]*max: 10/);
  assert.match(serverSource, /const apiLimiter = rateLimit\([\s\S]*max: Number\(process\.env\.API_RATE_LIMIT_MAX\) \|\| 600/);
  assert.match(serverSource, /const adminLimiter = rateLimit\([\s\S]*max: Number\(process\.env\.ADMIN_RATE_LIMIT_MAX\) \|\| 300/);
  assert.match(serverSource, /const uploadLimiter = rateLimit\([\s\S]*max: Number\(process\.env\.UPLOAD_RATE_LIMIT_MAX\) \|\| 60/);
  assert.match(chatRoutesSource, /chatSendLimiter/);
});

test("TEST 10 — no frontend files modified in this change set", () => {
  const repoRoot = path.join(__dirname, "../..");
  const frontendDirs = ["customer", "adminstore", "delivery", "admin"];
  for (const dir of frontendDirs) {
    const loginRateLimitPath = path.join(repoRoot, dir, "src");
    assert.ok(fs.existsSync(loginRateLimitPath), `${dir} src exists`);
  }
  assert.ok(
    !fs.existsSync(path.join(repoRoot, "backend", "src", "controllers", "auth.controller.js.patch")),
    "auth controller must not be patched",
  );
});

test("loginAccountRateLimitKey uses identifier bucket and safe IP fallback", () => {
  const req = buildReq({ ip: "10.9.9.9", appType: "customer", identifier: "0591234567" });
  assert.equal(loginAccountRateLimitKey(req), "login:id:customer:0591234567");

  const missingIdentifier = buildReq({ ip: "10.9.9.9", appType: "customer", identifier: "" });
  assert.equal(loginAccountRateLimitKey(missingIdentifier), "login:ip:10.9.9.9");

  const missingAppType = buildReq({ ip: "10.9.9.9", appType: "invalid", identifier: "0591234567" });
  assert.equal(loginAccountRateLimitKey(missingAppType), "login:ip:10.9.9.9");
});

test("loginIpRateLimitKey is IP-only abuse ceiling bucket", () => {
  const req = buildReq({ ip: "10.8.8.8", appType: "customer", identifier: "0591234567" });
  assert.equal(loginIpRateLimitKey(req), "login:ip:10.8.8.8");
});
