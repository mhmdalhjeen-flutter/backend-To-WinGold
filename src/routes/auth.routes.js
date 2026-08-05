const express = require("express");
const router = express.Router();
const rateLimit = require("../middleware/rateLimit.middleware");
const authMiddleware = require("../middleware/auth.middleware");

const {
  registerCustomer,
  registerBusiness,
  login,
  logout,
  refresh,
  googleAuth,
  facebookAuth,
  tiktokAuth,
  requestVerification,
  confirmVerification,
  confirmEmailLink,
  getVerificationStatus,
  checkDeliveryPortalPhone,
  activateDeliveryPortal,
  verifyDriverRegistrationPassword,
  registerDeliveryDriver,
} = require("../controllers/auth.controller");

const {
  changePassword,
  forgotPasswordRequest,
  forgotPasswordReset,
} = require("../controllers/password.controller");

const { sendOtp, verifyOtp } = require("../controllers/otp.controller");

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "محاولات تسجيل دخول كثيرة — يرجى الانتظار قبل إعادة المحاولة",
});
const verifyRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: "محاولات إرسال كثيرة — يرجى الانتظار قبل إعادة الطلب",
  keyFn: (req) => `verify-req:${req.user?.id || req.ip}`,
});
const verifyConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "محاولات تحقق كثيرة — يرجى الانتظار",
  keyFn: (req) => `verify-confirm:${req.user?.id || req.ip}`,
});
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "محاولات تغيير كلمة المرور كثيرة — يرجى الانتظار",
  keyFn: (req) => `pwd-change:${req.user?.id || req.ip}`,
});
const emailLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "محاولات كثيرة — يرجى المحاولة لاحقاً",
});
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "محاولات إرسال OTP كثيرة — يرجى الانتظار",
  keyFn: (req) => {
    const phone = req.body?.phone ? String(req.body.phone).replace(/\D/g, "") : "";
    return `otp-send:${phone || req.ip}`;
  },
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "محاولات تحقق OTP كثيرة — يرجى الانتظار",
  keyFn: (req) => {
    const phone = req.body?.phone ? String(req.body.phone).replace(/\D/g, "") : "";
    return `otp-verify:${phone || req.ip}`;
  },
});

router.post("/send-otp", otpSendLimiter, sendOtp);
router.post("/verify-otp", otpVerifyLimiter, verifyOtp);

router.post("/register-customer", authLimiter, registerCustomer);
router.post("/register-business", authLimiter, registerBusiness);
router.post("/login", loginLimiter, login);
router.post("/delivery/check-phone", loginLimiter, checkDeliveryPortalPhone);
router.post("/delivery/activate", loginLimiter, activateDeliveryPortal);
router.post("/delivery/driver/verify-password", loginLimiter, verifyDriverRegistrationPassword);
router.post("/delivery/driver/register", loginLimiter, registerDeliveryDriver);
router.post("/logout", authMiddleware, logout);
router.post("/refresh", authLimiter, refresh);
router.post("/google", authLimiter, googleAuth);
router.post("/facebook", authLimiter, facebookAuth);
router.post("/tiktok", authLimiter, tiktokAuth);

router.get("/verify/status", authMiddleware, getVerificationStatus);
router.post("/verify/request", authMiddleware, verifyRequestLimiter, requestVerification);
router.post("/verify/confirm", authMiddleware, verifyConfirmLimiter, confirmVerification);
router.get("/verify/email-link", emailLinkLimiter, confirmEmailLink);

router.post("/password/change", authMiddleware, passwordChangeLimiter, changePassword);
router.post("/password/forgot", authLimiter, forgotPasswordRequest);
router.post("/password/reset", authLimiter, forgotPasswordReset);

module.exports = router;
