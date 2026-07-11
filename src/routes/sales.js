const express = require("express");
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const { roundMoney, computeGraBreakdown } = require("../utils/graTax");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

function generateReceiptId() {
  return `R-${Date.now().toString(36).toUpperCase()}`;
}

function formatTimestampParts(d) {
  const iso = d.toISOString();
  return {
    timestamp: iso,
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
  };
}

function normalizePaymentMethod(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "cash") return "Cash";
  if (s === "mobile money" || s === "mobile_money" || s === "mobilemoney") {
    return "Mobile Money";
  }
  return null;
}

function parseQty(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return { error: `${label} is required` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return { error: `${label} must be a positive integer` };
  }
  return { value: n };
}

function consolidateQuantities(items) {
  const map = new Map();
  for (const item of items) {
    const id = String(item.productId);
    map.set(id, (map.get(id) || 0) + item.quantity);
  }
  return map;
}

async function decrementStockConsolidated(consolidatedMap) {
  const applied = [];
  try {
    for (const [productId, qty] of consolidatedMap) {
      const updated = await Product.findOneAndUpdate(
        { _id: productId, stockQuantity: { $gte: qty } },
        { $inc: { stockQuantity: -qty } },
        { new: true }
      ).lean();

      if (!updated) {
        const p = await Product.findById(productId).select("name").lean();
        for (const a of applied.reverse()) {
          await Product.updateOne({ _id: a.id }, { $inc: { stockQuantity: a.qty } });
        }
        return {
          ok: false,
          error: `Insufficient stock for ${p?.name || "product"}`,
        };
      }
      applied.push({ id: productId, qty });
    }
    return { ok: true };
  } catch (err) {
    for (const a of applied.reverse()) {
      await Product.updateOne({ _id: a.id }, { $inc: { stockQuantity: a.qty } });
    }
    throw err;
  }
}

async function revertStockConsolidated(consolidatedMap) {
  for (const [productId, qty] of consolidatedMap) {
    await Product.updateOne({ _id: productId }, { $inc: { stockQuantity: qty } });
  }
}

function formatSale(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (!o.taxBreakdown || !o.taxBreakdown.taxableValue) {
    o.taxBreakdown = computeGraBreakdown(o.total);
  }
  o.servedByName = o.servedByName || "";
  o.servedByUser = o.servedBy
    ? { _id: o.servedBy, name: o.servedByName }
    : null;
  delete o.__v;
  return o;
}

