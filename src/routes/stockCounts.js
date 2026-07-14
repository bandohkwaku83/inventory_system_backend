const express = require("express");
const mongoose = require("mongoose");
const StockCount = require("../models/StockCount");
const { COUNT_STATUSES } = require("../models/StockCount");
const Warehouse = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");
const Product = require("../models/Product");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const {
  nextCountNumber,
  formatCount,
  snapshotSystemQuantities,
  submitCount,
  approveCount,
  rejectCount,
  cancelCount,
} = require("../utils/stockCounts");
const { writeAuditLog } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("stock_counts", "warehouses", "inventory"));

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

async function populateCount(id) {
  return StockCount.findById(id)
    .populate("warehouse", "code name")
    .populate("location", "code name type fullPath")
    .populate("lines.product", "name sku barcode unit reorderAt")
    .populate("lines.location", "code name type fullPath")
    .populate("createdBy", "name email")
    .populate("countedBy", "name email")
    .populate("approvedBy", "name email")
    .populate("approval")
    .lean();
}

router.get("/meta", (_req, res) => {
  res.json({
    statuses: COUNT_STATUSES,
    workflow: ["draft", "counting", "pending_approval", "completed"],
    cancelledFrom: ["draft", "counting", "pending_approval"],
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

    let locationId = null;
    const locParsed = parseObjectId(req.body?.locationId ?? req.body?.location, "locationId", {
      required: false,
    });
    if (locParsed.error) {
      res.status(400).json({ message: locParsed.error, error: locParsed.error });
      return;
    }
    if (locParsed.value) {
      const loc = await StorageLocation.findById(locParsed.value).lean();
      if (!loc || String(loc.warehouse) !== String(whParsed.value)) {
        res.status(400).json({
          message: "Location must belong to the warehouse",
          error: "Location must belong to the warehouse",
        });
        return;
      }
      locationId = locParsed.value;
    }

    const seedLines = Boolean(req.body?.seedFromStock !== false);
    let lines = [];
    if (Array.isArray(req.body?.lines) && req.body.lines.length > 0) {
      for (let i = 0; i < req.body.lines.length; i++) {
        const row = req.body.lines[i] || {};
        const productParsed = parseObjectId(row.productId ?? row.product, `lines[${i}].productId`);
        if (productParsed.error) {
          res.status(400).json({ message: productParsed.error, error: productParsed.error });
          return;
        }
        const product = await Product.findById(productParsed.value).select("_id").lean();
        if (!product) {
          res.status(400).json({
            message: `lines[${i}]: product not found`,
            error: `lines[${i}]: product not found`,
          });
          return;
        }
        const systemQty = Number(row.systemQuantity);
        lines.push({
          product: productParsed.value,
          location: row.locationId || row.location || locationId || null,
          systemQuantity: Number.isFinite(systemQty) && systemQty >= 0 ? systemQty : 0,
          countedQuantity: null,
          variance: null,
          reason: "",
        });
      }
    } else if (seedLines) {
      lines = await snapshotSystemQuantities(whParsed.value, locationId);
    }

    const count = await StockCount.create({
      countNumber: await nextCountNumber(),
      warehouse: whParsed.value,
      location: locationId,
      lines,
      status: lines.length > 0 ? "counting" : "draft",
      notes: str(req.body, "notes") ?? "",
      createdBy: req.user?._id || null,
    });

    await writeAuditLog({
      action: "stock_count.created",
      entityType: "StockCount",
      entityId: count._id,
      summary: `Created ${count.countNumber}`,
      user: req.user,
    });

    const populated = await populateCount(count._id);
    res.status(201).json(formatCount(populated));
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
    if (status && COUNT_STATUSES.includes(status)) filter.status = status;
    if (req.query.warehouseId && mongoose.Types.ObjectId.isValid(req.query.warehouseId)) {
      filter.warehouse = req.query.warehouseId;
    }

    const [rows, total] = await Promise.all([
      StockCount.find(filter)
        .populate("warehouse", "code name")
        .populate("createdBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockCount.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatCount),
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
      res.status(400).json({ message: "Invalid count id", error: "Invalid count id" });
      return;
    }
    const count = await populateCount(req.params.id);
    if (!count) {
      res.status(404).json({ message: "Stock count not found", error: "Stock count not found" });
      return;
    }
    res.json(formatCount(count));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid count id", error: "Invalid count id" });
      return;
    }
    const count = await StockCount.findById(req.params.id);
    if (!count) {
      res.status(404).json({ message: "Stock count not found", error: "Stock count not found" });
      return;
    }
    if (!["draft", "counting"].includes(count.status)) {
      res.status(409).json({
        message: "Only draft/counting sessions can be edited",
        error: "Only draft/counting sessions can be edited",
      });
      return;
    }

    if (hasField(req.body, "notes")) count.notes = str(req.body, "notes") ?? "";

    if (Array.isArray(req.body?.lines)) {
      for (const row of req.body.lines) {
        const lineId = row.lineId ?? row._id ?? row.id;
        let line = null;
        if (lineId) {
          line = count.lines.id(lineId);
        }
        if (!line && (row.productId || row.product)) {
          line = count.lines.find(
            (l) => String(l.product) === String(row.productId || row.product)
          );
        }
        if (!line) continue;

        if (row.countedQuantity != null && row.countedQuantity !== "") {
          const n = Number(row.countedQuantity);
          if (!Number.isFinite(n) || n < 0) {
            res.status(400).json({
              message: "countedQuantity must be a non-negative number",
              error: "countedQuantity must be a non-negative number",
            });
            return;
          }
          line.countedQuantity = n;
          line.variance = n - Number(line.systemQuantity);
        }
        if (hasField(row, "reason")) {
          line.reason = String(row.reason || "").trim().slice(0, 500);
        }
      }
      if (count.status === "draft") count.status = "counting";
    }

    count.countedBy = req.user?._id || count.countedBy;
    await count.save();
    const populated = await populateCount(count._id);
    res.json(formatCount(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/submit", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid count id", error: "Invalid count id" });
      return;
    }
    const count = await StockCount.findById(req.params.id);
    if (!count) {
      res.status(404).json({ message: "Stock count not found", error: "Stock count not found" });
      return;
    }
    const result = await submitCount(count, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateCount(count._id);
    res.json(formatCount(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid count id", error: "Invalid count id" });
      return;
    }
    const count = await StockCount.findById(req.params.id);
    if (!count) {
      res.status(404).json({ message: "Stock count not found", error: "Stock count not found" });
      return;
    }
    const notes = str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await approveCount(count, req.user?._id, notes);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateCount(count._id);
    res.json(formatCount(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid count id", error: "Invalid count id" });
      return;
    }
    const count = await StockCount.findById(req.params.id);
    if (!count) {
      res.status(404).json({ message: "Stock count not found", error: "Stock count not found" });
      return;
    }
    const reason =
      str(req.body, "reason") ?? str(req.body, "reviewNotes") ?? str(req.body, "notes") ?? "";
    const result = await rejectCount(count, req.user?._id, reason);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateCount(count._id);
    res.json(formatCount(populated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/cancel", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid count id", error: "Invalid count id" });
      return;
    }
    const count = await StockCount.findById(req.params.id);
    if (!count) {
      res.status(404).json({ message: "Stock count not found", error: "Stock count not found" });
      return;
    }
    const result = await cancelCount(count, req.user?._id);
    if (!result.ok) {
      res.status(result.status || 409).json({ message: result.error, error: result.error });
      return;
    }
    const populated = await populateCount(count._id);
    res.json(formatCount(populated));
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
