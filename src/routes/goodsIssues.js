const express = require("express");
const mongoose = require("mongoose");
const GoodsIssue = require("../models/GoodsIssue");
const { ISSUE_STATUSES } = require("../models/GoodsIssue");
const Warehouse = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");
const Product = require("../models/Product");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const {
  nextIssueNumber,
  formatIssue,
  submitIssue,
  approveIssue,
  rejectIssue,
  issueGoods,
  cancelIssue,
} = require("../utils/goodsIssues");
const { writeAuditLog } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("goods_issue", "warehouses", "inventory"));

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

function str(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return String(v).trim();
  return v.trim();
}

function parseObjectId(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) return { error: `${fieldName} is required` };
    return { value: null };
  }
  const id = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return { error: `Invalid ${fieldName}` };
  }
  return { value: id };
}

async function assertLocation(locationId, warehouseId) {
  if (!locationId) return { ok: true };
  const loc = await StorageLocation.findById(locationId).lean();
  if (!loc) return { ok: false, error: "Storage location not found" };
  if (String(loc.warehouse) !== String(warehouseId)) {
    return { ok: false, error: "Storage location does not belong to the warehouse" };
  }
  return { ok: true };
}

async function parseLines(rawLines, warehouseId) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { error: "lines must be a non-empty array" };
  }
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const row = rawLines[i] || {};
    const productParsed = parseObjectId(row.productId ?? row.product, `lines[${i}].productId`);
    if (productParsed.error) return { error: productParsed.error };

    const qty = Number(row.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { error: `lines[${i}].quantity must be greater than zero` };
    }

    const product = await Product.findById(productParsed.value).select("_id").lean();
    if (!product) return { error: `lines[${i}]: product not found` };

    const loc = parseObjectId(row.locationId ?? row.location, `lines[${i}].locationId`, {
      required: false,
    });
    if (loc.error) return { error: loc.error };
    const locCheck = await assertLocation(loc.value, warehouseId);
    if (!locCheck.ok) return { error: `lines[${i}]: ${locCheck.error}` };

    lines.push({
      product: productParsed.value,
      quantity: qty,
      location: loc.value,
      issuedQuantity: null,
    });
  }
  return { value: lines };
}

async function populateIssue(id) {
  return GoodsIssue.findById(id)
    .populate("warehouse", "code name")
    .populate("lines.product", "name sku barcode unit")
    .populate("lines.location", "code name type fullPath")
    .populate("requestedBy", "name email")
    .populate("approvedBy", "name email")
    .populate("issuedBy", "name email")
    .populate("approval")
    .lean();
}

router.get("/meta", (_req, res) => {
  res.json({
    statuses: ISSUE_STATUSES,
    workflow: ["draft", "pending_approval", "approved", "issued"],
    cancelledFrom: ["draft", "pending_approval", "approved"],
  });
});

router.post("/", async (req, res, next) => {
  try {
    const whParsed = parseObjectId(req.body?.warehouseId ?? req.body?.warehouse, "warehouseId");
    if (whParsed.error) {
      res.status(400).json({ message: whParsed.error, error: whParsed.error });
      return;
    }
    const warehouse = await Warehouse.findById(whParsed.value).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const linesParsed = await parseLines(req.body?.lines, whParsed.value);
    if (linesParsed.error) {
      res.status(400).json({ message: linesParsed.error, error: linesParsed.error });
      return;
    }

    const issue = await GoodsIssue.create({
      issueNumber: await nextIssueNumber(),
      warehouse: whParsed.value,
      lines: linesParsed.value,
      status: "draft",
      purpose: str(req.body, "purpose") ?? "",
      notes: str(req.body, "notes") ?? "",
      requestedBy: req.user?._id || null,
    });

    await writeAuditLog({
      action: "goods_issue.created",
      entityType: "GoodsIssue",
      entityId: issue._id,
      summary: `Created ${issue.issueNumber}`,
      user: req.user,
    });

    if (Boolean(req.body?.submit)) {
      const result = await submitIssue(issue, req.user?._id);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
    }

    const populated = await populateIssue(issue._id);
    res.status(201).json(formatIssue(populated));
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
    if (status && ISSUE_STATUSES.includes(status)) filter.status = status;
    if (req.query.warehouseId && mongoose.Types.ObjectId.isValid(req.query.warehouseId)) {
      filter.warehouse = req.query.warehouseId;
    }
    if (req.query.mine === "1" || req.query.mine === "true") {
      filter.requestedBy = req.user?._id;
    }

    const [rows, total] = await Promise.all([
      GoodsIssue.find(filter)
        .populate("warehouse", "code name")
        .populate("requestedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GoodsIssue.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatIssue),
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
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await populateIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }
    res.json(formatIssue(issue));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await GoodsIssue.findById(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }
    if (issue.status !== "draft") {
      res.status(409).json({
        message: "Only draft issues can be edited",
        error: "Only draft issues can be edited",
      });
      return;
    }

    if (hasField(req.body, "notes")) issue.notes = str(req.body, "notes") ?? "";
    if (hasField(req.body, "purpose")) issue.purpose = str(req.body, "purpose") ?? "";
    if (hasField(req.body, "lines")) {
      const linesParsed = await parseLines(req.body.lines, issue.warehouse);
      if (linesParsed.error) {
        res.status(400).json({ message: linesParsed.error, error: linesParsed.error });
        return;
      }
      issue.lines = linesParsed.value;
    }

    await issue.save();
    const populated = await populateIssue(issue._id);
    res.json(formatIssue(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/submit", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await GoodsIssue.findById(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }
    const result = await submitIssue(issue, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateIssue(issue._id);
    res.json(formatIssue(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await GoodsIssue.findById(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }
    const notes = str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await approveIssue(issue, req.user?._id, notes);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateIssue(issue._id);
    res.json(formatIssue(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await GoodsIssue.findById(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }
    const reason =
      str(req.body, "reason") ?? str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await rejectIssue(issue, req.user?._id, reason);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateIssue(issue._id);
    res.json(formatIssue(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/issue", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await GoodsIssue.findById(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }

    const overrides = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const normalized = overrides.map((row, i) => {
      const lineId = row.lineId ?? row._id ?? row.id;
      let locationId = undefined;
      if (Object.prototype.hasOwnProperty.call(row, "locationId") || Object.prototype.hasOwnProperty.call(row, "location")) {
        const loc = parseObjectId(row.locationId ?? row.location, `lines[${i}].locationId`, {
          required: false,
        });
        if (loc.error) return { error: loc.error };
        locationId = loc.value;
      }
      return {
        lineId,
        issuedQuantity: row.issuedQuantity != null ? Number(row.issuedQuantity) : undefined,
        locationId,
        error: null,
      };
    });
    const bad = normalized.find((n) => n.error);
    if (bad) {
      res.status(400).json({ message: bad.error, error: bad.error });
      return;
    }

    const result = await issueGoods(issue, req.user?._id, normalized);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateIssue(issue._id);
    res.json(formatIssue(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/cancel", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid issue id", error: "Invalid issue id" });
      return;
    }
    const issue = await GoodsIssue.findById(req.params.id);
    if (!issue) {
      res.status(404).json({ message: "Goods issue not found", error: "Goods issue not found" });
      return;
    }
    const result = await cancelIssue(issue, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateIssue(issue._id);
    res.json(formatIssue(populated));
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
