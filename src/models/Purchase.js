const mongoose = require("mongoose");

const lineItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(v) {
          return Number.isInteger(v) && v >= 1;
        },
        message: "Quantity must be a positive whole number",
      },
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: true }
);

const paymentEntrySchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    recordedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const purchaseSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    invoiceNumber: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    /** Cumulative amount paid (GHS); should equal sum of `payments.amount` when ledger is used */
    amountPaid: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      enum: ["GHS"],
      default: "GHS",
    },
    lineItems: {
      type: [lineItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one line item is required",
      },
    },
    payments: {
      type: [paymentEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

purchaseSchema.index({ supplier: 1, date: -1 });
purchaseSchema.index({ date: -1 });
purchaseSchema.index({ invoiceNumber: "text" });

module.exports = mongoose.model("Purchase", purchaseSchema);
