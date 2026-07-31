const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const Product = require("../models/Product");
const Purchase = require("../models/Purchase");
const { PRODUCT_UNITS } = require("../models/Product");
const {
  uploadProductImage,
  maybeUploadProductImage,
  handleMulterError,
  removeProductUpload,
} = require("../middleware/uploadProductImage");

const router = express.Router();

function parseOptionalNumber(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function parseRequiredNumber(raw, label) {
  const n = parseOptionalNumber(raw);
  if (n === undefined) {
    return { error: `${label} is required` };
  }
  if (!Number.isFinite(n)) {
    return { error: `${label} must be a valid number` };
  }
  return { value: n };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.post(
  "/",
  (req, res, next) => {
    uploadProductImage(req, res, (err) => handleMulterError(err, req, res, next));
  },
  async (req, res, next) => {
    try {
      const skuRaw = req.body?.sku;
      let sku = null;
      if (skuRaw !== undefined && skuRaw !== null && String(skuRaw).trim() !== "") {
        sku = String(skuRaw).trim();
      }

      const name =
        typeof req.body?.name === "string"
          ? req.body.name.trim()
          : req.body?.name != null
            ? String(req.body.name).trim()
            : "";
      if (!name) {
        res.status(400).json({ error: "Product name is required" });
        return;
      }

      const categoryId = req.body?.categoryId ?? req.body?.category;
      if (!categoryId || !mongoose.Types.ObjectId.isValid(String(categoryId))) {
        res.status(400).json({ error: "categoryId must be a valid category id" });
        return;
      }

      const categoryExists = await Category.exists({ _id: categoryId });
      if (!categoryExists) {
        res.status(400).json({ error: "Category not found" });
        return;
      }

      let description =
        typeof req.body?.description === "string" ? req.body.description.trim() : "";
      if (description.length > 5000) {
        res.status(400).json({ error: "description is too long" });
        return;
      }

      const selling = parseRequiredNumber(req.body?.sellingPrice, "Selling price");
      if (selling.error) {
        res.status(400).json({ error: selling.error });
        return;
      }
      if (selling.value < 0) {
        res.status(400).json({ error: "Selling price must be zero or greater" });
        return;
      }

      let costPrice = null;
      const rawCost = req.body?.costPrice;
      if (rawCost !== undefined && rawCost !== null && rawCost !== "") {
        const c = parseOptionalNumber(rawCost);
        if (!Number.isFinite(c)) {
          res.status(400).json({ error: "Cost price must be a valid number" });
          return;
        }
        if (c < 0) {
          res.status(400).json({ error: "Cost price must be zero or greater" });
          return;
        }
        costPrice = c;
      }

      const rawUnit =
        typeof req.body?.unit === "string" && req.body.unit.trim()
          ? req.body.unit.trim()
          : "units";
      if (!PRODUCT_UNITS.includes(rawUnit)) {
        res.status(400).json({
          error: `unit must be one of: ${PRODUCT_UNITS.join(", ")}`,
        });
        return;
      }

      const stock = parseRequiredNumber(req.body?.stockQuantity ?? req.body?.stock, "Stock quantity");
      if (stock.error) {
        res.status(400).json({ error: stock.error });
        return;
      }
      if (!Number.isInteger(stock.value) || stock.value < 0) {
        res.status(400).json({ error: "Stock quantity must be a non-negative integer" });
        return;
      }

      const reorder = parseRequiredNumber(
        req.body?.reorderAt ?? req.body?.reorderQuantity ?? req.body?.minStock,
        "Reorder threshold"
      );
      if (reorder.error) {
        res.status(400).json({ error: reorder.error });
        return;
      }
      if (!Number.isInteger(reorder.value) || reorder.value < 0) {
        res.status(400).json({ error: "Reorder threshold must be a non-negative integer" });
        return;
      }

      let maxStock = null;
      if (req.body?.maxStock != null && req.body?.maxStock !== "") {
        const max = parseRequiredNumber(req.body.maxStock, "Maximum stock");
        if (max.error) {
          res.status(400).json({ error: max.error });
          return;
        }
        if (!Number.isInteger(max.value) || max.value < 0) {
          res.status(400).json({ error: "Maximum stock must be a non-negative integer" });
          return;
        }
        maxStock = max.value;
      }

      let barcode;
      if (req.body?.barcode != null && String(req.body.barcode).trim() !== "") {
        barcode = String(req.body.barcode).trim().slice(0, 64);
      }

      let imageUrl = null;
      if (req.file) {
        imageUrl = path.posix.join(
          "/uploads",
          "products",
          path.basename(req.file.filename)
        );
      }

      const productPayload = {
        sku,
        name,
        category: categoryId,
        description,
        sellingPrice: selling.value,
        costPrice,
        unit: rawUnit,
        stockQuantity: stock.value,
        reorderAt: reorder.value,
        maxStock,
        imageUrl,
      };
      if (barcode !== undefined) {
        productPayload.barcode = barcode;
      }

      const product = await Product.create(productPayload);

      await product.populate("category");

      res.status(201).json(product.toJSON());
    } catch (err) {
      next(err);
    }
  }
);

router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.categoryId && mongoose.Types.ObjectId.isValid(req.query.categoryId)) {
      filter.category = req.query.categoryId;
    }
    const products = await Product.find(filter)
      .populate("category")
      .sort({ createdAt: -1 })
      .lean();
    res.json(products);
  } catch (err) {
    next(err);
  }
});

