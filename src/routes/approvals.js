const express = require("express");
const mongoose = require("mongoose");
const Approval = require("../models/Approval");
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require("../models/Approval");
const StockTransfer = require("../models/StockTransfer");
const GoodsReceipt = require("../models/GoodsReceipt");
const GoodsIssue = require("../models/GoodsIssue");
const StockCount = require("../models/StockCount");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const {
  nextApprovalNumber,
  approveTransfer,
  rejectTransfer,
  formatTransfer,
} = require("../utils/transfers");
const {
  approveReceipt,
  rejectReceipt,
  formatReceipt,
} = require("../utils/goodsReceipts");
const {
  approveIssue,
  rejectIssue,
  formatIssue,
} = require("../utils/goodsIssues");
const {
  approveCount,
  rejectCount,
  formatCount,
} = require("../utils/stockCounts");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("approvals"));

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

function str(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return String(v).trim();
  return v.trim();
}

function formatApproval(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of ["reviewedAt", "createdAt", "updatedAt"]) {
    if (o[key] instanceof Date) o[key] = o[key].toISOString();
  }
  return o;
}

async function populateApproval(id) {
  return Approval.findById(id)
    .populate("requestedBy", "name email")
    .populate("reviewedBy", "name email")
    .lean();
}

router.get("/meta", (_req, res) => {
  res.json({
    types: APPROVAL_TYPES,
    statuses: APPROVAL_STATUSES,
  });
});

router.get("/summary", async (_req, res, next) => {
  try {
    const rows = await Approval.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(APPROVAL_STATUSES.map((s) => [s, 0]));
    for (const r of rows) {
      if (r._id in byStatus) byStatus[r._id] = r.count;
    }
    res.json({
      pending: byStatus.pending,
      approved: byStatus.approved,
      rejected: byStatus.rejected,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
    });
  } catch (err) {
    next(err);
  }
});

