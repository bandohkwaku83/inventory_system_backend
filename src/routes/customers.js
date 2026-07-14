const express = require("express");
const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const STRIP_FIELDS = [
  "tin",
  "type",
  "status",
  "assignedRep",
  "locationId",
  "email",
  "creditLimit",
  "tags",
  "__v",
];

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

function formatCustomer(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  for (const key of STRIP_FIELDS) {
    delete o[key];
  }
  if (o.lastPurchaseDate instanceof Date) {
    o.lastPurchaseDate = o.lastPurchaseDate.toISOString();
  }
  return o;
}

function resolveCity(body) {
  if (hasField(body, "city")) {
    return str(body, "city") ?? "";
  }
  if (hasField(body, "location")) {
    return str(body, "location") ?? "";
  }
  return undefined;
}

async function createCustomer(req, res, next) {
  try {
    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({ message: "Customer name is required", error: "Customer name is required" });
      return;
    }

    const phone = str(req.body, "phone") ?? "";
    if (!phone) {
      res.status(400).json({ message: "Customer phone is required", error: "Customer phone is required" });
      return;
    }

    const city = resolveCity(req.body) ?? "";

    const customer = await Customer.create({
      name,
      phone,
      city,
    });

    res.status(201).json(formatCustomer(customer));
  } catch (err) {
    next(err);
  }
}

async function listCustomers(req, res, next) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50)
    );
    const skip = (page - 1) * limit;

    const filter = {};
    const q = String(req.query.q || req.query.search || "").trim();
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: re }, { phone: re }, { city: re }];
    }

    const [rows, total] = await Promise.all([
      Customer.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);

    const data = rows.map((d) => formatCustomer(d));

    res.json({
      items: data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
}

async function getCustomerById(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid customer id", error: "Invalid customer id" });
      return;
    }
    const customer = await Customer.findById(req.params.id).lean();
    if (!customer) {
      res.status(404).json({ message: "Customer not found", error: "Customer not found" });
      return;
    }
    res.json(formatCustomer(customer));
  } catch (err) {
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid customer id", error: "Invalid customer id" });
      return;
    }

    const customer = await Customer.findById(id);
    if (!customer) {
      res.status(404).json({ message: "Customer not found", error: "Customer not found" });
      return;
    }

    const body = req.body || {};
    const updates = {};

    if (hasField(body, "name")) {
      const name = str(body, "name") ?? "";
      if (!name) {
        res.status(400).json({
          message: "Customer name cannot be empty",
          error: "Customer name cannot be empty",
        });
        return;
      }
      updates.name = name;
    }

    if (hasField(body, "phone")) {
      const phone = str(body, "phone") ?? "";
      if (!phone) {
        res.status(400).json({
          message: "Customer phone cannot be empty",
          error: "Customer phone cannot be empty",
        });
        return;
      }
      updates.phone = phone;
    }

    const city = resolveCity(body);
    if (city !== undefined) {
      updates.city = city;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        message: "No updatable fields provided",
        error: "No updatable fields provided",
      });
      return;
    }

    Object.assign(customer, updates);
    try {
      await customer.save({ validateBeforeSave: true });
    } catch (err) {
      if (err.name === "ValidationError") {
        const msg =
          Object.values(err.errors || {})[0]?.message ||
          err.message ||
          "Validation failed";
        res.status(400).json({ message: msg, error: msg });
        return;
      }
      throw err;
    }

    res.json(formatCustomer(customer));
  } catch (err) {
    next(err);
  }
}

async function deleteCustomer(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid customer id", error: "Invalid customer id" });
      return;
    }

    const removed = await Customer.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({ message: "Customer not found", error: "Customer not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

const router = express.Router();
router.use(requireAuth);
router.use(requireEntitlement("customers"));

router.post("/", createCustomer);
router.get("/", listCustomers);
router.get("/:id", getCustomerById);
router.patch("/:id", updateCustomer);
router.delete("/:id", deleteCustomer);

module.exports = {
  router,
  createCustomer,
  listCustomers,
  formatCustomer,
};
