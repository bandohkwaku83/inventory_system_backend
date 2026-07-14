const mongoose = require("mongoose");

/**
 * Goods Receiving Note (GRN).
 * Workflow: draft → pending_approval → completed | rejected | cancelled
 * Store keeper enters delivery; warehouse manager approves → inventory increases.
 */
const RECEIPT_STATUSES = [
  "draft",
  "pending_approval",
  "completed",
  "rejected",
  "cancelled",
];

const receiptLineSchema = new mongoose.Schema(
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
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    unitCost: {
      type: Number,
      min: 0,
      default: null,
    },
  },
  { _id: true }
);

const goodsReceiptSchema = new mongoose.Schema(
  {
    receiptNumber: {
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
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },
    supplierName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    deliveryNote: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    lines: {
      type: [receiptLineSchema],
      validate: {
        validator(v) {
          return Array.isArray(v) && v.length > 0;
        },
        message: "At least one receipt line is required",
      },
    },
    status: {
      type: String,
      enum: RECEIPT_STATUSES,
      default: "draft",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    receivedBy: {
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

goodsReceiptSchema.index({ status: 1, createdAt: -1 });
goodsReceiptSchema.index({ warehouse: 1 });
goodsReceiptSchema.index({ supplier: 1 });

module.exports = mongoose.model("GoodsReceipt", goodsReceiptSchema);
module.exports.RECEIPT_STATUSES = RECEIPT_STATUSES;
