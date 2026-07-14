const express = require("express");
const mongoose = require("mongoose");
const Warehouse = require("../models/Warehouse");
const { WAREHOUSE_STATUSES } = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");
const {
  LOCATION_TYPES,
  STORABLE_TYPES,
  ALLOWED_PARENTS,
  PARENT_TYPE_BY_CHILD,
  LAYOUT_PRESETS,
} = require("../models/StorageLocation");
const WarehouseStock = require("../models/WarehouseStock");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
const User = require("../models/User");
const { requireAuth, requireEntitlement } = require("../middleware/auth");
const { buildLocationFullPath } = require("../utils/locationPath");
const { writeAuditLog } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("warehouses", "inventory"));

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

function str(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return String(v).trim();
  return v.trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseObjectId(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return { error: `${fieldName} is required` };
  }
  const id = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return { error: `Invalid ${fieldName}` };
  }
  return { value: id };
}

function formatWarehouse(doc) {
  if (!doc) return doc;
  return typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
}

function formatLocation(doc) {
  if (!doc) return doc;
  return typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
}

async function clearOtherDefaults(exceptId) {
  await Warehouse.updateMany(
    exceptId ? { _id: { $ne: exceptId }, isDefault: true } : { isDefault: true },
    { $set: { isDefault: false } }
  );
}

async function assertLocationBelongs(locationId, warehouseId, expectedType = null) {
  if (!locationId) return { ok: true, location: null };
  if (!mongoose.Types.ObjectId.isValid(locationId)) {
    return { ok: false, error: "Invalid location id" };
  }
  const loc = await StorageLocation.findById(locationId).lean();
  if (!loc) return { ok: false, error: "Storage location not found" };
  if (String(loc.warehouse) !== String(warehouseId)) {
    return { ok: false, error: "Storage location does not belong to this warehouse" };
  }
  if (expectedType && loc.type !== expectedType) {
    return { ok: false, error: `Location must be a ${expectedType}` };
  }
  return { ok: true, location: loc };
}

async function validateParentForType(warehouseId, type, parentId) {
  const allowed = ALLOWED_PARENTS[type];
  if (!allowed) {
    return { error: `Unknown location type: ${type}` };
  }

  if (!parentId) {
    if (!allowed.includes(null)) {
      return {
        error: `${type} requires a parent (allowed: ${allowed.filter(Boolean).join(", ")})`,
      };
    }
    return { value: null };
  }

  const check = await assertLocationBelongs(parentId, warehouseId);
  if (!check.ok) return { error: check.error };

  if (!allowed.includes(check.location.type)) {
    const opts = allowed
      .map((t) => (t === null ? "none" : t))
      .join(", ");
    return {
      error: `${type} parent must be one of: ${opts} (got ${check.location.type})`,
    };
  }

  return { value: parentId };
}

router.get("/meta", (_req, res) => {
  res.json({
    statuses: WAREHOUSE_STATUSES,
    locationTypes: LOCATION_TYPES,
    storableTypes: STORABLE_TYPES,
    allowedParents: ALLOWED_PARENTS,
    parentTypeByChild: PARENT_TYPE_BY_CHILD,
    layoutPresets: LAYOUT_PRESETS,
    recommended: "simple",
  });
});

/* ── Warehouses CRUD ─────────────────────────────────────────── */

