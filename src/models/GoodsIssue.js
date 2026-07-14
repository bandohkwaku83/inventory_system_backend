const mongoose = require("mongoose");

/**
 * Goods Issue / stock request.
 * Workflow: draft → pending_approval → approved → issued | rejected | cancelled
 * Requester asks → manager approves → store keeper picks & issues → inventory reduced.
 */
const ISSUE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "issued",
  "rejected",
  "cancelled",
];

const issueLineSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0.0001,
    },
    /** Quantity actually issued (may be ≤ requested after pick) */
    issuedQuantity: {
      type: Number,
      min: 0,
      default: null,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
  },
  { _id: true }
);

const goodsIssueSchema = new mongoose.Schema(
  {
    issueNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      unique: true,
    },
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    lines: {
      type: [issueLineSchema],
      validate: {
        validator(v) {
          return Array.isArray(v) && v.length > 0;
        },
        message: "At least one issue line is required",
      },
    },
    status: {
      type: String,
      enum: ISSUE_STATUSES,
      default: "draft",
    },
    purpose: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    issuedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approval: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Approval",
      default: null,
    },
    stockApplied: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

goodsIssueSchema.index({ status: 1, createdAt: -1 });
goodsIssueSchema.index({ warehouse: 1 });
goodsIssueSchema.index({ requestedBy: 1 });

module.exports = mongoose.model("GoodsIssue", goodsIssueSchema);
module.exports.ISSUE_STATUSES = ISSUE_STATUSES;
