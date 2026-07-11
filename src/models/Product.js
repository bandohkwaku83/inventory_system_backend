const mongoose = require("mongoose");

const UNITS = [
  "units",
  "kg",
  "g",
  "liters",
  "ml",
  "box",
  "pack",
  "dozen",
];

const productSchema = new mongoose.Schema(
  {
    sku: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
      validate: {
        validator(v) {
          if (v === null || v === undefined || v === "") return true;
          return /^[A-Za-z0-9_-]+$/.test(String(v));
        },
        message: "SKU may only contain letters, digits, hyphens, and underscores",
      },
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    costPrice: {
      type: Number,
      min: 0,
      default: null,
    },
    unit: {
      type: String,
      enum: UNITS,
      default: "units",
    },
    stockQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    reorderAt: {
      type: Number,
      required: true,
      min: 0,
    },
    imageUrl: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

productSchema.index({ category: 1 });
productSchema.index({ name: "text", description: "text" });
productSchema.index({ sku: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Product", productSchema);
module.exports.PRODUCT_UNITS = UNITS;
