const StockCount = require("../models/StockCount");
const Approval = require("../models/Approval");
const WarehouseStock = require("../models/WarehouseStock");
const { applyStockMovement } = require("./warehouseStock");
const { nextApprovalNumber } = require("./transfers");
const { writeAuditLog } = require("./auditLog");

async function nextCountNumber() {
  const docs = await StockCount.find({ countNumber: /^SC-\d+$/i })
    .select("countNumber")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.countNumber).slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `SC-${String(max + 1).padStart(5, "0")}`;
}

function formatCount(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of ["approvedAt", "cancelledAt", "createdAt", "updatedAt"]) {
    if (o[key] instanceof Date) o[key] = o[key].toISOString();
  }
  return o;
}

async function snapshotSystemQuantities(warehouseId, locationId = null) {
  const filter = { warehouse: warehouseId };
  if (locationId) filter.location = locationId;
  const stocks = await WarehouseStock.find(filter).lean();
  return stocks.map((s) => ({
    product: s.product,
    location: s.location || null,
    systemQuantity: s.quantity,
    countedQuantity: null,
    variance: null,
    reason: "",
  }));
}

async function submitCount(count, userId) {
  if (!["draft", "counting"].includes(count.status)) {
    return {
      ok: false,
      status: 409,
      error: `Only draft/counting sessions can be submitted (current: ${count.status})`,
    };
  }

  const missing = count.lines.filter(
    (l) => l.countedQuantity === null || l.countedQuantity === undefined
  );
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `${missing.length} line(s) still need a counted quantity`,
    };
  }

  for (const line of count.lines) {
    line.variance = Number(line.countedQuantity) - Number(line.systemQuantity);
  }

  const variances = count.lines.filter((l) => Number(l.variance) !== 0);
  const lineCount = variances.length;
  const totalAbs = variances.reduce((s, l) => s + Math.abs(Number(l.variance)), 0);

  const approval = await Approval.create({
    approvalNumber: await nextApprovalNumber(),
    type: "stock_count",
    status: "pending",
    title: `Stock count ${count.countNumber}`,
    description:
      lineCount === 0
        ? "No variances — confirm count"
        : `${lineCount} variance line(s), |Δ| ${totalAbs} unit(s)`,
    entityType: "StockCount",
    entityId: count._id,
    payload: {
      countNumber: count.countNumber,
      warehouse: count.warehouse,
      varianceLines: lineCount,
      totalAbsVariance: totalAbs,
    },
    requestedBy: userId || count.countedBy || count.createdBy || null,
  });

  count.status = "pending_approval";
  count.approval = approval._id;
  if (userId) count.countedBy = userId;
  await count.save();

  await writeAuditLog({
    action: "stock_count.submitted",
    entityType: "StockCount",
    entityId: count._id,
    summary: `Submitted ${count.countNumber} for approval`,
    user: userId,
  });

  return { ok: true, count, approval };
}

async function approveCount(count, userId, reviewNotes = "") {
  if (count.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval counts can be approved (current: ${count.status})`,
    };
  }
  if (count.stockApplied) {
    return { ok: false, status: 409, error: "Adjustments already applied for this count" };
  }

  const applied = [];
  try {
    for (const line of count.lines) {
      const variance = Number(line.variance);
      if (!Number.isFinite(variance) || variance === 0) continue;

      const result = await applyStockMovement({
        type: "adjustment",
        productId: line.product,
        warehouseId: count.warehouse,
        locationId: line.location || null,
        quantity: variance,
        quantityOverride: variance,
        notes:
          line.reason ||
          `Stock count ${count.countNumber} (system ${line.systemQuantity} → counted ${line.countedQuantity})`,
        referenceType: "StockCount",
        referenceId: count._id,
        createdBy: userId,
        syncProductStock: true,
      });
      if (!result.ok) {
        for (const a of applied.reverse()) {
          await applyStockMovement({
            type: "adjustment",
            productId: a.productId,
            warehouseId: count.warehouse,
            locationId: a.locationId,
            quantity: -a.variance,
            quantityOverride: -a.variance,
            notes: `Rollback stock count ${count.countNumber}`,
            referenceType: "StockCount",
            referenceId: count._id,
            createdBy: userId,
            syncProductStock: true,
          });
        }
        return { ok: false, status: 409, error: result.error };
      }
      applied.push({
        productId: line.product,
        locationId: line.location || null,
        variance,
      });
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || "Failed to apply count adjustments" };
  }

  count.status = "completed";
  count.approvedBy = userId || null;
  count.approvedAt = new Date();
  count.stockApplied = true;
  await count.save();

  if (count.approval) {
    await Approval.findByIdAndUpdate(count.approval, {
      status: "approved",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes || "",
    });
  }

  await writeAuditLog({
    action: "stock_count.approved",
    entityType: "StockCount",
    entityId: count._id,
    summary: `Approved ${count.countNumber} — adjustments applied`,
    user: userId,
  });

  return { ok: true, count };
}

async function rejectCount(count, userId, reason = "") {
  if (count.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval counts can be rejected (current: ${count.status})`,
    };
  }

  // Return to counting so corrections can be made
  count.status = "counting";
  await count.save();

  if (count.approval) {
    await Approval.findByIdAndUpdate(count.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reason || "",
    });
    count.approval = null;
    await count.save();
  }

  await writeAuditLog({
    action: "stock_count.rejected",
    entityType: "StockCount",
    entityId: count._id,
    summary: `Rejected ${count.countNumber} — returned to counting`,
    metadata: { reason },
    user: userId,
  });

  return { ok: true, count };
}

async function cancelCount(count, userId) {
  if (!["draft", "counting", "pending_approval"].includes(count.status)) {
    return {
      ok: false,
      status: 409,
      error: `Cannot cancel a ${count.status} count`,
    };
  }

  if (count.approval && count.status === "pending_approval") {
    await Approval.findByIdAndUpdate(count.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: "Stock count cancelled",
    });
  }

  count.status = "cancelled";
  count.cancelledAt = new Date();
  count.cancelledBy = userId || null;
  await count.save();

  await writeAuditLog({
    action: "stock_count.cancelled",
    entityType: "StockCount",
    entityId: count._id,
    summary: `Cancelled ${count.countNumber}`,
    user: userId,
  });

  return { ok: true, count };
}

module.exports = {
  nextCountNumber,
  formatCount,
  snapshotSystemQuantities,
  submitCount,
  approveCount,
  rejectCount,
  cancelCount,
};
