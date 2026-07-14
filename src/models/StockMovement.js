const mongoose = require("mongoose");

const STOCK_MOVEMENT_TYPES = [
  "stock_in",
  "stock_out",
  "adjustment",
  "opening_stock",
  "damaged",
  "returned",
  "internal_move",
  "transfer_out",
  "transfer_in",
];

/** Types that increase warehouse quantity */
const INBOUND_TYPES = new Set([
  "stock_in",
  "opening_stock",
  "returned",
  "transfer_in",
]);

/** Types that decrease warehouse quantity */
const OUTBOUND_TYPES = new Set([
  "stock_out",
  "damaged",
  "transfer_out",
]);

const stockMovementSchema = new mongoose.Schema(
  {
    movementNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      unique: true,
    },
    type: {
      type: String,
      enum: STOCK_MOVEMENT_TYPES,
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    /** For internal_move / transfer: destination warehouse */
    toWarehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      default: null,
    },
    toLocation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0.0001,
    },
    /** Signed delta applied to warehouse stock for this row (+/-) */
    quantityDelta: {
      type: Number,
      required: true,
    },
    /** Balance at warehouse after this movement */
    balanceAfter: {
      type: Number,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    referenceType: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /** When false, only warehouse ledger changes (does not touch Product.stockQuantity) */
    syncProductStock: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

stockMovementSchema.index({ warehouse: 1, createdAt: -1 });
stockMovementSchema.index({ product: 1, createdAt: -1 });
stockMovementSchema.index({ type: 1, createdAt: -1 });
stockMovementSchema.index({ referenceType: 1, referenceId: 1 });

module.exports = mongoose.model("StockMovement", stockMovementSchema);
module.exports.STOCK_MOVEMENT_TYPES = STOCK_MOVEMENT_TYPES;
module.exports.INBOUND_TYPES = INBOUND_TYPES;
module.exports.OUTBOUND_TYPES = OUTBOUND_TYPES;
