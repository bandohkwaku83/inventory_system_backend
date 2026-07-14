const AuditLog = require("../models/AuditLog");

/**
 * Best-effort audit write — never throws to callers.
 */
async function writeAuditLog({
  action,
  entityType = "",
  entityId = null,
  summary = "",
  metadata = {},
  user = null,
}) {
  try {
    const userName =
      (user && (user.name || user.email)) ||
      (typeof user === "object" && user?.name) ||
      "";
    const userId =
      user && (user._id || user.id)
        ? user._id || user.id
        : typeof user === "string"
          ? user
          : null;

    await AuditLog.create({
      action,
      entityType,
      entityId,
      summary,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      user: userId,
      userName: String(userName || ""),
    });
  } catch (err) {
    console.error("[auditLog]", err.message || err);
  }
}

module.exports = { writeAuditLog };
