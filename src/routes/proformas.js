const express = require("express");
const mongoose = require("mongoose");
const Proforma = require("../models/Proforma");
const Product = require("../models/Product");
const { PROFORMA_STATUSES } = require("../models/Proforma");
const { roundMoney, computeGraBreakdown } = require("../utils/graTax");

const router = express.Router();

function generateProformaNumber() {
  return `PI-${Date.now().toString(36).toUpperCase()}`;
}

function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

function formatProforma(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  o.taxBreakdown = computeGraBreakdown(o.total);
  delete o.__v;
  return o;
}

async function buildItemsFromBody(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: "At least one item is required" };
  }

  const items = [];
  let subtotal = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const row = rawItems[i];
    const qty = Number(row?.quantity);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1) {
      return { error: `items[${i}]: quantity must be a positive integer` };
    }

    let name = typeof row?.name === "string" ? row.name.trim() : "";
    let sku = typeof row?.sku === "string" ? row.sku.trim() : "";
    let price = row?.price !== undefined ? Number(row.price) : NaN;
    const productId = row?.productId ?? row?.product;

    if (productId && mongoose.Types.ObjectId.isValid(String(productId))) {
      const product = await Product.findById(productId).lean();
      if (!product) {
        return { error: `items[${i}]: product not found` };
      }
      if (!name) name = product.name;
      if (!sku && product.sku) sku = product.sku;
      if (!Number.isFinite(price)) price = product.sellingPrice;
    }

    if (!name) {
      return { error: `items[${i}]: name is required` };
    }
    if (!Number.isFinite(price) || price < 0) {
      return { error: `items[${i}]: price must be zero or greater` };
    }

    price = roundMoney(price);
    subtotal = roundMoney(subtotal + price * qty);

    items.push({
      productId: productId && mongoose.Types.ObjectId.isValid(String(productId))
        ? productId
        : undefined,
      name,
      sku,
      price,
      quantity: qty,
    });
  }

  return { items, subtotal };
}

router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status && PROFORMA_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const proformas = await Proforma.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json(proformas.map((p) => formatProforma(p)));
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const built = await buildItemsFromBody(req.body?.items);
    if (built.error) {
      res.status(400).json({ message: built.error });
      return;
    }

    let discount = 0;
    if (
      req.body?.discount !== undefined &&
      req.body?.discount !== null &&
      req.body?.discount !== ""
    ) {
      discount = Number(req.body.discount);
      if (!Number.isFinite(discount) || discount < 0) {
        res.status(400).json({ message: "discount must be zero or greater" });
        return;
      }
      discount = roundMoney(discount);
    }

    if (discount > built.subtotal + 0.001) {
      res.status(400).json({ message: "Discount cannot exceed subtotal" });
      return;
    }

    const total = roundMoney(Math.max(0, built.subtotal - discount));
    const date =
      typeof req.body?.date === "string" && req.body.date.trim()
        ? req.body.date.trim()
        : todayYmd();
    const validUntil =
      typeof req.body?.validUntil === "string" && req.body.validUntil.trim()
        ? req.body.validUntil.trim()
        : addDaysYmd(date, 14);

    const status =
      req.body?.status && PROFORMA_STATUSES.includes(req.body.status)
        ? req.body.status
        : "sent";

    const proforma = await Proforma.create({
      proformaNumber: generateProformaNumber(),
      customer:
        typeof req.body?.customer === "string" ? req.body.customer.trim() : "",
      customerPhone:
        typeof req.body?.customerPhone === "string"
          ? req.body.customerPhone.trim()
          : "",
      date,
      validUntil,
      status,
      notes: typeof req.body?.notes === "string" ? req.body.notes.trim() : "",
      subtotal: built.subtotal,
      discount,
      total,
      items: built.items,
    });

    res.status(201).json(formatProforma(proforma));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid proforma id" });
      return;
    }
    const proforma = await Proforma.findById(req.params.id).lean();
    if (!proforma) {
      res.status(404).json({ message: "Proforma not found" });
      return;
    }
    res.json(formatProforma(proforma));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid proforma id" });
      return;
    }

    const proforma = await Proforma.findById(id);
    if (!proforma) {
      res.status(404).json({ message: "Proforma not found" });
      return;
    }

    const body = req.body || {};

    if (hasField(body, "customer")) {
      proforma.customer =
        typeof body.customer === "string" ? body.customer.trim() : "";
    }
    if (hasField(body, "customerPhone")) {
      proforma.customerPhone =
        typeof body.customerPhone === "string" ? body.customerPhone.trim() : "";
    }
    if (hasField(body, "date")) {
      const date = typeof body.date === "string" ? body.date.trim() : "";
      if (!date) {
        res.status(400).json({ message: "date cannot be empty" });
        return;
      }
      proforma.date = date;
    }
    if (hasField(body, "validUntil")) {
      const validUntil =
        typeof body.validUntil === "string" ? body.validUntil.trim() : "";
      if (!validUntil) {
        res.status(400).json({ message: "validUntil cannot be empty" });
        return;
      }
      proforma.validUntil = validUntil;
    }
    if (hasField(body, "status")) {
      if (!PROFORMA_STATUSES.includes(body.status)) {
        res.status(400).json({
          message: `status must be one of: ${PROFORMA_STATUSES.join(", ")}`,
        });
        return;
      }
      proforma.status = body.status;
    }
    if (hasField(body, "notes")) {
      proforma.notes =
        typeof body.notes === "string" ? body.notes.trim() : "";
    }

    if (hasField(body, "items")) {
      const built = await buildItemsFromBody(body.items);
      if (built.error) {
        res.status(400).json({ message: built.error });
        return;
      }
      proforma.items = built.items;
      proforma.subtotal = built.subtotal;
    }

    if (hasField(body, "discount")) {
      const discount = Number(body.discount);
      if (!Number.isFinite(discount) || discount < 0) {
        res.status(400).json({ message: "discount must be zero or greater" });
        return;
      }
      proforma.discount = roundMoney(discount);
    }

    if (proforma.discount > proforma.subtotal + 0.001) {
      res.status(400).json({ message: "Discount cannot exceed subtotal" });
      return;
    }
    proforma.total = roundMoney(Math.max(0, proforma.subtotal - proforma.discount));

    await proforma.save();
    res.json(formatProforma(proforma));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid proforma id" });
      return;
    }

    const removed = await Proforma.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({ message: "Proforma not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
