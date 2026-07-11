const mongoose = require("mongoose");
const { ALL_ENTITLEMENT_KEYS } = require("../constants/entitlements");

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    /** Stable key for seeded system roles (admin, cashier, gra_reporter). */
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      unique: true,
    },
    entitlements: {
      type: [String],
      enum: ALL_ENTITLEMENT_KEYS,
      default: [],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

roleSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

roleSchema.methods.toPublicJSON = function toPublicJSON() {
  const o = this.toObject();
  delete o.__v;
  return o;
};

module.exports = mongoose.model("Role", roleSchema);
