const express = require("express");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const {
  sendSms,
  isConfigured,
  getSenderId,
  normalizePhone,
} = require("../utils/sms");
const { writeAuditLog } = require("../utils/auditLog");

const router = express.Router();

router.use(requireAuth);
router.use(requireEntitlement("sms"));

router.get("/meta", (_req, res) => {
  res.json({
    configured: isConfigured(),
    senderId: getSenderId(),
    provider: "arkesel",
  });
});

/**
 * POST /api/sms/send
 * Body: { message: string, recipients: string | string[] }
 * Optional: { sender?: string } — defaults to SMS_SENDER_ID (Onyx)
 */
router.post("/send", async (req, res, next) => {
  try {
    const message =
      typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ message: "message is required" });
      return;
    }

    let recipients = req.body?.recipients;
    if (typeof recipients === "string") {
      recipients = recipients
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ message: "recipients is required" });
      return;
    }

    const sender =
      typeof req.body?.sender === "string" && req.body.sender.trim()
        ? req.body.sender.trim()
        : undefined;

    const preview = recipients.map((r) => ({
      raw: String(r),
      normalized: normalizePhone(r),
    }));
    if (preview.every((p) => !p.normalized)) {
      res.status(400).json({
        message: "no valid phone numbers",
        recipients: preview,
      });
      return;
    }

    const result = await sendSms({ recipients, message, sender });

    if (!result.sent) {
      const status = result.reason === "not_configured" ? 503 : 502;
      res.status(status).json({
        message: result.reason || "Failed to send SMS",
        ...result,
      });
      return;
    }

    await writeAuditLog({
      action: "sms.send",
      entityType: "sms",
      summary: `Sent SMS to ${result.recipients.length} recipient(s)`,
      metadata: {
        sender: result.sender,
        recipients: result.recipients,
        messagePreview: message.slice(0, 120),
      },
      user: req.user,
    });

    res.status(200).json({
      message: "SMS sent",
      sender: result.sender,
      recipients: result.recipients,
      invalid: result.invalid,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
