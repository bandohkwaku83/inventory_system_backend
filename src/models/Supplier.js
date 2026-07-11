const mongoose = require("mongoose");

/** Aligns with supplier “Category” dropdown (e.g. Groceries) */
const SUPPLIER_CATEGORIES = [
  "groceries",
  "beverages",
  "frozen",
  "produce",
  "general",
  "other",
];

const SUPPLIER_STATUSES = ["active", "inactive"];

const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    contactPerson: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    category: {
      type: String,
      required: true,
      enum: SUPPLIER_CATEGORIES,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: "",
    },
    cityRegion: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    status: {
      type: String,
      enum: SUPPLIER_STATUSES,
      default: "active",
    },
    address: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
  },
  { timestamps: true }
);

supplierSchema.index({ name: "text", address: "text", notes: "text" });
supplierSchema.index({ category: 1, status: 1 });

const Supplier = mongoose.model("Supplier", supplierSchema);

module.exports = Supplier;
module.exports.SUPPLIER_CATEGORIES = SUPPLIER_CATEGORIES;
module.exports.SUPPLIER_STATUSES = SUPPLIER_STATUSES;
