const express = require("express");
const mongoose = require("mongoose");
const StockTransfer = require("../models/StockTransfer");
const { TRANSFER_STATUSES } = require("../models/StockTransfer");
const Warehouse = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");
const Product = require("../models/Product");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const {
  nextTransferNumber,
  formatTransfer,
  submitTransfer,
  approveTransfer,
  rejectTransfer,
  receiveTransfer,
  cancelTransfer,
} = require("../utils/transfers");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("warehouse_transfers", "warehouses", "inventory"));

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

async function parseLines(rawLines, fromWarehouseId, toWarehouseId) {
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
    if (!product) {
      return { error: `lines[${i}]: product not found` };
    }

    const fromLoc = parseObjectId(row.fromLocationId ?? row.fromLocation, `lines[${i}].fromLocationId`, {
      required: false,
    });
    if (fromLoc.error) return { error: fromLoc.error };
    const fromCheck = await assertLocation(fromLoc.value, fromWarehouseId);
    if (!fromCheck.ok) return { error: `lines[${i}]: ${fromCheck.error}` };

    const toLoc = parseObjectId(row.toLocationId ?? row.toLocation, `lines[${i}].toLocationId`, {
      required: false,
    });
    if (toLoc.error) return { error: toLoc.error };
    const toCheck = await assertLocation(toLoc.value, toWarehouseId);
    if (!toCheck.ok) return { error: `lines[${i}]: ${toCheck.error}` };

    lines.push({
      product: productParsed.value,
      quantity: qty,
      fromLocation: fromLoc.value,
      toLocation: toLoc.value,
    });
  }

  return { value: lines };
}

async function populateTransfer(id) {
  return StockTransfer.findById(id)
    .populate("fromWarehouse", "code name")
    .populate("toWarehouse", "code name")
    .populate("lines.product", "name sku")
    .populate("lines.fromLocation", "code name type")
    .populate("lines.toLocation", "code name type")
    .populate("requestedBy", "name email")
    .populate("approvedBy", "name email")
    .populate("receivedBy", "name email")
    .populate("approval")
    .lean();
}

router.get("/meta", (_req, res) => {
  res.json({
    statuses: TRANSFER_STATUSES,
    workflow: ["draft", "pending_approval", "in_transit", "received"],
    cancelledFrom: ["draft", "pending_approval", "in_transit"],
  });
});

