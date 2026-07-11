const path = require("path");
const express = require("express");
const Settings = require("../models/Settings");
const { SETTINGS_DEFAULTS } = require("../models/Settings");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const { maybeUploadLogo, removeLogoUpload } = require("../middleware/uploadLogo");

const router = express.Router();

async function getOrCreateSettings() {
  let doc = await Settings.findById("app").lean();
  if (!doc) {
    doc = (
      await Settings.create({
        _id: "app",
        business: { ...SETTINGS_DEFAULTS.business },
        receipt: { ...SETTINGS_DEFAULTS.receipt },
      })
    ).toObject();
  }
  return doc;
}

/** Multipart may send nested objects as JSON strings. */
function coerceObjectField(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function parseClearLogo(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "clearLogo")) {
    return false;
  }
  const raw = body.clearLogo;
  if (raw === true || raw === "true" || raw === "1" || raw === 1) {
    return true;
  }
  return false;
}

router.get("/", async (_req, res, next) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/",
  requireAuth,
  requireEntitlement("settings"),
  maybeUploadLogo,
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const updates = {};
      const clearLogo = parseClearLogo(body);

      const business = coerceObjectField(body.business);
      if (business) {
        updates.business = {};
        for (const key of ["name", "address", "phone", "email", "taxId"]) {
          if (Object.prototype.hasOwnProperty.call(business, key)) {
            updates.business[key] =
              typeof business[key] === "string"
                ? business[key].trim()
                : String(business[key] ?? "");
          }
        }
      }

      const receipt = coerceObjectField(body.receipt);
      if (receipt) {
        updates.receipt = {};
        for (const key of [
          "showLogo",
          "showAddress",
          "showPhone",
          "showEmail",
          "footerMessage",
        ]) {
          if (Object.prototype.hasOwnProperty.call(receipt, key)) {
            if (key === "footerMessage") {
              updates.receipt[key] =
                typeof receipt[key] === "string"
                  ? receipt[key].trim()
                  : String(receipt[key] ?? "");
            } else {
              const raw = receipt[key];
              if (raw === "true" || raw === "1") {
                updates.receipt[key] = true;
              } else if (raw === "false" || raw === "0") {
                updates.receipt[key] = false;
              } else {
                updates.receipt[key] = Boolean(raw);
              }
            }
          }
        }
      }

      const hasTextUpdates =
        (updates.business && Object.keys(updates.business).length > 0) ||
        (updates.receipt && Object.keys(updates.receipt).length > 0);

      if (!hasTextUpdates && !req.file && !clearLogo) {
        res.status(400).json({ message: "No updatable fields provided" });
        return;
      }

      const current = await getOrCreateSettings();
      const setDoc = {};

      if (updates.business) {
        for (const [k, v] of Object.entries(updates.business)) {
          setDoc[`business.${k}`] = v;
        }
      }
      if (updates.receipt) {
        for (const [k, v] of Object.entries(updates.receipt)) {
          setDoc[`receipt.${k}`] = v;
        }
      }

      if (req.file) {
        removeLogoUpload(current.business?.logoUrl);
        setDoc["business.logoUrl"] = path.posix.join(
          "/uploads",
          "logos",
          path.basename(req.file.filename)
        );
      } else if (clearLogo) {
        removeLogoUpload(current.business?.logoUrl);
        setDoc["business.logoUrl"] = null;
      }

      const settings = await Settings.findByIdAndUpdate(
        "app",
        { $set: setDoc },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();

      res.json(settings);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
