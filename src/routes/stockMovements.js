const express = require("express");
const mongoose = require("mongoose");
const StockMovement = require("../models/StockMovement");
const { STOCK_MOVEMENT_TYPES } = require("../models/StockMovement");
const Warehouse = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");
const Product = require("../models/Product");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const { applyStockMovement } = require("../utils/warehouseStock");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("inventory", "warehouses"));

/** Types callers can create manually (transfers use their own flow) */
const CREATABLE_TYPES = [
  "stock_in",
  "stock_out",
  "adjustment",
  "opening_stock",
  "damaged",
  "returned",
  "internal_move",
];

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

function parseQuantity(value, fieldName, { allowNegative = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return { error: `${fieldName} is required` };
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return { error: `${fieldName} must be a number` };
  }
  if (!allowNegative && n <= 0) {
    return { error: `${fieldName} must be greater than zero` };
  }
  if (allowNegative && n === 0) {
    return { error: `${fieldName} cannot be zero` };
  }
  return { value: n };
}

async function assertLocation(locationId, warehouseId) {
  if (!locationId) return { ok: true };
  const loc = await StorageLocation.findById(locationId).lean();
  if (!loc) return { ok: false, error: "Storage location not found" };
  if (String(loc.warehouse) !== String(warehouseId)) {
    return { ok: false, error: "Storage location does not belong to the warehouse" };
  }
  return { ok: true, location: loc };
}

function formatMovement(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (o.createdAt instanceof Date) o.createdAt = o.createdAt.toISOString();
  if (o.updatedAt instanceof Date) o.updatedAt = o.updatedAt.toISOString();
  return o;
}

