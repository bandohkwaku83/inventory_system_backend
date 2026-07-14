const mongoose = require("mongoose");

/**
 * Storage layout types. Most warehouses only need zone + bin.
 * Full path (optional): zone → aisle → rack → shelf → bin
 */
const LOCATION_TYPES = ["zone", "aisle", "rack", "shelf", "bin"];

/** Types that can hold product stock (leaf / assignable slots) */
const STORABLE_TYPES = ["bin"];

/**
 * Flexible parents — skip levels you don't need.
 * Examples that work for most sites:
 *   - bin alone (flat warehouse)
 *   - zone → bin (recommended default)
 *   - zone → rack → bin
 *   - zone → aisle → rack → shelf → bin (large DC)
 */
const ALLOWED_PARENTS = {
  zone: [null],
  aisle: [null, "zone"],
  rack: [null, "zone", "aisle"],
  shelf: [null, "zone", "aisle", "rack"],
  bin: [null, "zone", "aisle", "rack", "shelf"],
};

/** @deprecated use ALLOWED_PARENTS — kept for older clients reading meta.parentTypeByChild */
const PARENT_TYPE_BY_CHILD = {
  zone: null,
  aisle: "zone",
  rack: "zone",
  shelf: "rack",
  bin: "shelf",
};

const LAYOUT_PRESETS = [
  {
    id: "simple",
    label: "Simple (recommended)",
    description: "Zones with bins — fits most shops and small warehouses",
    steps: ["zone", "bin"],
  },
  {
    id: "flat",
    label: "Flat bins only",
    description: "Named bins directly in the warehouse, no zones",
    steps: ["bin"],
  },
  {
    id: "rack",
    label: "Zone + rack + bin",
    description: "When you have racking but don't track every shelf",
    steps: ["zone", "rack", "bin"],
  },
  {
    id: "full",
    label: "Full hierarchy",
    description: "Large warehouses: zone → aisle → rack → shelf → bin",
    steps: ["zone", "aisle", "rack", "shelf", "bin"],
  },
];

const storageLocationSchema = new mongoose.Schema(
  {
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: LOCATION_TYPES,
      required: true,
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      uppercase: true,
    },
    /** Composite path e.g. WH001-A-02-15 (warehouse code + ancestor codes + this code) */
    fullPath: {
      type: String,
      trim: true,
      maxlength: 120,
      uppercase: true,
      default: "",
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

storageLocationSchema.index({ warehouse: 1, code: 1 }, { unique: true });
storageLocationSchema.index({ warehouse: 1, type: 1 });
storageLocationSchema.index({ parent: 1 });

module.exports = mongoose.model("StorageLocation", storageLocationSchema);
module.exports.LOCATION_TYPES = LOCATION_TYPES;
module.exports.STORABLE_TYPES = STORABLE_TYPES;
module.exports.ALLOWED_PARENTS = ALLOWED_PARENTS;
module.exports.PARENT_TYPE_BY_CHILD = PARENT_TYPE_BY_CHILD;
module.exports.LAYOUT_PRESETS = LAYOUT_PRESETS;