router.post("/", async (req, res, next) => {
  try {
    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({ message: "Warehouse name is required", error: "Warehouse name is required" });
      return;
    }
    const address = str(req.body, "address") ?? "";
    if (!address) {
      res.status(400).json({ message: "Address is required", error: "Address is required" });
      return;
    }
    const city = str(req.body, "city") ?? "";
    if (!city) {
      res.status(400).json({ message: "City is required", error: "City is required" });
      return;
    }
    const phone = str(req.body, "phone") ?? "";
    if (!phone) {
      res.status(400).json({ message: "Phone is required", error: "Phone is required" });
      return;
    }
    let code = (str(req.body, "code") ?? "").toUpperCase();
    if (!code) {
      code = name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      if (!code) code = `WH-${Date.now().toString(36).toUpperCase()}`;
    }

    const isDefault =
      req.body?.isDefault === true ||
      req.body?.isDefault === "true" ||
      req.body?.isDefault === 1;

    if (isDefault) await clearOtherDefaults();

    let managerId = null;
    if (req.body?.managerId || req.body?.manager) {
      const managerParsed = parseObjectId(
        req.body?.managerId ?? req.body?.manager,
        "managerId"
      );
      if (managerParsed.error) {
        res.status(400).json({ message: managerParsed.error, error: managerParsed.error });
        return;
      }
      const manager = await User.findById(managerParsed.value).select("_id").lean();
      if (!manager) {
        res.status(404).json({ message: "Manager user not found", error: "Manager user not found" });
        return;
      }
      managerId = managerParsed.value;
    }

    const warehouse = await Warehouse.create({
      code,
      name,
      description: str(req.body, "description") ?? "",
      address,
      city,
      phone,
      manager: managerId,
      isDefault,
      status: (() => {
        const s = str(req.body, "status");
        if (!s) return "active";
        const match = WAREHOUSE_STATUSES.find((x) => x === s.toLowerCase());
        return match || "active";
      })(),
    });

    await writeAuditLog({
      action: "warehouse.created",
      entityType: "Warehouse",
      entityId: warehouse._id,
      summary: `Created warehouse ${warehouse.code} — ${warehouse.name}`,
      user: req.user,
    });

    const populated = await Warehouse.findById(warehouse._id)
      .populate("manager", "name email")
      .lean();
    res.status(201).json(formatWarehouse(populated));
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ message: "Warehouse code already exists", error: "Warehouse code already exists" });
      return;
    }
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
    if (status && WAREHOUSE_STATUSES.includes(status)) {
      filter.status = status;
    }
    const q = String(req.query.q || req.query.search || "").trim();
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: re }, { code: re }, { city: re }, { address: re }];
    }

    const [rows, total] = await Promise.all([
      Warehouse.find(filter)
        .populate("manager", "name email")
        .sort({ isDefault: -1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Warehouse.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(formatWarehouse),
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
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id)
      .populate("manager", "name email")
      .lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }
    res.json(formatWarehouse(warehouse));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const body = req.body || {};
    const updates = {};

    if (hasField(body, "name")) {
      const name = str(body, "name") ?? "";
      if (!name) {
        res.status(400).json({ message: "Warehouse name cannot be empty", error: "Warehouse name cannot be empty" });
        return;
      }
      updates.name = name;
    }
    if (hasField(body, "code")) {
      const code = (str(body, "code") ?? "").toUpperCase();
      if (!code) {
        res.status(400).json({ message: "Warehouse code cannot be empty", error: "Warehouse code cannot be empty" });
        return;
      }
      updates.code = code;
    }
    if (hasField(body, "description")) {
      updates.description = str(body, "description") ?? "";
    }
    for (const key of ["address", "city", "phone"]) {
      if (!hasField(body, key)) continue;
      const value = str(body, key) ?? "";
      if (!value) {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        res.status(400).json({
          message: `${label} cannot be empty`,
          error: `${label} cannot be empty`,
        });
        return;
      }
      updates[key] = value;
    }
    if (hasField(body, "status")) {
      const s = (str(body, "status") ?? "").toLowerCase();
      if (!WAREHOUSE_STATUSES.includes(s)) {
        res.status(400).json({
          message: `status must be one of: ${WAREHOUSE_STATUSES.join(", ")}`,
          error: `status must be one of: ${WAREHOUSE_STATUSES.join(", ")}`,
        });
        return;
      }
      updates.status = s;
    }
    if (hasField(body, "isDefault")) {
      const isDefault =
        body.isDefault === true || body.isDefault === "true" || body.isDefault === 1;
      updates.isDefault = isDefault;
      if (isDefault) await clearOtherDefaults(warehouse._id);
    }
    if (hasField(body, "managerId") || hasField(body, "manager")) {
      const raw = body.managerId ?? body.manager;
      if (raw === null || raw === "") {
        updates.manager = null;
      } else {
        const managerParsed = parseObjectId(raw, "managerId");
        if (managerParsed.error) {
          res.status(400).json({ message: managerParsed.error, error: managerParsed.error });
          return;
        }
        const manager = await User.findById(managerParsed.value).select("_id").lean();
        if (!manager) {
          res.status(404).json({ message: "Manager user not found", error: "Manager user not found" });
          return;
        }
        updates.manager = managerParsed.value;
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: "No updatable fields provided", error: "No updatable fields provided" });
      return;
    }

    Object.assign(warehouse, updates);
    try {
      await warehouse.save({ validateBeforeSave: true });
    } catch (err) {
      if (err.code === 11000) {
        res.status(409).json({ message: "Warehouse code already exists", error: "Warehouse code already exists" });
        return;
      }
      if (err.name === "ValidationError") {
        const msg = Object.values(err.errors || {})[0]?.message || err.message;
        res.status(400).json({ message: msg, error: msg });
        return;
      }
      throw err;
    }

    const populated = await Warehouse.findById(warehouse._id)
      .populate("manager", "name email")
      .lean();
    res.json(formatWarehouse(populated));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }

    const stockCount = await WarehouseStock.countDocuments({
      warehouse: req.params.id,
      quantity: { $gt: 0 },
    });
    if (stockCount > 0) {
      res.status(409).json({
        message: "Cannot delete warehouse with remaining stock",
        error: "Cannot delete warehouse with remaining stock",
      });
      return;
    }

    const removed = await Warehouse.findByIdAndDelete(req.params.id).lean();
    if (!removed) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    await StorageLocation.deleteMany({ warehouse: req.params.id });
    await WarehouseStock.deleteMany({ warehouse: req.params.id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/* ── Storage hierarchy ───────────────────────────────────────── */

router.get("/:id/locations", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const filter = { warehouse: req.params.id };
    const type = String(req.query.type || "").trim().toLowerCase();
    if (type && LOCATION_TYPES.includes(type)) filter.type = type;
    if (req.query.parentId !== undefined) {
      const pid = String(req.query.parentId || "").trim();
      filter.parent = pid && mongoose.Types.ObjectId.isValid(pid) ? pid : null;
    }

    const rows = await StorageLocation.find(filter).sort({ type: 1, code: 1 }).lean();
    res.json({ items: rows.map(formatLocation), warehouse: formatWarehouse(warehouse) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/structure", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const locations = await StorageLocation.find({ warehouse: req.params.id })
      .sort({ code: 1 })
      .lean();

    const byId = new Map(locations.map((l) => [String(l._id), { ...l, children: [] }]));
    const roots = [];
    for (const loc of byId.values()) {
      if (loc.parent && byId.has(String(loc.parent))) {
        byId.get(String(loc.parent)).children.push(loc);
      } else {
        roots.push(loc);
      }
    }

    res.json({
      warehouse: formatWarehouse(warehouse),
      structure: roots,
      flat: locations.map(formatLocation),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/locations", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const type = (str(req.body, "type") ?? "").toLowerCase();
    if (!LOCATION_TYPES.includes(type)) {
      res.status(400).json({
        message: `type must be one of: ${LOCATION_TYPES.join(", ")}`,
        error: `type must be one of: ${LOCATION_TYPES.join(", ")}`,
      });
      return;
    }

    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({ message: "Location name is required", error: "Location name is required" });
      return;
    }

    let code = (str(req.body, "code") ?? "").toUpperCase();
    if (!code) {
      code = name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
    }

    const parentRaw = req.body?.parentId ?? req.body?.parent ?? null;
    const parentCheck = await validateParentForType(
      req.params.id,
      type,
      parentRaw ? String(parentRaw).trim() : null
    );
    if (parentCheck.error) {
      res.status(400).json({ message: parentCheck.error, error: parentCheck.error });
      return;
    }

    const fullPath = await buildLocationFullPath(
      req.params.id,
      code,
      parentCheck.value
    );

    const loc = await StorageLocation.create({
      warehouse: req.params.id,
      type,
      parent: parentCheck.value,
      code,
      fullPath,
      name,
      description: str(req.body, "description") ?? "",
      isActive: req.body?.isActive === false || req.body?.isActive === "false" ? false : true,
    });

    res.status(201).json(formatLocation(loc));
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({
        message: "Location code already exists in this warehouse",
        error: "Location code already exists in this warehouse",
      });
      return;
    }
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors || {})[0]?.message || err.message;
      res.status(400).json({ message: msg, error: msg });
      return;
    }
    next(err);
  }
});

