const mongoose = require("mongoose");

/** UI expense category labels */
const EXPENSE_CATEGORIES = [
  "Repairs",
  "Miscellaneous",
  "Utilities",
  "Transport",
  "Bank Charges",
  "Rent",
];

/** Derived chart-of-accounts labels (no separate CoA model yet) */
const CATEGORY_TO_CHART_ACCOUNT = {
  Repairs: "Repairs & Maintenance",
  Miscellaneous: "Miscellaneous Expenses",
  Utilities: "Utilities",
  Transport: "Transport & Fuel",
  "Bank Charges": "Bank & Mobile Money Charges",
  Rent: "Rent",
};

const EXPENSE_STATUSES = ["Pending", "Paid"];

const expenseSchema = new mongoose.Schema(
  {
    expenseId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      unique: true,
    },
    date: {
      type: Date,
      required: true,
    },
    category: {
      type: String,
      required: true,
      enum: EXPENSE_CATEGORIES,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    reference: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    chartAccount: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "GHS",
      trim: true,
      maxlength: 8,
    },
    status: {
      type: String,
      enum: EXPENSE_STATUSES,
      default: "Pending",
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

expenseSchema.index({ date: -1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ category: 1 });

module.exports = mongoose.model("Expense", expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
module.exports.EXPENSE_STATUSES = EXPENSE_STATUSES;
module.exports.CATEGORY_TO_CHART_ACCOUNT = CATEGORY_TO_CHART_ACCOUNT;
