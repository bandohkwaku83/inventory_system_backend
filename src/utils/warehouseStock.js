const Product = require("../models/Product");
const WarehouseStock = require("../models/WarehouseStock");
const StockMovement = require("../models/StockMovement");
const {
  INBOUND_TYPES,
  OUTBOUND_TYPES,
} = require("../models/StockMovement");

async function nextMovementNumber() {
  const docs = await StockMovement.find({ movementNumber: /^SM-\d+$/i })
    .select("movementNumber")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.movementNumber).slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `SM-${String(max + 1).padStart(5, "0")}`;
}

/**
 * Atomically adjust warehouse stock for a product.
 * @param {{ warehouseId, productId, delta, locationId?, allowCreate? }}
 */
async function adjustWarehouseStock({
  warehouseId,
  productId,
  delta,
  locationId = undefined,
  allowCreate = true,
}) {
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: "Quantity delta must be a non-zero number" };
  }

  const filter = { warehouse: warehouseId, product: productId };

  if (delta < 0) {
    const updated = await WarehouseStock.findOneAndUpdate(
      { ...filter, quantity: { $gte: Math.abs(delta) } },
      {
        $inc: { quantity: delta },
        ...(locationId !== undefined
          ? { $set: { location: locationId || null } }
          : {}),
      },
      { new: true }
    );
    if (!updated) {
      const existing = await WarehouseStock.findOne(filter).lean();
      if (!existing) {
        return { ok: false, error: "No warehouse stock found for this product" };
      }
      return {
        ok: false,
        error: `Insufficient warehouse stock (available: ${existing.quantity})`,
      };
    }
    return { ok: true, stock: updated };
  }

  // positive delta
  let updated = await WarehouseStock.findOneAndUpdate(
    filter,
    {
      $inc: { quantity: delta },
      ...(locationId !== undefined
        ? { $set: { location: locationId || null } }
        : {}),
    },
    { new: true }
  );

  if (!updated && allowCreate) {
    try {
      updated = await WarehouseStock.create({
        warehouse: warehouseId,
        product: productId,
        quantity: delta,
        location: locationId || null,
      });
    } catch (err) {
      if (err.code === 11000) {
        updated = await WarehouseStock.findOneAndUpdate(
          filter,
          {
            $inc: { quantity: delta },
            ...(locationId !== undefined
              ? { $set: { location: locationId || null } }
              : {}),
          },
          { new: true }
        );
      } else {
        throw err;
      }
    }
  }

  if (!updated) {
    return { ok: false, error: "Failed to update warehouse stock" };
  }
  return { ok: true, stock: updated };
}

async function syncProductStockQuantity(productId, delta) {
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: true };
  }

  if (delta < 0) {
    const updated = await Product.findOneAndUpdate(
      { _id: productId, stockQuantity: { $gte: Math.abs(delta) } },
      { $inc: { stockQuantity: delta } },
      { new: true }
    ).lean();
    if (!updated) {
      const p = await Product.findById(productId).select("name stockQuantity").lean();
      return {
        ok: false,
        error: `Insufficient live product stock for ${p?.name || "product"}`,
      };
    }
    return { ok: true, product: updated };
  }

  const updated = await Product.findOneAndUpdate(
    { _id: productId },
    { $inc: { stockQuantity: delta } },
    { new: true }
  ).lean();
  if (!updated) {
    return { ok: false, error: "Product not found" };
  }
  return { ok: true, product: updated };
}

function resolveDeltaForType(type, quantity) {
  const qty = Math.abs(Number(quantity));
  if (INBOUND_TYPES.has(type)) {
    return qty;
  }
  if (OUTBOUND_TYPES.has(type)) {
    return -qty;
  }
  if (type === "adjustment") {
    // signed quantity provided by caller
    return Number(quantity);
  }
  if (type === "internal_move") {
    return -Math.abs(qty);
  }
  return null;
}

/**
 * Record a stock movement and apply warehouse (+ optional product) stock changes.
 */
async function applyStockMovement({
  type,
  productId,
  warehouseId,
  locationId = null,
  toWarehouseId = null,
  toLocationId = null,
  quantity,
  notes = "",
  referenceType = "",
  referenceId = null,
  createdBy = null,
  syncProductStock = true,
  /** For adjustment: signed delta. For others: positive quantity. */
  quantityOverride = undefined,
}) {
  const qty =
    quantityOverride !== undefined ? Number(quantityOverride) : Number(quantity);
  if (!Number.isFinite(qty)) {
    return { ok: false, error: "quantity must be a number" };
  }

  let delta;
  if (type === "adjustment") {
    delta = qty;
    if (delta === 0) {
      return { ok: false, error: "adjustment quantity cannot be zero" };
    }
  } else {
    delta = resolveDeltaForType(type, qty);
    if (delta === null) {
      return { ok: false, error: `Unsupported movement type: ${type}` };
    }
    if (Math.abs(delta) <= 0) {
      return { ok: false, error: "quantity must be greater than zero" };
    }
  }

  const absQty = Math.abs(delta);

  // Product stock sync: transfers / internal moves do not change global total
  const affectsProduct =
    syncProductStock &&
    type !== "transfer_out" &&
    type !== "transfer_in" &&
    type !== "internal_move";

  if (affectsProduct) {
    const prod = await syncProductStockQuantity(productId, delta);
    if (!prod.ok) {
      return prod;
    }
  }

  const wh = await adjustWarehouseStock({
    warehouseId,
    productId,
    delta,
    locationId: locationId !== undefined ? locationId : undefined,
  });
  if (!wh.ok) {
    if (affectsProduct) {
      await syncProductStockQuantity(productId, -delta);
    }
    return wh;
  }

  let toStock = null;
  if (type === "internal_move") {
    if (!toWarehouseId) {
      await adjustWarehouseStock({
        warehouseId,
        productId,
        delta: -delta,
      });
      if (affectsProduct) {
        await syncProductStockQuantity(productId, -delta);
      }
      return { ok: false, error: "toWarehouse is required for internal_move" };
    }
    const dest = await adjustWarehouseStock({
      warehouseId: toWarehouseId,
      productId,
      delta: absQty,
      locationId: toLocationId !== undefined ? toLocationId : undefined,
    });
    if (!dest.ok) {
      await adjustWarehouseStock({
        warehouseId,
        productId,
        delta: -delta,
      });
      return dest;
    }
    toStock = dest.stock;
  }

  const movementNumber = await nextMovementNumber();
  const movement = await StockMovement.create({
    movementNumber,
    type,
    product: productId,
    warehouse: warehouseId,
    location: locationId || null,
    toWarehouse: toWarehouseId || null,
    toLocation: toLocationId || null,
    quantity: absQty,
    quantityDelta: delta,
    balanceAfter: wh.stock.quantity,
    notes: notes || "",
    referenceType: referenceType || "",
    referenceId: referenceId || null,
    createdBy: createdBy || null,
    syncProductStock: affectsProduct,
  });

  return {
    ok: true,
    movement,
    stock: wh.stock,
    toStock,
  };
}

async function getWarehouseStock(warehouseId, productId) {
  return WarehouseStock.findOne({
    warehouse: warehouseId,
    product: productId,
  });
}

module.exports = {
  nextMovementNumber,
  adjustWarehouseStock,
  syncProductStockQuantity,
  applyStockMovement,
  getWarehouseStock,
  resolveDeltaForType,
};
