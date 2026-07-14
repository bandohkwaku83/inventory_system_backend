const mongoose = require("mongoose");

/**
 * Cycle / stock count session.
 * Workflow: draft → counting → pending_approval → completed | cancelled
 * Count physical qty → compare to system → approve adjustments → inventory updated.
 */
const COUNT_STATUSES = [
  "draft",
  "counting",
  "pending_approval",
  "completed",
  "cancelled",
];

const countLineSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    systemQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    countedQuantity: {
      type: Number,
      min: 0,
      default: null,
    },
    /** counted − system (set when counted) */
    variance: {
      type: Number,
      default: null,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
  },
  { _id: true }
);

const stockCountSchema = new mongoose.Schema(
  {
    countNumber: {
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
    /** Optional scope: count only this location */
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    lines: {
      type: [countLineSchema],
      default: [],
    },
    status: {
      type: String,
      enum: COUNT_STATUSES,
      default: "draft",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    countedBy: {
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

stockCountSchema.index({ status: 1, createdAt: -1 });
stockCountSchema.index({ warehouse: 1 });

module.exports = mongoose.model("StockCount", stockCountSchema);
module.exports.COUNT_STATUSES = COUNT_STATUSES;
