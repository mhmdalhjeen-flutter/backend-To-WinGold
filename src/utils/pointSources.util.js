function parsePointsFromText(text) {
  const m = String(text || "").match(/(\d+)\s*نقاط?/);
  return m ? Number(m[1]) : 0;
}

function extractPositivePoints(notification) {
  const { type, body, data } = notification;

  if (type === "order_point_gift") {
    return Number(data?.points) || parsePointsFromText(body) || 1;
  }

  if (type === "referral_batch") {
    return Number(data?.totalPoints) || parsePointsFromText(body);
  }

  const plusMatch = String(body || "").match(/\(\+(\d+)\s*نقطة/);
  if (plusMatch) return Number(plusMatch[1]);

  const addMatch = String(body || "").match(/تمت إضافة\s+(\d+)\s*نقاط?/);
  if (addMatch) return Number(addMatch[1]);

  const refundMatch = String(body || "").match(/استرداد\s+(\d+)\s*نقاط/);
  if (refundMatch) return Number(refundMatch[1]);

  return 0;
}

function labelForNotification(notification, points) {
  const { type, body, data } = notification;

  if (type === "order_point_gift") {
    const storeName = data?.storeName || String(body || "").replace(/.*من قبل\s*/, "").trim();
    return storeName ? `شراء من متجر ${storeName}` : "شراء من متجر";
  }

  if (type === "referral_batch") {
    return "دعوة أصدقائك";
  }

  if (type === "bazaar_listing_rejected" && /استرداد/.test(body || "")) {
    return "استرداد نقاط";
  }

  if (/استرداد\s+كود|كود|بطاقة/i.test(body || "") && points > 0) {
    return "بطاقة نقاط";
  }

  if (notification.title && /هدية|مكافأة/i.test(notification.title)) {
    return notification.title;
  }

  return notification.title || "مكافأة نقاط";
}

function mapNotificationToPointSource(notification) {
  if (!notification?._id) return null;

  const points = extractPositivePoints(notification);
  if (!points || points <= 0) return null;

  return {
    id: `notif-${notification._id}`,
    label: labelForNotification(notification, points),
    points,
    date: notification.createdAt,
  };
}

function mapWheelWinToPointSource(win) {
  if (!win?._id) return null;

  const prize = win.prize;
  let points = 0;

  if (prize?.prizeType === "points") {
    points = Number(prize.prizeValue) || parsePointsFromText(win.prizeName);
  } else {
    points = parsePointsFromText(win.prizeName);
    if (!points) return null;
    if (prize?.prizeType && prize.prizeType !== "points") return null;
  }

  if (!points || points <= 0) return null;

  return {
    id: `wheel-${win._id}`,
    label: "عجلة الحظ",
    points,
    date: win.wonAt || win.createdAt,
  };
}

function mergeRecentPointSources(notifications = [], wheelWins = [], limit = 5) {
  const items = [];

  for (const notification of notifications) {
    const mapped = mapNotificationToPointSource(notification);
    if (mapped) items.push(mapped);
  }

  for (const win of wheelWins) {
    const mapped = mapWheelWinToPointSource(win);
    if (mapped) items.push(mapped);
  }

  return items
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

module.exports = { mergeRecentPointSources };
