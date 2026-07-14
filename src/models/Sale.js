const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    sku: {
      type: String,
      trim: true,
      maxlength: 64,
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
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

const taxBreakdownSchema = new mongoose.Schema(
  {
    taxableValue: { type: Number, default: 0 },
    nhil: { type: Number, default: 0 },
    getfund: { type: Number, default: 0 },
    covid: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    receiptId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
      index: true,
    },
    receiptNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
      index: true,
    },
    saleNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
      index: true,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      trim: true,
    },
    time: {
      type: String,
      required: true,
      trim: true,
    },
    customer: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "Walk-in",
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      default: null,
    },
    servedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    servedByName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    discount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      enum: ["GHS"],
      default: "GHS",
    },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Mobile Money", "Credit"],
      required: true,
      index: true,
    },
    cashTendered: {
      type: Number,
      min: 0,
    },
    change: {
      type: Number,
      min: 0,
      default: 0,
    },
    taxBreakdown: {
      type: taxBreakdownSchema,
      default: () => ({}),
    },
    status: {
      type: String,
      enum: ["pending", "completed", "voided"],
      default: "completed",
      index: true,
    },
    /** True once stock was decremented for this sale (completed path); prevents double decrement. */
    stockApplied: {
      type: Boolean,
      default: false,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    items: {
      type: [saleItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one item is required",
      },
    },
    idempotencyKey: {
      type: String,
      sparse: true,
      unique: true,
      maxlength: 128,
    },
  },
  { timestamps: true }
);

saleSchema.pre("validate", function setLegacyReceiptNumber() {
  const code = this.receiptId || this.receiptNumber || this.saleNumber;
  if (code) {
    this.receiptId = code;
    this.receiptNumber = code;
    this.saleNumber = code;
  }
});

saleSchema.index({ timestamp: -1 });
saleSchema.index({ date: -1 });

module.exports = mongoose.model("Sale", saleSchema);
