const User = require("../models/user");
const { isUserVerified, isAccountVerificationEnforced } = require("../utils/verification.util");

module.exports = async (req, res, next) => {
  try {
    if (!isAccountVerificationEnforced()) {
      return next();
    }

    let user = req._authUserDoc;
    if (!user) {
      user = await User.findById(req.user.id).select(
        "isVerified email phone emailVerified phoneVerified"
      );
    }
    if (!user) {
      return res.status(404).json({ message: "المستخدم غير موجود" });
    }
    if (!isUserVerified(user)) {
      return res.status(403).json({
        message: "يجب توثيق الحساب أولاً لتتمكن من استخدام هذه الميزة",
        code: "VERIFICATION_REQUIRED",
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