/** POS: search by name, SKU, or category name */
router.get("/search", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }
    const limit = Math.min(
      50,
      Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20)
    );
    const rx = new RegExp(escapeRegex(q), "i");
    const categories = await Category.find({ name: rx }).select("_id").lean();
    const catIds = categories.map((c) => c._id);
    const orClause = [{ sku: rx }, { name: rx }];
    if (catIds.length) {
      orClause.push({ category: { $in: catIds } });
    }
    const products = await Product.find({ $or: orClause })
      .populate("category", "name")
      .sort({ name: 1 })
      .limit(limit)
      .lean();
    res.json(products);
  } catch (err) {
    next(err);
  }
});

/** POS: exact SKU/barcode scan (case-insensitive) */
router.get("/lookup/sku/:sku", async (req, res, next) => {
  try {
    const skuParam = req.params.sku ? String(req.params.sku).trim() : "";
    if (!skuParam) {
      res.status(400).json({ error: "SKU is required" });
      return;
    }
    const rx = new RegExp(`^${escapeRegex(skuParam)}$`, "i");
    const product = await Product.findOne({ sku: rx })
      .populate("category", "name")
      .lean();
    if (!product) {
      res.status(404).json({ error: "No product found for this SKU" });
      return;
    }
    res.json(product);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ error: "Invalid product id" });
      return;
    }
    const product = await Product.findById(req.params.id).populate("category").lean();
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(product);
  } catch (err) {
    next(err);
  }
});

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