/** Create a manual approval request (purchase, expense, discount, credit, etc.) */
router.post("/", async (req, res, next) => {
  try {
    const type = (str(req.body, "type") ?? "").toLowerCase();
    if (!APPROVAL_TYPES.includes(type)) {
      res.status(400).json({
        message: `type must be one of: ${APPROVAL_TYPES.join(", ")}`,
        error: `type must be one of: ${APPROVAL_TYPES.join(", ")}`,
      });
      return;
    }

    const title = str(req.body, "title") ?? "";
    if (!title) {
      res.status(400).json({ message: "title is required", error: "title is required" });
      return;
    }

    if (type === "warehouse_transfer") {
      res.status(400).json({
        message:
          "Warehouse transfer approvals are created by submitting a transfer (POST /api/warehouse-transfers/:id/submit)",
        error:
          "Warehouse transfer approvals are created by submitting a transfer (POST /api/warehouse-transfers/:id/submit)",
      });
      return;
    }
    if (type === "goods_receipt") {
      res.status(400).json({
        message:
          "Goods receipt approvals are created by submitting a receipt (POST /api/goods-receipts/:id/submit)",
        error:
          "Goods receipt approvals are created by submitting a receipt (POST /api/goods-receipts/:id/submit)",
      });
      return;
    }
    if (type === "goods_issue") {
      res.status(400).json({
        message:
          "Goods issue approvals are created by submitting an issue (POST /api/goods-issues/:id/submit)",
        error:
          "Goods issue approvals are created by submitting an issue (POST /api/goods-issues/:id/submit)",
      });
      return;
    }
    if (type === "stock_count") {
      res.status(400).json({
        message:
          "Stock count approvals are created by submitting a count (POST /api/stock-counts/:id/submit)",
        error:
          "Stock count approvals are created by submitting a count (POST /api/stock-counts/:id/submit)",
      });
      return;
    }

    let amount = null;
    if (hasField(req.body, "amount") && req.body.amount !== null && req.body.amount !== "") {
      const n = Number(req.body.amount);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ message: "amount must be a non-negative number", error: "amount must be a non-negative number" });
        return;
      }
      amount = Math.round(n * 100) / 100;
    }

    let entityId = null;
    if (req.body?.entityId) {
      if (!mongoose.Types.ObjectId.isValid(req.body.entityId)) {
        res.status(400).json({ message: "Invalid entityId", error: "Invalid entityId" });
        return;
      }
      entityId = req.body.entityId;
    }

    const approval = await Approval.create({
      approvalNumber: await nextApprovalNumber(),
      type,
      status: "pending",
      title,
      description: str(req.body, "description") ?? "",
      entityType: str(req.body, "entityType") ?? "",
      entityId,
      payload: req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {},
      amount,
      requestedBy: req.user?._id || null,
    });

    const populated = await populateApproval(approval._id);
    res.status(201).json(formatApproval(populated));
  } catch (err) {
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors || {})[0]?.message || err.message;
      res.status(400).json({ message: msg, error: msg });
      return;
    }
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    const status = String(req.query.status || "").trim().toLowerCase();
    if (status && APPROVAL_STATUSES.includes(status)) {
      filter.status = status;
    }
    const type = String(req.query.type || "").trim().toLowerCase();
    if (type && APPROVAL_TYPES.includes(type)) {
      filter.type = type;
    }
    const q = String(req.query.q || req.query.search || "").trim();
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: re }, { description: re }, { approvalNumber: re }];
    }

    const [rows, total] = await Promise.all([
      Approval.find(filter)
        .populate("requestedBy", "name email")
        .populate("reviewedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Approval.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatApproval),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid approval id", error: "Invalid approval id" });
      return;
    }
    const approval = await populateApproval(req.params.id);
    if (!approval) {
      res.status(404).json({ message: "Approval not found", error: "Approval not found" });
      return;
    }

    let entity = null;
    if (approval.type === "warehouse_transfer" && approval.entityId) {
      entity = await StockTransfer.findById(approval.entityId)
        .populate("fromWarehouse", "code name")
        .populate("toWarehouse", "code name")
        .populate("lines.product", "name sku")
        .lean();
      if (entity) entity = formatTransfer(entity);
    } else if (approval.type === "goods_receipt" && approval.entityId) {
      entity = await GoodsReceipt.findById(approval.entityId)
        .populate("warehouse", "code name")
        .populate("supplier", "name")
        .populate("lines.product", "name sku")
        .lean();
      if (entity) entity = formatReceipt(entity);
    } else if (approval.type === "goods_issue" && approval.entityId) {
      entity = await GoodsIssue.findById(approval.entityId)
        .populate("warehouse", "code name")
        .populate("lines.product", "name sku")
        .lean();
      if (entity) entity = formatIssue(entity);
    } else if (approval.type === "stock_count" && approval.entityId) {
      entity = await StockCount.findById(approval.entityId)
        .populate("warehouse", "code name")
        .populate("lines.product", "name sku")
        .lean();
      if (entity) entity = formatCount(entity);
    }

    res.json({ ...formatApproval(approval), entity });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid approval id", error: "Invalid approval id" });
      return;
    }
    const approval = await Approval.findById(req.params.id);
    if (!approval) {
      res.status(404).json({ message: "Approval not found", error: "Approval not found" });
      return;
    }
    if (approval.status !== "pending") {
      res.status(409).json({
        message: `Only pending approvals can be approved (current: ${approval.status})`,
        error: `Only pending approvals can be approved (current: ${approval.status})`,
      });
      return;
    }

    const notes = str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";

    if (approval.type === "warehouse_transfer" && approval.entityId) {
      const transfer = await StockTransfer.findById(approval.entityId);
      if (!transfer) {
        res.status(404).json({ message: "Linked transfer not found", error: "Linked transfer not found" });
        return;
      }
      const result = await approveTransfer(transfer, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        transfer: formatTransfer(result.transfer),
      });
      return;
    }

    if (approval.type === "goods_receipt" && approval.entityId) {
      const receipt = await GoodsReceipt.findById(approval.entityId);
      if (!receipt) {
        res.status(404).json({ message: "Linked goods receipt not found", error: "Linked goods receipt not found" });
        return;
      }
      const result = await approveReceipt(receipt, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        goodsReceipt: formatReceipt(result.receipt),
      });
      return;
    }

    if (approval.type === "goods_issue" && approval.entityId) {
      const issue = await GoodsIssue.findById(approval.entityId);
      if (!issue) {
        res.status(404).json({ message: "Linked goods issue not found", error: "Linked goods issue not found" });
        return;
      }
      const result = await approveIssue(issue, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        goodsIssue: formatIssue(result.issue),
      });
      return;
    }

    if (approval.type === "stock_count" && approval.entityId) {
      const count = await StockCount.findById(approval.entityId);
      if (!count) {
        res.status(404).json({ message: "Linked stock count not found", error: "Linked stock count not found" });
        return;
      }
      const result = await approveCount(count, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        stockCount: formatCount(result.count),
      });
      return;
    }

    approval.status = "approved";
    approval.reviewedBy = req.user?._id || null;
    approval.reviewedAt = new Date();
    approval.reviewNotes = notes;
    await approval.save();

    const populated = await populateApproval(approval._id);
    res.json({ approval: formatApproval(populated) });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid approval id", error: "Invalid approval id" });
      return;
    }
    const approval = await Approval.findById(req.params.id);
    if (!approval) {
      res.status(404).json({ message: "Approval not found", error: "Approval not found" });
      return;
    }
    if (approval.status !== "pending") {
      res.status(409).json({
        message: `Only pending approvals can be rejected (current: ${approval.status})`,
        error: `Only pending approvals can be rejected (current: ${approval.status})`,
      });
      return;
    }

    const notes =
      str(req.body, "reviewNotes") ??
      str(req.body, "reason") ??
      str(req.body, "notes") ??
      "";

    if (approval.type === "warehouse_transfer" && approval.entityId) {
      const transfer = await StockTransfer.findById(approval.entityId);
      if (!transfer) {
        res.status(404).json({ message: "Linked transfer not found", error: "Linked transfer not found" });
        return;
      }
      const result = await rejectTransfer(transfer, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        transfer: formatTransfer(result.transfer),
      });
      return;
    }

    if (approval.type === "goods_receipt" && approval.entityId) {
      const receipt = await GoodsReceipt.findById(approval.entityId);
      if (!receipt) {
        res.status(404).json({ message: "Linked goods receipt not found", error: "Linked goods receipt not found" });
        return;
      }
      const result = await rejectReceipt(receipt, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        goodsReceipt: formatReceipt(result.receipt),
      });
      return;
    }

    if (approval.type === "goods_issue" && approval.entityId) {
      const issue = await GoodsIssue.findById(approval.entityId);
      if (!issue) {
        res.status(404).json({ message: "Linked goods issue not found", error: "Linked goods issue not found" });
        return;
      }
      const result = await rejectIssue(issue, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        goodsIssue: formatIssue(result.issue),
      });
      return;
    }

    if (approval.type === "stock_count" && approval.entityId) {
      const count = await StockCount.findById(approval.entityId);
      if (!count) {
        res.status(404).json({ message: "Linked stock count not found", error: "Linked stock count not found" });
        return;
      }
      const result = await rejectCount(count, req.user?._id, notes);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
      const populated = await populateApproval(approval._id);
      res.json({
        approval: formatApproval(populated),
        stockCount: formatCount(result.count),
      });
      return;
    }

    approval.status = "rejected";
    approval.reviewedBy = req.user?._id || null;
    approval.reviewedAt = new Date();
    approval.reviewNotes = notes;
    await approval.save();

    const populated = await populateApproval(approval._id);
    res.json({ approval: formatApproval(populated) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