router.post("/", async (req, res, next) => {
  try {
    const fromParsed = parseObjectId(req.body?.fromWarehouseId, "fromWarehouseId");
    if (fromParsed.error) {
      res.status(400).json({ message: fromParsed.error, error: fromParsed.error });
      return;
    }
    const toParsed = parseObjectId(req.body?.toWarehouseId, "toWarehouseId");
    if (toParsed.error) {
      res.status(400).json({ message: toParsed.error, error: toParsed.error });
      return;
    }

    if (fromParsed.value === toParsed.value) {
      // Same-warehouse location moves are still allowed (shelf/bin transfers)
      // but we still require distinct location movement intent via lines.
    }

    const [fromWh, toWh] = await Promise.all([
      Warehouse.findById(fromParsed.value).lean(),
      Warehouse.findById(toParsed.value).lean(),
    ]);
    if (!fromWh) {
      res.status(404).json({ message: "Source warehouse not found", error: "Source warehouse not found" });
      return;
    }
    if (!toWh) {
      res.status(404).json({ message: "Destination warehouse not found", error: "Destination warehouse not found" });
      return;
    }

    const linesParsed = await parseLines(req.body?.lines, fromParsed.value, toParsed.value);
    if (linesParsed.error) {
      res.status(400).json({ message: linesParsed.error, error: linesParsed.error });
      return;
    }

    const submitNow =
      req.body?.submit === true ||
      req.body?.submit === "true" ||
      String(req.body?.status || "").toLowerCase() === "pending_approval";

    const transfer = await StockTransfer.create({
      transferNumber: await nextTransferNumber(),
      fromWarehouse: fromParsed.value,
      toWarehouse: toParsed.value,
      lines: linesParsed.value,
      notes: str(req.body, "notes") ?? "",
      status: "draft",
      requestedBy: req.user?._id || null,
    });

    if (submitNow) {
      const submitted = await submitTransfer(transfer, req.user?._id);
      if (!submitted.ok) {
        res.status(submitted.status || 409).json({ message: submitted.error, error: submitted.error });
        return;
      }
    }

    const populated = await populateTransfer(transfer._id);
    res.status(201).json(formatTransfer(populated));
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
    if (status && TRANSFER_STATUSES.includes(status)) {
      filter.status = status;
    }
    if (req.query.fromWarehouseId && mongoose.Types.ObjectId.isValid(req.query.fromWarehouseId)) {
      filter.fromWarehouse = req.query.fromWarehouseId;
    }
    if (req.query.toWarehouseId && mongoose.Types.ObjectId.isValid(req.query.toWarehouseId)) {
      filter.toWarehouse = req.query.toWarehouseId;
    }
    if (req.query.warehouseId && mongoose.Types.ObjectId.isValid(req.query.warehouseId)) {
      filter.$or = [
        { fromWarehouse: req.query.warehouseId },
        { toWarehouse: req.query.warehouseId },
      ];
    }

    const [rows, total] = await Promise.all([
      StockTransfer.find(filter)
        .populate("fromWarehouse", "code name")
        .populate("toWarehouse", "code name")
        .populate("lines.product", "name sku")
        .populate("requestedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockTransfer.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatTransfer),
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
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await populateTransfer(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    res.json(formatTransfer(transfer));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    if (transfer.status !== "draft") {
      res.status(409).json({
        message: "Only draft transfers can be edited",
        error: "Only draft transfers can be edited",
      });
      return;
    }

    const body = req.body || {};
    if (hasField(body, "notes")) {
      transfer.notes = str(body, "notes") ?? "";
    }

    let fromId = String(transfer.fromWarehouse);
    let toId = String(transfer.toWarehouse);

    if (hasField(body, "fromWarehouseId")) {
      const p = parseObjectId(body.fromWarehouseId, "fromWarehouseId");
      if (p.error) {
        res.status(400).json({ message: p.error, error: p.error });
        return;
      }
      const wh = await Warehouse.findById(p.value).lean();
      if (!wh) {
        res.status(404).json({ message: "Source warehouse not found", error: "Source warehouse not found" });
        return;
      }
      transfer.fromWarehouse = p.value;
      fromId = p.value;
    }

    if (hasField(body, "toWarehouseId")) {
      const p = parseObjectId(body.toWarehouseId, "toWarehouseId");
      if (p.error) {
        res.status(400).json({ message: p.error, error: p.error });
        return;
      }
      const wh = await Warehouse.findById(p.value).lean();
      if (!wh) {
        res.status(404).json({ message: "Destination warehouse not found", error: "Destination warehouse not found" });
        return;
      }
      transfer.toWarehouse = p.value;
      toId = p.value;
    }

    if (hasField(body, "lines")) {
      const linesParsed = await parseLines(body.lines, fromId, toId);
      if (linesParsed.error) {
        res.status(400).json({ message: linesParsed.error, error: linesParsed.error });
        return;
      }
      transfer.lines = linesParsed.value;
    }

    await transfer.save();
    const populated = await populateTransfer(transfer._id);
    res.json(formatTransfer(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/submit", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    const result = await submitTransfer(transfer, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateTransfer(transfer._id);
    res.json(formatTransfer(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    const result = await approveTransfer(
      transfer,
      req.user?._id,
      str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? ""
    );
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateTransfer(transfer._id);
    res.json(formatTransfer(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    const reason =
      str(req.body, "reason") ?? str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await rejectTransfer(transfer, req.user?._id, reason);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateTransfer(transfer._id);
    res.json(formatTransfer(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/receive", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    const result = await receiveTransfer(transfer, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateTransfer(transfer._id);
    res.json(formatTransfer(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/cancel", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid transfer id", error: "Invalid transfer id" });
      return;
    }
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      res.status(404).json({ message: "Transfer not found", error: "Transfer not found" });
      return;
    }
    const result = await cancelTransfer(transfer, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateTransfer(transfer._id);
    res.json(formatTransfer(populated));
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
