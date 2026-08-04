function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function parseUserAgent(ua = "") {
  const agent = String(ua);
  let device = "Desktop";
  if (/mobile|android|iphone|ipod/i.test(agent)) device = "Mobile";
  else if (/ipad|tablet/i.test(agent)) device = "Tablet";

  let browser = "Unknown";
  if (/edg\//i.test(agent)) browser = "Edge";
  else if (/chrome/i.test(agent) && !/edg/i.test(agent)) browser = "Chrome";
  else if (/safari/i.test(agent) && !/chrome/i.test(agent)) browser = "Safari";
  else if (/firefox/i.test(agent)) browser = "Firefox";
  else if (/opr\//i.test(agent) || /opera/i.test(agent)) browser = "Opera";

  let os = "Unknown";
  if (/windows nt/i.test(agent)) os = "Windows";
  else if (/mac os x/i.test(agent)) os = "macOS";
  else if (/android/i.test(agent)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(agent)) os = "iOS";
  else if (/linux/i.test(agent)) os = "Linux";

  return { device, browser, os };
}

function approximateLocation(ip) {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip === "::1" || ip === "::ffff:127.0.0.1") {
    return "محلي / غير متاح";
  }
  return "غير محدد";
}

module.exports = { getClientIp, parseUserAgent, approximateLocation };
