const StockTransfer = require("../models/StockTransfer");
const Approval = require("../models/Approval");
const { applyStockMovement } = require("./warehouseStock");

async function nextTransferNumber() {
  const docs = await StockTransfer.find({ transferNumber: /^WT-\d+$/i })
    .select("transferNumber")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.transferNumber).slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `WT-${String(max + 1).padStart(5, "0")}`;
}

async function nextApprovalNumber() {
  const docs = await Approval.find({ approvalNumber: /^AP-\d+$/i })
    .select("approvalNumber")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.approvalNumber).slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `AP-${String(max + 1).padStart(5, "0")}`;
}

function formatTransfer(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of ["approvedAt", "rejectedAt", "shippedAt", "receivedAt", "cancelledAt", "createdAt", "updatedAt"]) {
    if (o[key] instanceof Date) {
      o[key] = o[key].toISOString();
    }
  }
  return o;
}

/**
 * Submit draft transfer → pending_approval + create Approvals Hub entry.
 */
async function submitTransfer(transfer, userId) {
  if (transfer.status !== "draft") {
    return {
      ok: false,
      status: 409,
      error: `Only draft transfers can be submitted (current: ${transfer.status})`,
    };
  }

  const approvalNumber = await nextApprovalNumber();
  const lineCount = transfer.lines.length;
  const totalQty = transfer.lines.reduce((s, l) => s + Number(l.quantity), 0);

  const approval = await Approval.create({
    approvalNumber,
    type: "warehouse_transfer",
    status: "pending",
    title: `Warehouse transfer ${transfer.transferNumber}`,
    description: `${lineCount} line(s), ${totalQty} unit(s)`,
    entityType: "StockTransfer",
    entityId: transfer._id,
    payload: {
      transferNumber: transfer.transferNumber,
      fromWarehouse: transfer.fromWarehouse,
      toWarehouse: transfer.toWarehouse,
      lineCount,
      totalQty,
    },
    requestedBy: userId || transfer.requestedBy || null,
  });

  transfer.status = "pending_approval";
  transfer.approval = approval._id;
  if (userId) transfer.requestedBy = userId;
  await transfer.save();

  return { ok: true, transfer, approval };
}

/**
 * Approve pending transfer → in_transit and deduct source stock.
 */
async function approveTransfer(transfer, userId, reviewNotes = "") {
  if (transfer.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval transfers can be approved (current: ${transfer.status})`,
    };
  }

  const applied = [];
  try {
    for (const line of transfer.lines) {
      const result = await applyStockMovement({
        type: "transfer_out",
        productId: line.product,
        warehouseId: transfer.fromWarehouse,
        locationId: line.fromLocation || null,
        quantity: line.quantity,
        notes: `Transfer ${transfer.transferNumber} out`,
        referenceType: "StockTransfer",
        referenceId: transfer._id,
        createdBy: userId,
        syncProductStock: false,
      });
      if (!result.ok) {
        for (const a of applied.reverse()) {
          await applyStockMovement({
            type: "transfer_in",
            productId: a.productId,
            warehouseId: transfer.fromWarehouse,
            locationId: a.locationId,
            quantity: a.quantity,
            notes: `Rollback transfer ${transfer.transferNumber}`,
            referenceType: "StockTransfer",
            referenceId: transfer._id,
            createdBy: userId,
            syncProductStock: false,
          });
        }
        return { ok: false, status: 409, error: result.error };
      }
      applied.push({
        productId: line.product,
        quantity: line.quantity,
        locationId: line.fromLocation || null,
      });
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || "Failed to deduct stock" };
  }

  transfer.status = "in_transit";
  transfer.approvedBy = userId || null;
  transfer.approvedAt = new Date();
  transfer.shippedAt = new Date();
  transfer.stockDeducted = true;
  await transfer.save();

  if (transfer.approval) {
    await Approval.findByIdAndUpdate(transfer.approval, {
      status: "approved",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes || "",
    });
  }

  return { ok: true, transfer };
}

/**
 * Reject pending transfer.
 */
async function rejectTransfer(transfer, userId, reason = "") {
  if (transfer.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval transfers can be rejected (current: ${transfer.status})`,
    };
  }

  transfer.status = "cancelled";
  transfer.rejectedBy = userId || null;
  transfer.rejectedAt = new Date();
  transfer.rejectionReason = reason || "";
  transfer.cancelledAt = new Date();
  transfer.cancelledBy = userId || null;
  await transfer.save();

  if (transfer.approval) {
    await Approval.findByIdAndUpdate(transfer.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reason || "",
    });
  }

  return { ok: true, transfer };
}

