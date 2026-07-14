const GoodsReceipt = require("../models/GoodsReceipt");
const Approval = require("../models/Approval");
const { applyStockMovement } = require("./warehouseStock");
const { nextApprovalNumber } = require("./transfers");
const { writeAuditLog } = require("./auditLog");

async function nextReceiptNumber() {
  const docs = await GoodsReceipt.find({ receiptNumber: /^GR-\d+$/i })
    .select("receiptNumber")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.receiptNumber).slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `GR-${String(max + 1).padStart(5, "0")}`;
}

function formatReceipt(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of ["approvedAt", "rejectedAt", "cancelledAt", "createdAt", "updatedAt"]) {
    if (o[key] instanceof Date) o[key] = o[key].toISOString();
  }
  return o;
}

async function submitReceipt(receipt, userId) {
  if (receipt.status !== "draft") {
    return {
      ok: false,
      status: 409,
      error: `Only draft receipts can be submitted (current: ${receipt.status})`,
    };
  }

  const lineCount = receipt.lines.length;
  const totalQty = receipt.lines.reduce((s, l) => s + Number(l.quantity), 0);

  const approval = await Approval.create({
    approvalNumber: await nextApprovalNumber(),
    type: "goods_receipt",
    status: "pending",
    title: `Goods receipt ${receipt.receiptNumber}`,
    description: `${lineCount} line(s), ${totalQty} unit(s)`,
    entityType: "GoodsReceipt",
    entityId: receipt._id,
    payload: {
      receiptNumber: receipt.receiptNumber,
      warehouse: receipt.warehouse,
      lineCount,
      totalQty,
    },
    requestedBy: userId || receipt.receivedBy || null,
  });

  receipt.status = "pending_approval";
  receipt.approval = approval._id;
  if (userId) receipt.receivedBy = userId;
  await receipt.save();

  await writeAuditLog({
    action: "goods_receipt.submitted",
    entityType: "GoodsReceipt",
    entityId: receipt._id,
    summary: `Submitted ${receipt.receiptNumber} for approval`,
    user: userId,
  });

  return { ok: true, receipt, approval };
}

async function approveReceipt(receipt, userId, reviewNotes = "") {
  if (receipt.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval receipts can be approved (current: ${receipt.status})`,
    };
  }
  if (receipt.stockApplied) {
    return { ok: false, status: 409, error: "Stock already applied for this receipt" };
  }

  const applied = [];
  try {
    for (const line of receipt.lines) {
      const result = await applyStockMovement({
        type: "stock_in",
        productId: line.product,
        warehouseId: receipt.warehouse,
        locationId: line.location || null,
        quantity: line.quantity,
        notes: `Goods receipt ${receipt.receiptNumber}`,
        referenceType: "GoodsReceipt",
        referenceId: receipt._id,
        createdBy: userId,
        syncProductStock: true,
      });
      if (!result.ok) {
        for (const a of applied.reverse()) {
          await applyStockMovement({
            type: "stock_out",
            productId: a.productId,
            warehouseId: receipt.warehouse,
            locationId: a.locationId,
            quantity: a.quantity,
            notes: `Rollback goods receipt ${receipt.receiptNumber}`,
            referenceType: "GoodsReceipt",
            referenceId: receipt._id,
            createdBy: userId,
            syncProductStock: true,
          });
        }
        return { ok: false, status: 409, error: result.error };
      }
      applied.push({
        productId: line.product,
        quantity: line.quantity,
        locationId: line.location || null,
      });
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || "Failed to apply receipt stock" };
  }

  receipt.status = "completed";
  receipt.approvedBy = userId || null;
  receipt.approvedAt = new Date();
  receipt.stockApplied = true;
  await receipt.save();

  if (receipt.approval) {
    await Approval.findByIdAndUpdate(receipt.approval, {
      status: "approved",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes || "",
    });
  }

  await writeAuditLog({
    action: "goods_receipt.approved",
    entityType: "GoodsReceipt",
    entityId: receipt._id,
    summary: `Approved ${receipt.receiptNumber} — inventory updated`,
    user: userId,
  });

  return { ok: true, receipt };
}

async function rejectReceipt(receipt, userId, reason = "") {
  if (receipt.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval receipts can be rejected (current: ${receipt.status})`,
    };
  }

  receipt.status = "rejected";
  receipt.rejectedBy = userId || null;
  receipt.rejectedAt = new Date();
  receipt.rejectionReason = reason || "";
  await receipt.save();

  if (receipt.approval) {
    await Approval.findByIdAndUpdate(receipt.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reason || "",
    });
  }

  await writeAuditLog({
    action: "goods_receipt.rejected",
    entityType: "GoodsReceipt",
    entityId: receipt._id,
    summary: `Rejected ${receipt.receiptNumber}`,
    metadata: { reason },
    user: userId,
  });

  return { ok: true, receipt };
}

async function cancelReceipt(receipt, userId) {
  if (!["draft", "pending_approval"].includes(receipt.status)) {
    return {
      ok: false,
      status: 409,
      error: `Cannot cancel a ${receipt.status} receipt`,
    };
  }

  if (receipt.approval && receipt.status === "pending_approval") {
    await Approval.findByIdAndUpdate(receipt.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: "Goods receipt cancelled",
    });
  }

  receipt.status = "cancelled";
  receipt.cancelledAt = new Date();
  receipt.cancelledBy = userId || null;
  await receipt.save();

  await writeAuditLog({
    action: "goods_receipt.cancelled",
    entityType: "GoodsReceipt",
    entityId: receipt._id,
    summary: `Cancelled ${receipt.receiptNumber}`,
    user: userId,
  });

  return { ok: true, receipt };
}

module.exports = {
  nextReceiptNumber,
  formatReceipt,
  submitReceipt,
  approveReceipt,
  rejectReceipt,
  cancelReceipt,
};
