const mongoose = require("mongoose");

const PROFORMA_STATUSES = ["draft", "sent", "approved", "expired"];

const proformaItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    sku: { type: String, trim: true, maxlength: 64, default: "" },
    price: { type: Number, required: true, min: 0 },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(v) {
          return Number.isInteger(v);
        },
        message: "Quantity must be a whole number",
      },
    },
  },
  { _id: true }
);

const proformaSchema = new mongoose.Schema(
  {
    proformaNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
    },
    customer: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    customerPhone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
    date: {
      type: String,
      required: true,
      trim: true,
    },
    validUntil: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: PROFORMA_STATUSES,
      default: "sent",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0 },
    items: {
      type: [proformaItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one item is required",
      },
    },
  },
  { timestamps: true }
);

proformaSchema.index({ date: -1 });
proformaSchema.index({ status: 1 });

module.exports = mongoose.model("Proforma", proformaSchema);
module.exports.PROFORMA_STATUSES = PROFORMA_STATUSES;
