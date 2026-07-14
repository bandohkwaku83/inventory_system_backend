const mongoose = require("mongoose");

/**
 * Per-warehouse product quantity. Optional location = assigned bin/shelf path.
 * Product.stockQuantity remains the global live total (sum across warehouses when synced).
 */
const warehouseStockSchema = new mongoose.Schema(
  {
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StorageLocation",
      default: null,
    },
  },
  { timestamps: true }
);

warehouseStockSchema.index({ warehouse: 1, product: 1 }, { unique: true });
warehouseStockSchema.index({ product: 1 });
warehouseStockSchema.index({ location: 1 });

module.exports = mongoose.model("WarehouseStock", warehouseStockSchema);
