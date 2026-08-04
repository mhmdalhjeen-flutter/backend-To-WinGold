const SENSITIVE_KEY_RE = /(password|pass|token|secret|authorization|cookie|otp|code|credential|key|image|avatar|logo|cover|base64)/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

function redactString(value) {
  const str = String(value);
  if (str.startsWith("data:")) return "[redacted:data-url]";
  if (str.length > MAX_STRING) return `${str.slice(0, MAX_STRING)}...`;
  return str;
}

function sanitizeForLog(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === "function") return value.toHexString();
  if (value._bsontype === "ObjectId") return String(value);
  if (depth >= MAX_DEPTH) return "[redacted:depth]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeForLog(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : sanitizeForLog(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

function maskIdentifier(value) {
  if (!value) return value;
  const str = String(value);
  if (str.includes("@")) {
    const [name, domain] = str.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  if (str.length > 6) return `${str.slice(0, 3)}***${str.slice(-2)}`;
  return "***";
}

function safeLog(level, event, payload = {}) {
  const record = {
    at: new Date().toISOString(),
    event,
    ...sanitizeForLog(payload),
  };
  const line = JSON.stringify(record);
  if (level === "error") return console.error(line);
  if (level === "warn") return console.warn(line);
  return console.log(line);
}

module.exports = {
  maskIdentifier,
  safeLog,
  sanitizeForLog,
};
