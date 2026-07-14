const GoodsIssue = require("../models/GoodsIssue");
const Approval = require("../models/Approval");
const { applyStockMovement } = require("./warehouseStock");
const { nextApprovalNumber } = require("./transfers");
const { writeAuditLog } = require("./auditLog");

async function nextIssueNumber() {
  const docs = await GoodsIssue.find({ issueNumber: /^GI-\d+$/i })
    .select("issueNumber")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.issueNumber).slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `GI-${String(max + 1).padStart(5, "0")}`;
}

function formatIssue(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of [
    "approvedAt",
    "rejectedAt",
    "issuedAt",
    "cancelledAt",
    "createdAt",
    "updatedAt",
  ]) {
    if (o[key] instanceof Date) o[key] = o[key].toISOString();
  }
  return o;
}

async function submitIssue(issue, userId) {
  if (issue.status !== "draft") {
    return {
      ok: false,
      status: 409,
      error: `Only draft issues can be submitted (current: ${issue.status})`,
    };
  }

  const lineCount = issue.lines.length;
  const totalQty = issue.lines.reduce((s, l) => s + Number(l.quantity), 0);

  const approval = await Approval.create({
    approvalNumber: await nextApprovalNumber(),
    type: "goods_issue",
    status: "pending",
    title: `Goods issue ${issue.issueNumber}`,
    description: issue.purpose
      ? `${issue.purpose} — ${lineCount} line(s), ${totalQty} unit(s)`
      : `${lineCount} line(s), ${totalQty} unit(s)`,
    entityType: "GoodsIssue",
    entityId: issue._id,
    payload: {
      issueNumber: issue.issueNumber,
      warehouse: issue.warehouse,
      lineCount,
      totalQty,
      purpose: issue.purpose || "",
    },
    requestedBy: userId || issue.requestedBy || null,
  });

  issue.status = "pending_approval";
  issue.approval = approval._id;
  if (userId) issue.requestedBy = userId;
  await issue.save();

  await writeAuditLog({
    action: "goods_issue.submitted",
    entityType: "GoodsIssue",
    entityId: issue._id,
    summary: `Submitted ${issue.issueNumber} for approval`,
    user: userId,
  });

  return { ok: true, issue, approval };
}

async function approveIssue(issue, userId, reviewNotes = "") {
  if (issue.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval issues can be approved (current: ${issue.status})`,
    };
  }

  issue.status = "approved";
  issue.approvedBy = userId || null;
  issue.approvedAt = new Date();
  await issue.save();

  if (issue.approval) {
    await Approval.findByIdAndUpdate(issue.approval, {
      status: "approved",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes || "",
    });
  }

  await writeAuditLog({
    action: "goods_issue.approved",
    entityType: "GoodsIssue",
    entityId: issue._id,
    summary: `Approved ${issue.issueNumber} — ready to pick/issue`,
    user: userId,
  });

  return { ok: true, issue };
}

async function rejectIssue(issue, userId, reason = "") {
  if (issue.status !== "pending_approval") {
    return {
      ok: false,
      status: 409,
      error: `Only pending_approval issues can be rejected (current: ${issue.status})`,
    };
  }

  issue.status = "rejected";
  issue.rejectedBy = userId || null;
  issue.rejectedAt = new Date();
  issue.rejectionReason = reason || "";
  await issue.save();

  if (issue.approval) {
    await Approval.findByIdAndUpdate(issue.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: reason || "",
    });
  }

  await writeAuditLog({
    action: "goods_issue.rejected",
    entityType: "GoodsIssue",
    entityId: issue._id,
    summary: `Rejected ${issue.issueNumber}`,
    metadata: { reason },
    user: userId,
  });

  return { ok: true, issue };
}

/**
 * Store keeper picks and issues goods — deducts warehouse + product stock.
 * Optional lineOverrides: [{ lineId, issuedQuantity, locationId }]
 */
async function issueGoods(issue, userId, lineOverrides = []) {
  if (issue.status !== "approved") {
    return {
      ok: false,
      status: 409,
      error: `Only approved issues can be fulfilled (current: ${issue.status})`,
    };
  }
  if (issue.stockApplied) {
    return { ok: false, status: 409, error: "Stock already applied for this issue" };
  }

  const overrideByLine = new Map();
  for (const row of lineOverrides || []) {
    if (row.lineId) overrideByLine.set(String(row.lineId), row);
  }

  const applied = [];
  try {
    for (const line of issue.lines) {
      const ov = overrideByLine.get(String(line._id));
      const qty =
        ov && ov.issuedQuantity != null
          ? Number(ov.issuedQuantity)
          : Number(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return {
          ok: false,
          status: 400,
          error: `Invalid issued quantity for product ${line.product}`,
        };
      }
      if (qty > Number(line.quantity)) {
        return {
          ok: false,
          status: 400,
          error: `Issued quantity cannot exceed requested (${line.quantity})`,
        };
      }

      const locationId =
        ov && ov.locationId !== undefined
          ? ov.locationId || null
          : line.location || null;

      const result = await applyStockMovement({
        type: "stock_out",
        productId: line.product,
        warehouseId: issue.warehouse,
        locationId,
        quantity: qty,
        notes: `Goods issue ${issue.issueNumber}`,
        referenceType: "GoodsIssue",
        referenceId: issue._id,
        createdBy: userId,
        syncProductStock: true,
      });
      if (!result.ok) {
        for (const a of applied.reverse()) {
          await applyStockMovement({
            type: "stock_in",
            productId: a.productId,
            warehouseId: issue.warehouse,
            locationId: a.locationId,
            quantity: a.quantity,
            notes: `Rollback goods issue ${issue.issueNumber}`,
            referenceType: "GoodsIssue",
            referenceId: issue._id,
            createdBy: userId,
            syncProductStock: true,
          });
        }
        return { ok: false, status: 409, error: result.error };
      }

      line.issuedQuantity = qty;
      if (ov && ov.locationId !== undefined) {
        line.location = locationId;
      }

      applied.push({
        productId: line.product,
        quantity: qty,
        locationId,
      });
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || "Failed to issue stock" };
  }

  issue.status = "issued";
  issue.issuedBy = userId || null;
  issue.issuedAt = new Date();
  issue.stockApplied = true;
  await issue.save();

  await writeAuditLog({
    action: "goods_issue.issued",
    entityType: "GoodsIssue",
    entityId: issue._id,
    summary: `Issued ${issue.issueNumber} — inventory reduced`,
    user: userId,
  });

  return { ok: true, issue };
}

async function cancelIssue(issue, userId) {
  if (!["draft", "pending_approval", "approved"].includes(issue.status)) {
    return {
      ok: false,
      status: 409,
      error: `Cannot cancel a ${issue.status} issue`,
    };
  }

  if (issue.approval && issue.status === "pending_approval") {
    await Approval.findByIdAndUpdate(issue.approval, {
      status: "rejected",
      reviewedBy: userId || null,
      reviewedAt: new Date(),
      reviewNotes: "Goods issue cancelled",
    });
  }

  issue.status = "cancelled";
  issue.cancelledAt = new Date();
  issue.cancelledBy = userId || null;
  await issue.save();

  await writeAuditLog({
    action: "goods_issue.cancelled",
    entityType: "GoodsIssue",
    entityId: issue._id,
    summary: `Cancelled ${issue.issueNumber}`,
    user: userId,
  });

  return { ok: true, issue };
}

module.exports = {
  nextIssueNumber,
  formatIssue,
  submitIssue,
  approveIssue,
  rejectIssue,
  issueGoods,
  cancelIssue,
};