router.get("/meta", (_req, res) => {
  res.json({
    types: STOCK_MOVEMENT_TYPES,
    creatableTypes: CREATABLE_TYPES,
  });
});

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    const and = [];
    if (req.query.warehouseId && mongoose.Types.ObjectId.isValid(req.query.warehouseId)) {
      and.push({
        $or: [
          { warehouse: req.query.warehouseId },
          { toWarehouse: req.query.warehouseId },
        ],
      });
    }
    if (req.query.productId && mongoose.Types.ObjectId.isValid(req.query.productId)) {
      and.push({ product: req.query.productId });
    }
    if (req.query.type) {
      const t = String(req.query.type).trim();
      if (STOCK_MOVEMENT_TYPES.includes(t)) and.push({ type: t });
    }
    if (req.query.from || req.query.to) {
      const createdAt = {};
      if (req.query.from) {
        const d = new Date(String(req.query.from));
        if (!Number.isNaN(d.getTime())) createdAt.$gte = d;
      }
      if (req.query.to) {
        const d = new Date(String(req.query.to));
        if (!Number.isNaN(d.getTime())) createdAt.$lte = d;
      }
      if (Object.keys(createdAt).length > 0) and.push({ createdAt });
    }
    if (and.length > 0) {
      filter.$and = and;
    }

    const [rows, total] = await Promise.all([
      StockMovement.find(filter)
        .populate("product", "name sku")
        .populate("warehouse", "code name")
        .populate("toWarehouse", "code name")
        .populate("location", "code name type")
        .populate("toLocation", "code name type")
        .populate("createdBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockMovement.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatMovement),
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
      res.status(400).json({ message: "Invalid movement id", error: "Invalid movement id" });
      return;
    }
    const row = await StockMovement.findById(req.params.id)
      .populate("product", "name sku stockQuantity")
      .populate("warehouse", "code name")
      .populate("toWarehouse", "code name")
      .populate("location", "code name type")
      .populate("toLocation", "code name type")
      .populate("createdBy", "name email")
      .lean();
    if (!row) {
      res.status(404).json({ message: "Stock movement not found", error: "Stock movement not found" });
      return;
    }
    res.json(formatMovement(row));
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const type = (str(req.body, "type") ?? "").toLowerCase();
    if (!CREATABLE_TYPES.includes(type)) {
      res.status(400).json({
        message: `type must be one of: ${CREATABLE_TYPES.join(", ")}`,
        error: `type must be one of: ${CREATABLE_TYPES.join(", ")}`,
      });
      return;
    }

    const productParsed = parseObjectId(req.body?.productId, "productId");
    if (productParsed.error) {
      res.status(400).json({ message: productParsed.error, error: productParsed.error });
      return;
    }

    const warehouseParsed = parseObjectId(
      req.body?.warehouseId ?? req.body?.fromWarehouseId,
      "warehouseId"
    );
    if (warehouseParsed.error) {
      res.status(400).json({ message: warehouseParsed.error, error: warehouseParsed.error });
      return;
    }

    const qtyParsed = parseQuantity(req.body?.quantity, "quantity", {
      allowNegative: type === "adjustment",
    });
    if (qtyParsed.error) {
      res.status(400).json({ message: qtyParsed.error, error: qtyParsed.error });
      return;
    }

    const product = await Product.findById(productParsed.value).lean();
    if (!product) {
      res.status(404).json({ message: "Product not found", error: "Product not found" });
      return;
    }

    const warehouse = await Warehouse.findById(warehouseParsed.value).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }
    if (warehouse.status !== "active") {
      res.status(409).json({ message: "Warehouse is not active", error: "Warehouse is not active" });
      return;
    }

    const locationParsed = parseObjectId(req.body?.locationId, "locationId", {
      required: false,
    });
    if (locationParsed.error) {
      res.status(400).json({ message: locationParsed.error, error: locationParsed.error });
      return;
    }
    const locCheck = await assertLocation(locationParsed.value, warehouseParsed.value);
    if (!locCheck.ok) {
      res.status(400).json({ message: locCheck.error, error: locCheck.error });
      return;
    }

    let toWarehouseId = null;
    let toLocationId = null;
    if (type === "internal_move") {
      const toWh = parseObjectId(
        req.body?.toWarehouseId ?? req.body?.destinationWarehouseId,
        "toWarehouseId"
      );
      if (toWh.error) {
        res.status(400).json({ message: toWh.error, error: toWh.error });
        return;
      }
      const dest = await Warehouse.findById(toWh.value).lean();
      if (!dest) {
        res.status(404).json({ message: "Destination warehouse not found", error: "Destination warehouse not found" });
        return;
      }
      toWarehouseId = toWh.value;

      const toLoc = parseObjectId(req.body?.toLocationId, "toLocationId", { required: false });
      if (toLoc.error) {
        res.status(400).json({ message: toLoc.error, error: toLoc.error });
        return;
      }
      const toLocCheck = await assertLocation(toLoc.value, toWarehouseId);
      if (!toLocCheck.ok) {
        res.status(400).json({ message: toLocCheck.error, error: toLocCheck.error });
        return;
      }
      toLocationId = toLoc.value;
    }

    const syncRaw = req.body?.syncProductStock;
    const syncProductStock =
      syncRaw === false || syncRaw === "false" || syncRaw === 0 ? false : true;

    const result = await applyStockMovement({
      type,
      productId: productParsed.value,
      warehouseId: warehouseParsed.value,
      locationId: locationParsed.value,
      toWarehouseId,
      toLocationId,
      quantity: qtyParsed.value,
      quantityOverride: type === "adjustment" ? qtyParsed.value : undefined,
      notes: str(req.body, "notes") ?? "",
      referenceType: str(req.body, "referenceType") ?? "",
      referenceId:
        req.body?.referenceId && mongoose.Types.ObjectId.isValid(req.body.referenceId)
          ? req.body.referenceId
          : null,
      createdBy: req.user?._id || null,
      syncProductStock,
    });

    if (!result.ok) {
      res.status(409).json({ message: result.error, error: result.error });
      return;
    }

    const populated = await StockMovement.findById(result.movement._id)
      .populate("product", "name sku stockQuantity")
      .populate("warehouse", "code name")
      .populate("toWarehouse", "code name")
      .populate("location", "code name type")
      .populate("toLocation", "code name type")
      .lean();

    res.status(201).json({
      movement: formatMovement(populated),
      warehouseStock: result.stock,
      toWarehouseStock: result.toStock || null,
    });
  } catch (err) {
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors || {})[0]?.message || err.message;
      res.status(400).json({ message: msg, error: msg });
      return;
    }
    next(err);
  }
});

module.exports = { router };
