const mongoose = require("mongoose");

const TRANSFER_STATUSES = [
  "draft",
  "pending_approval",
  "in_transit",
  "received",
  "cancelled",
];

const transferLineSchema = new mongoose.Schema(
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
    fromLocation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    toLocation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
  },
  { _id: true }
);

const stockTransferSchema = new mongoose.Schema(
  {
    transferNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      unique: true,
    },
    fromWarehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    toWarehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    lines: {
      type: [transferLineSchema],
      validate: {
        validator(v) {
          return Array.isArray(v) && v.length > 0;
        },
        message: "At least one transfer line is required",
      },
    },
    status: {
      type: String,
      enum: TRANSFER_STATUSES,
      default: "draft",
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
    shippedAt: {
      type: Date,
      default: null,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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
    /** True once source stock has been deducted (in_transit) */
    stockDeducted: {
      type: Boolean,
      default: false,
    },
    /** True once destination stock has been credited (received) */
    stockReceived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

stockTransferSchema.index({ status: 1, createdAt: -1 });
stockTransferSchema.index({ fromWarehouse: 1 });
stockTransferSchema.index({ toWarehouse: 1 });

module.exports = mongoose.model("StockTransfer", stockTransferSchema);
module.exports.TRANSFER_STATUSES = TRANSFER_STATUSES;
