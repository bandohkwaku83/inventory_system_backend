const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    city: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    balance: {
      type: Number,
      default: 0,
    },
    totalPurchases: {
      type: Number,
      min: 0,
      default: 0,
    },
    lastPurchaseDate: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

customerSchema.index({ name: "text", phone: "text", city: "text" });
customerSchema.index({ name: 1 });

module.exports = mongoose.model("Customer", customerSchema);