router.patch(
  "/:id",
  maybeUploadProductImage,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ error: "Invalid product id" });
        return;
      }

      const product = await Product.findById(id);
      if (!product) {
        res.status(404).json({ error: "Product not found" });
        return;
      }

      const body = req.body || {};
      const updates = {};

      if (hasField(body, "sku")) {
        if (body.sku === null) {
          updates.sku = null;
        } else {
          const sku =
            typeof body.sku === "string"
              ? body.sku.trim()
              : body.sku != null
                ? String(body.sku).trim()
                : "";
          if (!sku) {
            res.status(400).json({ error: "Invalid sku value" });
            return;
          }
          updates.sku = sku;
        }
      }

      if (hasField(body, "name")) {
        const name =
          typeof body.name === "string"
            ? body.name.trim()
            : body.name != null
              ? String(body.name).trim()
              : "";
        if (!name) {
          res.status(400).json({ error: "Product name cannot be empty" });
          return;
        }
        updates.name = name;
      }

      if (hasField(body, "categoryId") || hasField(body, "category")) {
        const categoryId = body.categoryId ?? body.category;
        if (!categoryId || !mongoose.Types.ObjectId.isValid(String(categoryId))) {
          res.status(400).json({ error: "categoryId must be a valid category id" });
          return;
        }
        const categoryExists = await Category.exists({ _id: categoryId });
        if (!categoryExists) {
          res.status(400).json({ error: "Category not found" });
          return;
        }
        updates.category = categoryId;
      }

      if (hasField(body, "description")) {
        const description =
          typeof body.description === "string"
            ? body.description.trim()
            : String(body.description ?? "").trim();
        if (description.length > 5000) {
          res.status(400).json({ error: "description is too long" });
          return;
        }
        updates.description = description;
      }

      if (hasField(body, "sellingPrice")) {
        const selling = parseRequiredNumber(body.sellingPrice, "Selling price");
        if (selling.error) {
          res.status(400).json({ error: selling.error });
          return;
        }
        if (selling.value < 0) {
          res.status(400).json({ error: "Selling price must be zero or greater" });
          return;
        }
        updates.sellingPrice = selling.value;
      }

      if (hasField(body, "costPrice")) {
        const rawCost = body.costPrice;
        if (rawCost === undefined || rawCost === null || rawCost === "") {
          updates.costPrice = null;
        } else {
          const c = parseOptionalNumber(rawCost);
          if (!Number.isFinite(c)) {
            res.status(400).json({ error: "Cost price must be a valid number" });
            return;
          }
          if (c < 0) {
            res.status(400).json({ error: "Cost price must be zero or greater" });
            return;
          }
          updates.costPrice = c;
        }
      }

      if (hasField(body, "unit")) {
        const rawUnit =
          typeof body.unit === "string" && body.unit.trim()
            ? body.unit.trim()
            : "units";
        if (!PRODUCT_UNITS.includes(rawUnit)) {
          res.status(400).json({
            error: `unit must be one of: ${PRODUCT_UNITS.join(", ")}`,
          });
          return;
        }
        updates.unit = rawUnit;
      }

      if (hasField(body, "stockQuantity") || hasField(body, "stock")) {
        const stock = parseRequiredNumber(body.stockQuantity ?? body.stock, "Stock quantity");
        if (stock.error) {
          res.status(400).json({ error: stock.error });
          return;
        }
        if (!Number.isInteger(stock.value) || stock.value < 0) {
          res.status(400).json({ error: "Stock quantity must be a non-negative integer" });
          return;
        }
        updates.stockQuantity = stock.value;
      }

      if (hasField(body, "reorderAt") || hasField(body, "reorderQuantity") || hasField(body, "minStock")) {
        const reorder = parseRequiredNumber(
          body.reorderAt ?? body.reorderQuantity ?? body.minStock,
          "Reorder threshold"
        );
        if (reorder.error) {
          res.status(400).json({ error: reorder.error });
          return;
        }
        if (!Number.isInteger(reorder.value) || reorder.value < 0) {
          res.status(400).json({ error: "Reorder threshold must be a non-negative integer" });
          return;
        }
        updates.reorderAt = reorder.value;
      }

      if (hasField(body, "maxStock")) {
        if (body.maxStock === null || body.maxStock === "") {
          updates.maxStock = null;
        } else {
          const max = parseRequiredNumber(body.maxStock, "Maximum stock");
          if (max.error) {
            res.status(400).json({ error: max.error });
            return;
          }
          if (!Number.isInteger(max.value) || max.value < 0) {
            res.status(400).json({ error: "Maximum stock must be a non-negative integer" });
            return;
          }
          updates.maxStock = max.value;
        }
      }

      if (hasField(body, "barcode")) {
        if (body.barcode === null || String(body.barcode).trim() === "") {
          updates.barcode = null;
        } else {
          updates.barcode = String(body.barcode).trim().slice(0, 64);
        }
      }

      if (req.file) {
        removeProductUpload(product.imageUrl);
        updates.imageUrl = path.posix.join(
          "/uploads",
          "products",
          path.basename(req.file.filename)
        );
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No updatable fields provided" });
        return;
      }

      Object.assign(product, updates);
      try {
        await product.save({ validateBeforeSave: true });
      } catch (err) {
        if (err.name === "ValidationError") {
          const msg =
            Object.values(err.errors || {})[0]?.message ||
            err.message ||
            "Validation failed";
          res.status(400).json({ error: msg });
          return;
        }
        throw err;
      }

      await product.populate("category");
      res.json(product.toJSON());
    } catch (err) {
      next(err);
    }
  }
);

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid product id" });
      return;
    }

    const onPurchase = await Purchase.countDocuments({ "lineItems.product": id });
    if (onPurchase > 0) {
      res.status(409).json({
        error:
          "Cannot delete a product that appears on saved purchases (remove those lines first or archive differently)",
      });
      return;
    }

    const deleted = await Product.findByIdAndDelete(id).lean();
    if (!deleted) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    removeProductUpload(deleted.imageUrl);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
