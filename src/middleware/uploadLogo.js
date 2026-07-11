const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const UPLOAD_REL = ["..", "..", "uploads", "logos"];
const uploadsDir = path.join(__dirname, ...UPLOAD_REL);

function ensureUploadsDir() {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadsDir();
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(0, 20) || "";
    const base = crypto.randomBytes(16).toString("hex");
    cb(null, `${base}${ext}`);
  },
});

function imageFileFilter(_req, file, cb) {
  const allowed = /^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype || "");
  if (!allowed) {
    const e = new Error("Invalid image type");
    e.code = "INVALID_IMAGE_TYPE";
    cb(e);
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: imageFileFilter,
});

/** Optional single file field `logo` */
const uploadLogo = upload.single("logo");

function handleMulterError(err, req, res, next) {
  if (!err) {
    next();
    return;
  }
  if (err.code === "INVALID_IMAGE_TYPE") {
    res.status(400).json({ error: "Logo must be JPEG, PNG, GIF, or WebP" });
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "Logo must be 2MB or smaller" });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

/** Parses multipart body fields; skips multer when body is JSON (PATCH with application/json). */
function maybeUploadLogo(req, res, next) {
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("multipart/form-data")) {
    next();
    return;
  }
  uploadLogo(req, res, (err) => handleMulterError(err, req, res, next));
}

/** Remove disk file given `logoUrl` like `/uploads/logos/<filename>`. Silent if missing / outside dir. */
function removeLogoUpload(logoUrl) {
  if (!logoUrl || typeof logoUrl !== "string") {
    return;
  }
  const rel = /^\/uploads\/logos\/([^/]+)$/.exec(logoUrl);
  if (!rel) {
    return;
  }
  const basename = path.basename(rel[1]);
  const abs = path.join(uploadsDir, basename);
  if (!abs.startsWith(uploadsDir)) {
    return;
  }
  try {
    fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}

module.exports = {
  uploadLogo,
  maybeUploadLogo,
  handleMulterError,
  MAX_BYTES,
  uploadsDir,
  removeLogoUpload,
};
