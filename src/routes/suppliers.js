const express = require("express");
const mongoose = require("mongoose");
const Supplier = require("../models/Supplier");
const Purchase = require("../models/Purchase");
const {
  SUPPLIER_CATEGORIES,
  SUPPLIER_STATUSES,
} = require("../models/Supplier");

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function str(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "string") {
    return String(v);
  }
  return v.trim();
}

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

async function createSupplier(req, res, next) {
  try {
    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({ error: "Supplier name is required" });
      return;
    }

    const category = str(req.body, "category") ?? "";
    if (!category || !SUPPLIER_CATEGORIES.includes(category)) {
      res.status(400).json({
        error: `category must be one of: ${SUPPLIER_CATEGORIES.join(", ")}`,
      });
      return;
    }

    const statusRaw = str(req.body, "status");
    if (
      statusRaw !== undefined &&
      statusRaw !== "" &&
      !SUPPLIER_STATUSES.includes(statusRaw)
    ) {
      res.status(400).json({
        error: `status must be one of: ${SUPPLIER_STATUSES.join(", ")}`,
      });
      return;
    }
    const status =
      statusRaw && SUPPLIER_STATUSES.includes(statusRaw) ? statusRaw : "active";

    const contactPerson = str(req.body, "contactPerson") ?? "";
    const phone = str(req.body, "phone") ?? "";
    const email = str(req.body, "email") ?? "";
    const cityRegion = str(req.body, "cityRegion") ?? "";
    const address = str(req.body, "address") ?? "";
    const notes = str(req.body, "notes") ?? "";

    if (email && !EMAIL_RE.test(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    const supplier = await Supplier.create({
      name,
      contactPerson,
      category,
      phone,
      email,
      cityRegion,
      status,
      address,
      notes,
    });

    res.status(201).json(supplier.toJSON());
  } catch (err) {
    next(err);
  }
}

async function listSuppliers(req, res, next) {
  try {
    const filter = {};
    if (req.query.status && SUPPLIER_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.category && SUPPLIER_CATEGORIES.includes(req.query.category)) {
      filter.category = req.query.category;
    }
    const suppliers = await Supplier.find(filter).sort({ name: 1 }).lean();
    res.json(suppliers);
  } catch (err) {
    next(err);
  }
}

async function getSupplierById(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ error: "Invalid supplier id" });
      return;
    }
    const supplier = await Supplier.findById(req.params.id).lean();
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }
    res.json(supplier);
  } catch (err) {
    next(err);
  }
}

async function updateSupplier(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid supplier id" });
      return;
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const body = req.body || {};
    const updates = {};

    if (hasField(body, "name")) {
      const name = str(body, "name") ?? "";
      if (!name) {
        res.status(400).json({ error: "Supplier name cannot be empty" });
        return;
      }
      updates.name = name;
    }

    if (hasField(body, "category")) {
      const category = str(body, "category") ?? "";
      if (!category || !SUPPLIER_CATEGORIES.includes(category)) {
        res.status(400).json({
          error: `category must be one of: ${SUPPLIER_CATEGORIES.join(", ")}`,
        });
        return;
      }
      updates.category = category;
    }

    if (hasField(body, "status")) {
      const statusRaw = str(body, "status") ?? "";
      if (!SUPPLIER_STATUSES.includes(statusRaw)) {
        res.status(400).json({
          error: `status must be one of: ${SUPPLIER_STATUSES.join(", ")}`,
        });
        return;
      }
      updates.status = statusRaw;
    }

    if (hasField(body, "contactPerson")) {
      updates.contactPerson = str(body, "contactPerson") ?? "";
    }
    if (hasField(body, "phone")) {
      updates.phone = str(body, "phone") ?? "";
    }
    if (hasField(body, "email")) {
      const email = str(body, "email") ?? "";
      if (email && !EMAIL_RE.test(email)) {
        res.status(400).json({ error: "Invalid email address" });
        return;
      }
      updates.email = email;
    }
    if (hasField(body, "cityRegion")) {
      updates.cityRegion = str(body, "cityRegion") ?? "";
    }
    if (hasField(body, "address")) {
      updates.address = str(body, "address") ?? "";
    }
    if (hasField(body, "notes")) {
      updates.notes = str(body, "notes") ?? "";
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updatable fields provided" });
      return;
    }

    Object.assign(supplier, updates);
    try {
      await supplier.save({ validateBeforeSave: true });
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

    res.json(supplier.toJSON());
  } catch (err) {
    next(err);
  }
}

async function deleteSupplier(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid supplier id" });
      return;
    }

    const purchaseCount = await Purchase.countDocuments({ supplier: id });
    if (purchaseCount > 0) {
      res.status(409).json({
        error:
          "Cannot delete a supplier that has purchases recorded; reassign or remove those purchases first",
      });
      return;
    }

    const removed = await Supplier.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function getSuppliersSummary(_req, res, next) {
  try {
    const [
      totalSuppliers,
      activeCount,
      inactiveCount,
      distinctCategories,
      outstandingAgg,
    ] = await Promise.all([
      Supplier.countDocuments(),
      Supplier.countDocuments({ status: "active" }),
      Supplier.countDocuments({ status: "inactive" }),
      Supplier.distinct("category"),
      Purchase.aggregate([
        {
          $addFields: {
            purchaseTotal: {
              $round: [
                {
                  $sum: {
                    $map: {
                      input: "$lineItems",
                      as: "li",
                      in: { $multiply: ["$$li.quantity", "$$li.unitPrice"] },
                    },
                  },
                },
                2,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            outstanding: {
              $sum: {
                $max: [
                  0,
                  {
                    $subtract: [
                      "$purchaseTotal",
                      { $ifNull: ["$amountPaid", 0] },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            outstandingGhs: { $round: ["$outstanding", 2] },
          },
        },
      ]),
    ]);

    const outstandingGhs = outstandingAgg[0]?.outstandingGhs ?? 0;

    res.json({
      totalSuppliers,
      activeCount,
      inactiveCount,
      categoriesCount: distinctCategories.length,
      outstandingGhs,
      currency: "GHS",
    });
  } catch (err) {
    next(err);
  }
}

/** Only parameterized routes remain here; collection routes are mounted on the app root. */
const router = express.Router();
router.patch("/:id", updateSupplier);
router.delete("/:id", deleteSupplier);
router.get("/:id", getSupplierById);

module.exports = {
  router,
  createSupplier,
  listSuppliers,
  getSuppliersSummary,
};
