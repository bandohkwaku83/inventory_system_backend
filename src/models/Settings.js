const mongoose = require("mongoose");

const DEFAULTS = {
  business: {
    name: "Ladepuls Store",
    address: "Accra Ghana",
    phone: "+233 XX XXX XXXX",
    email: "info@ladepuls.com",
    taxId: "C0000000000",
    logoUrl: null,
  },
  receipt: {
    showLogo: true,
    showAddress: true,
    showPhone: true,
    showEmail: true,
    footerMessage: "Thank you for your business!",
  },
};

const settingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "app",
    },
    business: {
      name: { type: String, trim: true, maxlength: 200, default: DEFAULTS.business.name },
      address: { type: String, trim: true, maxlength: 500, default: DEFAULTS.business.address },
      phone: { type: String, trim: true, maxlength: 40, default: DEFAULTS.business.phone },
      email: { type: String, trim: true, maxlength: 254, default: DEFAULTS.business.email },
      taxId: { type: String, trim: true, maxlength: 40, default: DEFAULTS.business.taxId },
      logoUrl: { type: String, trim: true, default: null },
    },
    receipt: {
      showLogo: { type: Boolean, default: DEFAULTS.receipt.showLogo },
      showAddress: { type: Boolean, default: DEFAULTS.receipt.showAddress },
      showPhone: { type: Boolean, default: DEFAULTS.receipt.showPhone },
      showEmail: { type: Boolean, default: DEFAULTS.receipt.showEmail },
      footerMessage: {
        type: String,
        trim: true,
        maxlength: 500,
        default: DEFAULTS.receipt.footerMessage,
      },
    },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Settings", settingsSchema);
module.exports.SETTINGS_DEFAULTS = DEFAULTS;