router.patch("/:id/locations/:locationId", async (req, res, next) => {
  try {
    if (
      !mongoose.Types.ObjectId.isValid(req.params.id) ||
      !mongoose.Types.ObjectId.isValid(req.params.locationId)
    ) {
      res.status(400).json({ message: "Invalid id", error: "Invalid id" });
      return;
    }

    const loc = await StorageLocation.findOne({
      _id: req.params.locationId,
      warehouse: req.params.id,
    });
    if (!loc) {
      res.status(404).json({ message: "Storage location not found", error: "Storage location not found" });
      return;
    }

    const body = req.body || {};
    if (hasField(body, "name")) {
      const name = str(body, "name") ?? "";
      if (!name) {
        res.status(400).json({ message: "Location name cannot be empty", error: "Location name cannot be empty" });
        return;
      }
      loc.name = name;
    }
    if (hasField(body, "code")) {
      const code = (str(body, "code") ?? "").toUpperCase();
      if (!code) {
        res.status(400).json({ message: "Location code cannot be empty", error: "Location code cannot be empty" });
        return;
      }
      loc.code = code;
    }
    if (hasField(body, "description")) loc.description = str(body, "description") ?? "";
    if (hasField(body, "isActive")) {
      loc.isActive = !(body.isActive === false || body.isActive === "false" || body.isActive === 0);
    }
    if (hasField(body, "parentId") || hasField(body, "parent")) {
      const parentRaw = body.parentId ?? body.parent ?? null;
      const parentCheck = await validateParentForType(
        req.params.id,
        loc.type,
        parentRaw ? String(parentRaw).trim() : null
      );
      if (parentCheck.error) {
        res.status(400).json({ message: parentCheck.error, error: parentCheck.error });
        return;
      }
      loc.parent = parentCheck.value;
    }

    if (hasField(body, "code") || hasField(body, "parentId") || hasField(body, "parent")) {
      loc.fullPath = await buildLocationFullPath(
        req.params.id,
        loc.code,
        loc.parent
      );
    }

    try {
      await loc.save({ validateBeforeSave: true });
    } catch (err) {
      if (err.code === 11000) {
        res.status(409).json({
          message: "Location code already exists in this warehouse",
          error: "Location code already exists in this warehouse",
        });
        return;
      }
      throw err;
    }

    res.json(formatLocation(loc));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/locations/:locationId", async (req, res, next) => {
  try {
    if (
      !mongoose.Types.ObjectId.isValid(req.params.id) ||
      !mongoose.Types.ObjectId.isValid(req.params.locationId)
    ) {
      res.status(400).json({ message: "Invalid id", error: "Invalid id" });
      return;
    }

    const childCount = await StorageLocation.countDocuments({
      parent: req.params.locationId,
    });
    if (childCount > 0) {
      res.status(409).json({
        message: "Cannot delete location with child locations",
        error: "Cannot delete location with child locations",
      });
      return;
    }

    const stockCount = await WarehouseStock.countDocuments({
      location: req.params.locationId,
      quantity: { $gt: 0 },
    });
    if (stockCount > 0) {
      res.status(409).json({
        message: "Cannot delete location with assigned stock",
        error: "Cannot delete location with assigned stock",
      });
      return;
    }

    const removed = await StorageLocation.findOneAndDelete({
      _id: req.params.locationId,
      warehouse: req.params.id,
    }).lean();
    if (!removed) {
      res.status(404).json({ message: "Storage location not found", error: "Storage location not found" });
      return;
    }

    await WarehouseStock.updateMany(
      { location: req.params.locationId },
      { $set: { location: null } }
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/* ── Inventory & product assignment ──────────────────────────── */

router.get("/:id/inventory", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const filter = { warehouse: req.params.id };
    if (req.query.productId && mongoose.Types.ObjectId.isValid(req.query.productId)) {
      filter.product = req.query.productId;
    }
    if (req.query.locationId && mongoose.Types.ObjectId.isValid(req.query.locationId)) {
      filter.location = req.query.locationId;
    }
    if (req.query.inStock === "true" || req.query.inStock === "1") {
      filter.quantity = { $gt: 0 };
    }

    const [rows, total] = await Promise.all([
      WarehouseStock.find(filter)
        .populate("product", "name sku stockQuantity unit sellingPrice barcode reorderAt maxStock")
        .populate("location", "code name type fullPath")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WarehouseStock.countDocuments(filter),
    ]);

    res.json({
      warehouse: formatWarehouse(warehouse),
      items: rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/history", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {
      $or: [{ warehouse: req.params.id }, { toWarehouse: req.params.id }],
    };
    if (req.query.productId && mongoose.Types.ObjectId.isValid(req.query.productId)) {
      filter.product = req.query.productId;
    }
    if (req.query.type) {
      filter.type = String(req.query.type).trim();
    }

    const [rows, total] = await Promise.all([
      StockMovement.find(filter)
        .populate("product", "name sku")
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
      warehouse: formatWarehouse(warehouse),
      items: rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
});

/** Assign (or clear) a product's storage location within a warehouse */
router.post("/:id/assign-location", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid warehouse id", error: "Invalid warehouse id" });
      return;
    }
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      res.status(404).json({ message: "Warehouse not found", error: "Warehouse not found" });
      return;
    }

    const productParsed = parseObjectId(req.body?.productId, "productId");
    if (productParsed.error) {
      res.status(400).json({ message: productParsed.error, error: productParsed.error });
      return;
    }

    const product = await Product.findById(productParsed.value).lean();
    if (!product) {
      res.status(404).json({ message: "Product not found", error: "Product not found" });
      return;
    }

    let locationId = null;
    if (hasField(req.body, "locationId") && req.body.locationId) {
      const check = await assertLocationBelongs(String(req.body.locationId), req.params.id);
      if (!check.ok) {
        res.status(400).json({ message: check.error, error: check.error });
        return;
      }
      locationId = check.location._id;
    }

    let stock = await WarehouseStock.findOne({
      warehouse: req.params.id,
      product: productParsed.value,
    });

    if (!stock) {
      stock = await WarehouseStock.create({
        warehouse: req.params.id,
        product: productParsed.value,
        quantity: 0,
        location: locationId,
      });
    } else {
      stock.location = locationId;
      await stock.save();
    }

    const populated = await WarehouseStock.findById(stock._id)
      .populate("product", "name sku stockQuantity")
      .populate("location", "code name type")
      .lean();

    res.json(populated);
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
