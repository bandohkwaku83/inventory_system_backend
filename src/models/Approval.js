const mongoose = require("mongoose");

const APPROVAL_TYPES = [
  "purchase",
  "expense",
  "warehouse_transfer",
  "goods_receipt",
  "goods_issue",
  "stock_adjustment",
  "stock_count",
  "warehouse_create",
  "discount",
  "credit_request",
];

const APPROVAL_STATUSES = ["pending", "approved", "rejected"];

const approvalSchema = new mongoose.Schema(
  {
    approvalNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      unique: true,
    },
    type: {
      type: String,
      enum: APPROVAL_TYPES,
      required: true,
    },
    status: {
      type: String,
      enum: APPROVAL_STATUSES,
      default: "pending",
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    /** Linked domain document (transfer, purchase, expense, etc.) */
    entityType: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    /** Snapshot / request payload for non-entity or display */
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    amount: {
      type: Number,
      default: null,
      min: 0,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
  },
  { timestamps: true }
);

approvalSchema.index({ status: 1, createdAt: -1 });
approvalSchema.index({ type: 1, status: 1 });
approvalSchema.index({ entityType: 1, entityId: 1 });

module.exports = mongoose.model("Approval", approvalSchema);
module.exports.APPROVAL_TYPES = APPROVAL_TYPES;
module.exports.APPROVAL_STATUSES = APPROVAL_STATUSES;