/**
 * Receive in-transit transfer → credit destination stock.
 */
async function receiveTransfer(transfer, userId) {
  if (transfer.status !== "in_transit") {
    return {
      ok: false,
      status: 409,
      error: `Only in_transit transfers can be received (current: ${transfer.status})`,
    };
  }
  if (!transfer.stockDeducted) {
    return {
      ok: false,
      status: 409,
      error: "Transfer stock was not deducted; cannot receive",
    };
  }

  const applied = [];
  try {
    for (const line of transfer.lines) {
      const result = await applyStockMovement({
        type: "transfer_in",
        productId: line.product,
        warehouseId: transfer.toWarehouse,
        locationId: line.toLocation || null,
        quantity: line.quantity,
        notes: `Transfer ${transfer.transferNumber} in`,
        referenceType: "StockTransfer",
        referenceId: transfer._id,
        createdBy: userId,
        syncProductStock: false,
      });
      if (!result.ok) {
        for (const a of applied.reverse()) {
          await applyStockMovement({
            type: "transfer_out",
            productId: a.productId,
            warehouseId: transfer.toWarehouse,
            locationId: a.locationId,
            quantity: a.quantity,
            notes: `Rollback receive ${transfer.transferNumber}`,
            referenceType: "StockTransfer",
            referenceId: transfer._id,
            createdBy: userId,
            syncProductStock: false,
          });
        }
        return { ok: false, status: 409, error: result.error };
      }
      applied.push({
        productId: line.product,
        quantity: line.quantity,
        locationId: line.toLocation || null,
      });
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || "Failed to receive stock" };
  }

  transfer.status = "received";
  transfer.receivedAt = new Date();
  transfer.receivedBy = userId || null;
  transfer.stockReceived = true;
  await transfer.save();

  return { ok: true, transfer };
}

/**
 * Cancel draft or pending transfer (not in_transit — restore stock first if needed).
 */
async function cancelTransfer(transfer, userId) {
  if (transfer.status === "received" || transfer.status === "cancelled") {
    return {
      ok: false,
      status: 409,
      error: `Cannot cancel a ${transfer.status} transfer`,
    };
  }

  if (transfer.status === "in_transit" && transfer.stockDeducted) {
    for (const line of transfer.lines) {
      const result = await applyStockMovement({
        type: "transfer_in",
        productId: line.product,
        warehouseId: transfer.fromWarehouse,
        locationId: line.fromLocation || null,
        quantity: line.quantity,
        notes: `Cancel transfer ${transfer.transferNumber} — restore source`,
        referenceType: "StockTransfer",
        referenceId: transfer._id,
        createdBy: userId,
        syncProductStock: false,
      });
      if (!result.ok) {
        return { ok: false, status: 409, error: result.error };
      }
    }
    transfer.stockDeducted = false;
  }

  if (transfer.approval && transfer.status === "pending_approval") {
    await Approval.findByIdAndUpdate(transfer.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: "Transfer cancelled",
    });
  }

  transfer.status = "cancelled";
  transfer.cancelledAt = new Date();
  transfer.cancelledBy = userId || null;
  await transfer.save();

  return { ok: true, transfer };
}

module.exports = {
  nextTransferNumber,
  nextApprovalNumber,
  formatTransfer,
  submitTransfer,
  approveTransfer,
  rejectTransfer,
  receiveTransfer,
  cancelTransfer,
};
