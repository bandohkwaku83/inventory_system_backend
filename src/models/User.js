const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      maxlength: 254,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    /** Linked staff member — user display name is taken from staff.fullName */
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      unique: true,
      sparse: true,
    },
    /** Empty array = access to all product categories (cashiers) */
    categoryIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
      default: [],
    },
    active: {
      type: Boolean,
      default: true,
    },
    /** Incremented on logout or password change to invalidate existing JWTs. */
    tokenVersion: {
      type: Number,
      default: 0,
    },
    /** True until the user sets their own password (first login / admin reset). */
    mustResetPassword: {
      type: Boolean,
      default: false,
    },
    /** SHA-256 hash of the one-time reset token (never store the raw token). */
    passwordResetTokenHash: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
  },
  { timestamps: true }
);

userSchema.methods.toPublicJSON = function toPublicJSON() {
  const o = this.toObject();
  delete o.passwordHash;
  delete o.passwordResetTokenHash;
  delete o.__v;
  return o;
};

module.exports = mongoose.model("User", userSchema);
