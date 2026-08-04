const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "offers-app",
    allowed_formats: ALLOWED_FORMATS,
  },
});

const fileFilter = (req, file, cb) => {
  const ext = file.originalname.split(".").pop()?.toLowerCase();
  if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_FORMATS.includes(ext)) {
    cb(null, true);
    return;
  }
  cb(new Error("نوع الملف غير مسموح — jpg, png, jpeg, webp فقط"));
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

module.exports = {
  uploadSingle: upload.single("image"),
};
