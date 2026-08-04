const JWT_VERIFY_OPTS = { algorithms: ["HS256"] };
const JWT_SIGN_OPTS = { algorithm: "HS256" };
const JWT_EXPIRES_DEFAULT = "7d";
const JWT_EXPIRES_ADMIN = "24h";
const JWT_REFRESH_EXPIRES_DEFAULT = "30d";
const JWT_REFRESH_EXPIRES_ADMIN = "7d";
const MAX_ACTIVE_SESSIONS = 10;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error("JWT_SECRET is not configured");
    err.status = 500;
    throw err;
  }
  return secret;
}

module.exports = {
  JWT_VERIFY_OPTS,
  JWT_SIGN_OPTS,
  JWT_EXPIRES_DEFAULT,
  JWT_EXPIRES_ADMIN,
  JWT_REFRESH_EXPIRES_DEFAULT,
  JWT_REFRESH_EXPIRES_ADMIN,
  MAX_ACTIVE_SESSIONS,
  getJwtSecret,
};