router.post("/", requireAuth, requireEntitlement("sales_pos"), express.json(), async (req, res, next) => {
  try {
    const rawItems = req.body?.items ?? req.body?.lines ?? req.body?.lineItems;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      res.status(400).json({ message: "At least one item is required" });
      return;
    }

    const idemHeader = req.get("Idempotency-Key");
    const idempotencyKey =
      typeof idemHeader === "string" && idemHeader.trim()
        ? idemHeader.trim().slice(0, 128)
        : null;

    if (idempotencyKey) {
      const existing = await Sale.findOne({ idempotencyKey }).lean();
      if (existing) {
        res.status(200).json(formatSale(existing));
        return;
      }
    }

    let customer =
      typeof req.body?.customer === "string" && req.body.customer.trim()
        ? req.body.customer.trim().slice(0, 200)
        : typeof req.body?.customerName === "string" && req.body.customerName.trim()
          ? req.body.customerName.trim().slice(0, 200)
          : "Walk-in";

    let discount = 0;
    const discountRaw = req.body?.discount ?? req.body?.discountAmount;
    if (discountRaw !== undefined && discountRaw !== null && discountRaw !== "") {
      discount = Number(discountRaw);
      if (!Number.isFinite(discount) || discount < 0) {
        res.status(400).json({ message: "discount must be zero or greater" });
        return;
      }
      discount = roundMoney(discount);
    }

    const paymentMethod = normalizePaymentMethod(req.body?.paymentMethod);
    if (!paymentMethod) {
      res.status(400).json({ message: 'paymentMethod must be "Cash" or "Mobile Money"' });
      return;
    }

    let soldAt = new Date();
    const tsRaw = req.body?.timestamp ?? req.body?.soldAt;
    if (tsRaw !== undefined && tsRaw !== null && tsRaw !== "") {
      const d = new Date(tsRaw);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ message: "timestamp must be a valid ISO date string" });
        return;
      }
      soldAt = d;
    }

    const { timestamp, date, time } = formatTimestampParts(soldAt);

    const items = [];
    let subtotal = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const row = rawItems[i];
      const productId = row?.productId ?? row?.product;
      if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
        res.status(400).json({
          message: `items[${i}]: productId must be a valid product id`,
        });
        return;
      }

      const qty = parseQty(row?.quantity, `items[${i}] quantity`);
      if (qty.error) {
        res.status(400).json({ message: qty.error });
        return;
      }

      const product = await Product.findById(productId).lean();
      if (!product) {
        res.status(400).json({ message: `items[${i}]: product not found` });
        return;
      }

      const price =
        row?.price !== undefined && row?.price !== null && row?.price !== ""
          ? roundMoney(Number(row.price))
          : roundMoney(product.sellingPrice);

      if (!Number.isFinite(price) || price < 0) {
        res.status(400).json({ message: `items[${i}]: price must be zero or greater` });
        return;
      }

      subtotal = roundMoney(subtotal + price * qty.value);

      items.push({
        productId: product._id,
        name: product.name,
        sku: product.sku || "",
        price,
        quantity: qty.value,
      });
    }

    if (discount > subtotal + 0.001) {
      res.status(400).json({ message: "Discount cannot exceed subtotal" });
      return;
    }

    const total = roundMoney(Math.max(0, subtotal - discount));
    const taxBreakdown = computeGraBreakdown(total);

    let cashTendered;
    let change = 0;

    if (paymentMethod === "Cash") {
      const tenderRaw = req.body?.cashTendered ?? req.body?.amountTendered;
      const t = Number(tenderRaw);
      if (!Number.isFinite(t) || t < 0) {
        res.status(400).json({ message: "cashTendered is required for Cash payments" });
        return;
      }
      cashTendered = roundMoney(t);
      if (cashTendered < total - 0.01) {
        res.status(400).json({ message: "Cash tendered is less than the total due" });
        return;
      }
      change = roundMoney(cashTendered - total);
    }

    const consolidated = consolidateQuantities(items);
    const dec = await decrementStockConsolidated(consolidated);
    if (!dec.ok) {
      res.status(409).json({ message: dec.error });
      return;
    }

    const receiptCode = generateReceiptId();
    const payload = {
      receiptId: receiptCode,
      receiptNumber: receiptCode,
      saleNumber: receiptCode,
      timestamp: soldAt,
      date,
      time,
      customer,
      servedBy: req.user._id,
      servedByName: req.authUser.name,
      subtotal,
      discount,
      total,
      paymentMethod,
      cashTendered,
      change,
      taxBreakdown: {
        taxableValue: taxBreakdown.taxableValue,
        nhil: taxBreakdown.nhil,
        getfund: taxBreakdown.getfund,
        covid: taxBreakdown.covid,
        vat: taxBreakdown.vat,
      },
      items,
      idempotencyKey: idempotencyKey || undefined,
    };

    let sale;
    try {
      sale = await Sale.create(payload);
    } catch (err) {
      if (
        err.code === 11000 &&
        (err.keyPattern?.receiptId ||
          err.keyPattern?.receiptNumber ||
          err.keyPattern?.saleNumber)
      ) {
        const nextReceiptCode = generateReceiptId();
        payload.receiptId = nextReceiptCode;
        payload.receiptNumber = nextReceiptCode;
        payload.saleNumber = nextReceiptCode;
        try {
          sale = await Sale.create(payload);
        } catch (e2) {
          await revertStockConsolidated(consolidated);
          next(e2);
          return;
        }
      } else if (err.code === 11000 && err.keyPattern?.idempotencyKey && idempotencyKey) {
        await revertStockConsolidated(consolidated);
        const existing = await Sale.findOne({ idempotencyKey }).lean();
        if (existing) {
          res.status(200).json(formatSale(existing));
          return;
        }
        res.status(409).json({ message: "Idempotency conflict" });
        return;
      } else {
        await revertStockConsolidated(consolidated);
        if (err.name === "ValidationError") {
          const msg =
            Object.values(err.errors || {})[0]?.message || err.message;
          res.status(400).json({ message: msg });
          return;
        }
        next(err);
        return;
      }
    }

    res.status(201).json(formatSale(sale));
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50)
    );
    const skip = (page - 1) * limit;

    const filter = { status: { $ne: "voided" } };
    if (req.query.includeVoided === "true") {
      delete filter.status;
    }

    const pm = normalizePaymentMethod(req.query.paymentMethod);
    if (pm) filter.paymentMethod = pm;

    const fromRaw = req.query.from ?? req.query.dateFrom;
    const toRaw = req.query.to ?? req.query.dateTo;
    if ((fromRaw && String(fromRaw).trim()) || (toRaw && String(toRaw).trim())) {
      filter.timestamp = {};
      if (fromRaw && String(fromRaw).trim()) {
        const from = new Date(String(fromRaw).trim());
        if (!Number.isNaN(from.getTime())) filter.timestamp.$gte = from;
      }
      if (toRaw && String(toRaw).trim()) {
        const to = new Date(String(toRaw).trim());
        if (!Number.isNaN(to.getTime())) filter.timestamp.$lte = to;
      }
      if (Object.keys(filter.timestamp).length === 0) delete filter.timestamp;
    }

    if (req.query.date && String(req.query.date).trim()) {
      filter.date = String(req.query.date).trim();
    }

    const receiptQ = req.query.receiptId ?? req.query.receiptNumber ?? req.query.saleNumber;
    if (receiptQ && String(receiptQ).trim()) {
      filter.receiptId = new RegExp(
        `^${String(receiptQ).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i"
      );
    }

    const [rows, total] = await Promise.all([
      Sale.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      Sale.countDocuments(filter),
    ]);

    const data = rows.map((d) => formatSale(d));

    if (req.query.wrap === "false") {
      res.json(data);
      return;
    }

    res.json({
      items: data,
      sales: data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    let sale = null;
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      sale = await Sale.findById(req.params.id).lean();
    }
    if (!sale) {
      sale = await Sale.findOne({
        receiptId: new RegExp(
          `^${String(req.params.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i"
        ),
      }).lean();
    }
    if (!sale) {
      res.status(404).json({ message: "Sale not found" });
      return;
    }
    res.json(formatSale(sale));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/void", async (req, res, next) => {
  try {
    let sale = null;
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      sale = await Sale.findById(req.params.id);
    }
    if (!sale) {
      sale = await Sale.findOne({ receiptId: req.params.id });
    }
    if (!sale) {
      res.status(404).json({ message: "Sale not found" });
      return;
    }
    if (sale.status === "voided") {
      res.status(409).json({ message: "Sale is already voided" });
      return;
    }

    const consolidated = consolidateQuantities(sale.items);
    for (const [productId, qty] of consolidated) {
      await Product.updateOne({ _id: productId }, { $inc: { stockQuantity: qty } });
    }

    sale.status = "voided";
    if (typeof req.body?.notes === "string" && req.body.notes.trim()) {
      sale.notes = req.body.notes.trim().slice(0, 2000);
    }
    await sale.save();

    res.json(formatSale(sale));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
