const User = require("../models/user");
const twilioVerifyService = require("../services/twilioVerify.service");
const registrationOtp = require("../utils/registrationOtp.util");
const { assertAuthBody, cleanOtpCode } = require("../utils/authValidation.util");
const { cleanString } = require("../utils/inputSecurity.util");
const { resolveRegistrationPhone } = require("../utils/phone.util");

const sendOtp = async (req, res) => {
  try {
    assertAuthBody(req.body, "send-otp");
    const phone = cleanString(req.body.phone, { field: "phone", max: 20, required: true });

    const { localPhone } = resolveRegistrationPhone(phone);

    const existingUser = await User.findOne({ phone: localPhone });
    if (existingUser) {
      return res.status(400).json({
        message: "هذا الرقم مسجّل مسبقاً",
        code: "PHONE_ALREADY_REGISTERED",
      });
    }

    const result = await twilioVerifyService.sendRegistrationOtp(phone);

    return res.json({
      message: "تم إرسال رمز التحقق إلى هاتفك",
      phone: result.phone,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || "فشل إرسال رمز التحقق",
      code: error.code || "OTP_SEND_FAILED",
    });
  }
};

const verifyOtp = async (req, res) => {
  try {
    assertAuthBody(req.body, "verify-otp");
    const phone = cleanString(req.body.phone, { field: "phone", max: 20, required: true });
    const code = cleanOtpCode(req.body.code);

    const result = await twilioVerifyService.verifyRegistrationOtp(phone, code);
    await registrationOtp.markPhoneVerified(result.localPhone);

    return res.json({
      message: "تم التحقق من رقم الهاتف بنجاح",
      verified: true,
      phone: result.phone,
      expiresInSeconds: registrationOtp.REGISTRATION_OTP_TTL_SEC,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || "فشل التحقق من الرمز",
      code: error.code || "OTP_VERIFY_FAILED",
    });
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
};
