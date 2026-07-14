const express = require("express");
const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("audit_log", "approvals"));

function formatLog(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of ["createdAt", "updatedAt"]) {
    if (o[key] instanceof Date) o[key] = o[key].toISOString();
  }
  return o;
}

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    const action = String(req.query.action || "").trim();
    if (action) filter.action = new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const entityType = String(req.query.entityType || "").trim();
    if (entityType) filter.entityType = entityType;

    if (req.query.entityId && mongoose.Types.ObjectId.isValid(req.query.entityId)) {
      filter.entityId = req.query.entityId;
    }
    if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
      filter.user = req.query.userId;
    }

    const q = String(req.query.q || req.query.search || "").trim();
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ summary: re }, { action: re }, { userName: re }];
    }

    const [rows, total] = await Promise.all([
      AuditLog.find(filter)
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatLog),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
