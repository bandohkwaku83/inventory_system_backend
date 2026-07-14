const mongoose = require("mongoose");

const WAREHOUSE_STATUSES = ["active", "inactive"];

const warehouseSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      uppercase: true,
    },
    name: {
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
    address: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: WAREHOUSE_STATUSES,
      default: "active",
    },
  },
  { timestamps: true }
);

warehouseSchema.index({ code: 1 }, { unique: true });
warehouseSchema.index({ status: 1 });
warehouseSchema.index({ name: 1 });

module.exports = mongoose.model("Warehouse", warehouseSchema);
module.exports.WAREHOUSE_STATUSES = WAREHOUSE_STATUSES;
