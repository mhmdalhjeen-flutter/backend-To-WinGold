/**
 * End-to-end verification for Google Sign-In referral integration.
 * Uses real MongoDB + real auth controller with mocked Google token verification only.
 * Does NOT modify production code.
 */
const path = require("path");
const dotenv = require("dotenv");
const express = require("express");
const mongoose = require("mongoose");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET missing — cannot run verification");
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error("MONGO_URI missing — cannot run verification");
  process.exit(1);
}

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "verify-test-client-id";

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "google-auth-library") {
    return {
      OAuth2Client: class MockOAuth2Client {
        verifyIdToken() {
          const payload = global.__GOOGLE_VERIFY_PAYLOAD__;
          if (!payload) {
            return Promise.reject(new Error("Mock payload not set"));
          }
          return Promise.resolve({
            getPayload: () => payload,
          });
        }
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const User = require("../src/models/user");
const authRoutes = require("../src/routes/auth.routes");
const platformSettings = require("../src/services/platformSettings.service");

function uniqueSuffix() {
  return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

async function connectDb() {
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
}

async function createTestReferrer() {
  const suffix = uniqueSuffix();
  const referralCode = `VT${suffix.slice(-6).toUpperCase()}`;
  const referrer = await User.create({
    name: `Referrer Verify ${suffix}`,
    email: `referrer-${suffix}@verify.test`,
    password: "unused",
    role: "customer",
    referralCode,
    points: 10,
    emailVerified: true,
    isVerified: true,
  });
  return { referrer, referralCode };
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  return app;
}

async function postGoogleAuth(app, body) {
  const server = app.listen(0);
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/auth/google`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-device-id": body.deviceId || `verify-device-${uniqueSuffix()}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  return { status: response.status, json, requestBody: body };
}

async function cleanup(referrerId, invitedEmail) {
  await User.deleteMany({
    $or: [{ _id: referrerId }, { email: invitedEmail }],
  });
}

async function main() {
  const report = {
    invitationLink: null,
    sessionStorageExpected: null,
    requestBodyFirstSignup: null,
    requestBodySecondLogin: null,
    invitedUser: null,
    referrerPointsBefore: null,
    referrerPointsAfterFirstSignup: null,
    referrerPointsAfterSecondLogin: null,
    referralRewardGranted: null,
    rewardExecutedOnce: null,
    errors: [],
  };

  let referrer;
  let invitedEmail;
  let googleSub;

  try {
    await connectDb();

    const created = await createTestReferrer();
    referrer = created.referrer;
    const { referralCode } = created;

    report.invitationLink = `http://localhost:5173/intro?ref=${encodeURIComponent(referralCode)}`;
    report.sessionStorageExpected = { referralCode };
    report.referrerPointsBefore = referrer.points;

    const expectedReward = await platformSettings.getReferralRewardPoints();
    report.expectedReferrerReward = expectedReward;

    googleSub = `google-verify-${uniqueSuffix()}`;
    invitedEmail = `google-new-${uniqueSuffix()}@verify.test`;

    global.__GOOGLE_VERIFY_PAYLOAD__ = {
      sub: googleSub,
      email: invitedEmail,
      email_verified: true,
      name: "Verify Google New User",
      picture: "https://example.com/avatar.png",
    };

    const app = createTestApp();
    const deviceId = `verify-device-${uniqueSuffix()}`;

    const firstBody = {
      credential: "mock-google-credential-first",
      referralCode,
      deviceId,
    };

    const first = await postGoogleAuth(app, firstBody);
    report.requestBodyFirstSignup = first.requestBody;
    report.firstSignupStatus = first.status;

    if (first.status !== 200) {
      report.errors.push(`First signup failed: ${first.status} ${JSON.stringify(first.json)}`);
    }

    const invited = await User.findOne({ email: invitedEmail }).select(
      "referredBy referralRewardGranted referralCompletedAt points email googleId"
    );
    const referrerAfterFirst = await User.findById(referrer._id).select("points");

    report.invitedUser = invited
      ? {
          referredBy: invited.referredBy ? String(invited.referredBy) : null,
          referralRewardGranted: invited.referralRewardGranted,
          referralCompletedAt: invited.referralCompletedAt,
          points: invited.points,
          email: invited.email,
          googleId: invited.googleId,
        }
      : null;

    report.referrerPointsAfterFirstSignup = referrerAfterFirst?.points ?? null;
    report.referralRewardGranted = invited?.referralRewardGranted ?? null;

    const pointsDeltaFirst =
      report.referrerPointsAfterFirstSignup != null && report.referrerPointsBefore != null
        ? report.referrerPointsAfterFirstSignup - report.referrerPointsBefore
        : null;

    report.referrerPointsDeltaFirstSignup = pointsDeltaFirst;
    report.rewardExecutedOnce =
      pointsDeltaFirst === expectedReward &&
      invited?.referralRewardGranted === true &&
      String(invited?.referredBy || "") === String(referrer._id);

    // Second login — same Google account, referral code still sent (stale session simulation)
    const secondBody = {
      credential: "mock-google-credential-second",
      referralCode,
      deviceId,
    };

    const second = await postGoogleAuth(app, secondBody);
    report.requestBodySecondLogin = second.requestBody;
    report.secondLoginStatus = second.status;

    const referrerAfterSecond = await User.findById(referrer._id).select("points");
    report.referrerPointsAfterSecondLogin = referrerAfterSecond?.points ?? null;
    report.referrerPointsDeltaSecondLogin =
      report.referrerPointsAfterSecondLogin != null && report.referrerPointsAfterFirstSignup != null
        ? report.referrerPointsAfterSecondLogin - report.referrerPointsAfterFirstSignup
        : null;

    report.noDuplicateRewardOnSecondLogin = report.referrerPointsDeltaSecondLogin === 0;

    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    report.errors.push(err.message);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    if (referrer?._id && invitedEmail) {
      await cleanup(referrer._id, invitedEmail).catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
  }
}

main();
