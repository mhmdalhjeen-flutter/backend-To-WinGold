const twilio = require("twilio");

function isTwilioVerifyConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_VERIFY_SERVICE_SID
  );
}

let client = null;

function getTwilioClient() {
  if (!isTwilioVerifyConfigured()) {
    return null;
  }
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

function getVerifyServiceSid() {
  return process.env.TWILIO_VERIFY_SERVICE_SID || null;
}

module.exports = {
  isTwilioVerifyConfigured,
  getTwilioClient,
  getVerifyServiceSid,
};
