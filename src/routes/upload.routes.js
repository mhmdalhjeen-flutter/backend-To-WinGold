const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const { uploadSingle } = require("../middleware/upload.middleware");
const { isCloudinaryConfigured } = require("../config/cloudinary");

const router = express.Router();

/** Roles that upload images through the shared Cloudinary endpoint. */
const UPLOAD_ALLOWED_ROLES = [
  "customer",
  "store",
  "supplier",
  "admin",
  "delivery_company",
  "delivery_driver",
];

router.use(authMiddleware);
router.use(roleMiddleware(UPLOAD_ALLOWED_ROLES));

router.post("/image", (req, res) => {
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({ message: "خدمة رفع الصور غير مهيأة" });
  }

  uploadSingle(req, res, (err) => {
    if (err) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ message: err.message || "فشل رفع الصورة" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "لم تُرفع صورة" });
    }

    return res.json({
      url: req.file.path,
      public_id: req.file.filename,
    });
  });
});

module.exports = router;
