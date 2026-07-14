const express = require("express");
const mongoose = require("mongoose");
const GoodsReceipt = require("../models/GoodsReceipt");
const { RECEIPT_STATUSES } = require("../models/GoodsReceipt");
const Warehouse = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");
const Product = require("../models/Product");
const Supplier = require("../models/Supplier");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const {
  nextReceiptNumber,
  formatReceipt,
  submitReceipt,
  approveReceipt,
  rejectReceipt,
  cancelReceipt,
} = require("../utils/goodsReceipts");
const { writeAuditLog } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("goods_receipt", "warehouses", "inventory"));

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

    let unitCost = null;
    if (row.unitCost != null && row.unitCost !== "") {
      const c = Number(row.unitCost);
      if (!Number.isFinite(c) || c < 0) {
        return { error: `lines[${i}].unitCost must be a non-negative number` };
      }
      unitCost = c;
    }

    lines.push({
      product: productParsed.value,
      quantity: qty,
      location: loc.value,
      unitCost,
    });
  }
  return { value: lines };
}

async function populateReceipt(id) {
  return GoodsReceipt.findById(id)
    .populate("warehouse", "code name")
    .populate("supplier", "name")
    .populate("lines.product", "name sku barcode unit")
    .populate("lines.location", "code name type fullPath")
    .populate("receivedBy", "name email")
    .populate("approvedBy", "name email")
    .populate("approval")
    .lean();
}

router.get("/meta", (_req, res) => {
  res.json({
    statuses: RECEIPT_STATUSES,
    workflow: ["draft", "pending_approval", "completed"],
    cancelledFrom: ["draft", "pending_approval"],
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

    let supplierId = null;
    let supplierName = str(req.body, "supplierName") ?? "";
    const supplierParsed = parseObjectId(req.body?.supplierId ?? req.body?.supplier, "supplierId", {
      required: false,
    });
    if (supplierParsed.error) {
      res.status(400).json({ message: supplierParsed.error, error: supplierParsed.error });
      return;
    }
    if (supplierParsed.value) {
      const supplier = await Supplier.findById(supplierParsed.value).select("name").lean();
      if (!supplier) {
        res.status(404).json({ message: "Supplier not found", error: "Supplier not found" });
        return;
      }
      supplierId = supplierParsed.value;
      if (!supplierName) supplierName = supplier.name || "";
    }

    let purchaseId = null;
    if (req.body?.purchaseId) {
      const p = parseObjectId(req.body.purchaseId, "purchaseId");
      if (p.error) {
        res.status(400).json({ message: p.error, error: p.error });
        return;
      }
      purchaseId = p.value;
    }

    const receipt = await GoodsReceipt.create({
      receiptNumber: await nextReceiptNumber(),
      warehouse: whParsed.value,
      supplier: supplierId,
      purchase: purchaseId,
      supplierName,
      deliveryNote: str(req.body, "deliveryNote") ?? "",
      lines: linesParsed.value,
      status: "draft",
      notes: str(req.body, "notes") ?? "",
      receivedBy: req.user?._id || null,
    });

    await writeAuditLog({
      action: "goods_receipt.created",
      entityType: "GoodsReceipt",
      entityId: receipt._id,
      summary: `Created ${receipt.receiptNumber}`,
      user: req.user,
    });

    const submitNow = Boolean(req.body?.submit);
    if (submitNow) {
      const result = await submitReceipt(receipt, req.user?._id);
      if (!result.ok) {
        res.status(result.status || 409).json({ message: result.error, error: result.error });
        return;
      }
    }

    const populated = await populateReceipt(receipt._id);
    res.status(201).json(formatReceipt(populated));
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
    if (status && RECEIPT_STATUSES.includes(status)) filter.status = status;
    if (req.query.warehouseId && mongoose.Types.ObjectId.isValid(req.query.warehouseId)) {
      filter.warehouse = req.query.warehouseId;
    }

    const [rows, total] = await Promise.all([
      GoodsReceipt.find(filter)
        .populate("warehouse", "code name")
        .populate("supplier", "name")
        .populate("receivedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GoodsReceipt.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatReceipt),
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
      res.status(400).json({ message: "Invalid receipt id", error: "Invalid receipt id" });
      return;
    }
    const receipt = await populateReceipt(req.params.id);
    if (!receipt) {
      res.status(404).json({ message: "Goods receipt not found", error: "Goods receipt not found" });
      return;
    }
    res.json(formatReceipt(receipt));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid receipt id", error: "Invalid receipt id" });
      return;
    }
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) {
      res.status(404).json({ message: "Goods receipt not found", error: "Goods receipt not found" });
      return;
    }
    if (receipt.status !== "draft") {
      res.status(409).json({
        message: "Only draft receipts can be edited",
        error: "Only draft receipts can be edited",
      });
      return;
    }

    if (hasField(req.body, "notes")) receipt.notes = str(req.body, "notes") ?? "";
    if (hasField(req.body, "deliveryNote")) {
      receipt.deliveryNote = str(req.body, "deliveryNote") ?? "";
    }
    if (hasField(req.body, "supplierName")) {
      receipt.supplierName = str(req.body, "supplierName") ?? "";
    }
    if (hasField(req.body, "lines")) {
      const linesParsed = await parseLines(req.body.lines, receipt.warehouse);
      if (linesParsed.error) {
        res.status(400).json({ message: linesParsed.error, error: linesParsed.error });
        return;
      }
      receipt.lines = linesParsed.value;
    }

    await receipt.save();
    const populated = await populateReceipt(receipt._id);
    res.json(formatReceipt(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/submit", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid receipt id", error: "Invalid receipt id" });
      return;
    }
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) {
      res.status(404).json({ message: "Goods receipt not found", error: "Goods receipt not found" });
      return;
    }
    const result = await submitReceipt(receipt, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateReceipt(receipt._id);
    res.json(formatReceipt(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid receipt id", error: "Invalid receipt id" });
      return;
    }
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) {
      res.status(404).json({ message: "Goods receipt not found", error: "Goods receipt not found" });
      return;
    }
    const notes = str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await approveReceipt(receipt, req.user?._id, notes);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateReceipt(receipt._id);
    res.json(formatReceipt(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid receipt id", error: "Invalid receipt id" });
      return;
    }
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) {
      res.status(404).json({ message: "Goods receipt not found", error: "Goods receipt not found" });
      return;
    }
    const reason =
      str(req.body, "reason") ?? str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await rejectReceipt(receipt, req.user?._id, reason);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateReceipt(receipt._id);
    res.json(formatReceipt(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/cancel", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid receipt id", error: "Invalid receipt id" });
      return;
    }
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) {
      res.status(404).json({ message: "Goods receipt not found", error: "Goods receipt not found" });
      return;
    }
    const result = await cancelReceipt(receipt, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateReceipt(receipt._id);
    res.json(formatReceipt(populated));
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
