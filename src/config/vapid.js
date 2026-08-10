const webpush = require("web-push");
const { safeLog } = require("../utils/logSanitize.util");

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function resolveVapidSubject() {
  const subject = readEnv("VAPID_SUBJECT");
  if (subject) return subject;
  const customerUrl = readEnv("CUSTOMER_APP_URL");
  if (customerUrl) return customerUrl.replace(/\/$/, "");
  return "";
}

function isVapidConfigured() {
  return Boolean(readEnv("VAPID_PUBLIC_KEY") && readEnv("VAPID_PRIVATE_KEY") && resolveVapidSubject());
}

function configureVapid() {
  if (!isVapidConfigured()) return false;
  webpush.setVapidDetails(
    resolveVapidSubject(),
    readEnv("VAPID_PUBLIC_KEY"),
    readEnv("VAPID_PRIVATE_KEY")
  );
  return true;
}

function getVapidPublicKey() {
  return readEnv("VAPID_PUBLIC_KEY") || null;
}

function getVapidStatus() {
  const publicKey = readEnv("VAPID_PUBLIC_KEY");
  const privateKey = readEnv("VAPID_PRIVATE_KEY");
  const subject = resolveVapidSubject();
  return {
    configured: Boolean(publicKey && privateKey && subject),
    publicKeyPresent: Boolean(publicKey),
    privateKeyPresent: Boolean(privateKey),
    subjectPresent: Boolean(subject),
    subjectSource: readEnv("VAPID_SUBJECT")
      ? "VAPID_SUBJECT"
      : readEnv("CUSTOMER_APP_URL")
        ? "CUSTOMER_APP_URL"
        : "missing",
  };
}

function logVapidStartupStatus() {
  const status = getVapidStatus();
  if (status.configured) {
    safeLog("info", "vapid_configured", {
      subjectSource: status.subjectSource,
      publicKeyLength: readEnv("VAPID_PUBLIC_KEY").length,
    });
    return;
  }
  safeLog("warn", "vapid_not_configured", {
    publicKeyPresent: status.publicKeyPresent,
    privateKeyPresent: status.privateKeyPresent,
    subjectPresent: status.subjectPresent,
    hint: "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT (or CUSTOMER_APP_URL) to enable Web Push",
  });
}

module.exports = {
  isVapidConfigured,
  configureVapid,
  getVapidPublicKey,
  getVapidStatus,
  logVapidStartupStatus,
};
