const { isUserVerified } = require("./verification.util");

const USER_SENSITIVE_SELECT =
  "-password -passwordResetCode -passwordResetExpires -verifyEmailCode -verifyEmailLinkToken -verifyEmailExpires -verifyPhoneCode -verifyPhoneExpires -phoneVerifyCode -phoneVerifyExpires -sensitivePasswordHash -tokenVersion -refreshTokenVersion -sessions -googleId -facebookId -tiktokId -phonePending";

/** For auth middleware only — keep session/version fields needed for token validation */
const AUTH_USER_SELECT =
  "-password -passwordResetCode -passwordResetExpires -verifyEmailCode -verifyEmailLinkToken -verifyEmailExpires -verifyPhoneCode -verifyPhoneExpires -phoneVerifyCode -phoneVerifyExpires -sensitivePasswordHash -googleId -facebookId -tiktokId -phonePending";
const SENSITIVE_USER_FIELDS = [
  "password",
  "passwordResetCode",
  "passwordResetExpires",
  "verifyEmailCode",
  "verifyEmailLinkToken",
  "verifyEmailExpires",
  "verifyPhoneCode",
  "verifyPhoneExpires",
  "phoneVerifyCode",
  "phoneVerifyExpires",
  "sensitivePasswordHash",
  "tokenVersion",
  "refreshTokenVersion",
  "sessions",
  "googleId",
  "facebookId",
  "tiktokId",
  "phonePending",
];

function isUserBlocked(user) {
  if (!user) return false;
  return user.status === "banned" || user.status === "suspended";
}

function blockedAuthMessage(status) {
  if (status === "banned") return "تم حظر حسابك — تواصل مع الدعم";
  if (status === "suspended") return "تم تعليق حسابك مؤقتاً";
  return "الحساب غير متاح";
}

function assertUserNotBlocked(user) {
  if (!user || !isUserBlocked(user)) return;
  const err = new Error(blockedAuthMessage(user.status));
  err.status = 403;
  err.code = "ACCOUNT_BLOCKED";
  throw err;
}

function sanitizeUser(userDoc) {
  if (!userDoc) return null;
  const u = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  for (const field of SENSITIVE_USER_FIELDS) {
    delete u[field];
  }
  u.isVerified = isUserVerified(u);
  return u;
}

/** Strip internal role flags from chat participant objects */
function sanitizeChatParticipant(participant) {
  if (!participant || typeof participant !== "object") return participant;
  const p = participant.toObject ? participant.toObject() : { ...participant };
  delete p.role;
  delete p.password;
  delete p.tokenVersion;
  delete p.sessions;
  return p;
}

module.exports = {
  USER_SENSITIVE_SELECT,
  AUTH_USER_SELECT,
  SENSITIVE_USER_FIELDS,
  isUserBlocked,
  blockedAuthMessage,
  assertUserNotBlocked,
  sanitizeUser,
  sanitizeChatParticipant,
};
