const express = require("express");
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const { roundMoney, computeGraBreakdown } = require("../utils/graTax");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

const SALE_STATUSES = ["pending", "completed", "voided"];

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
  if (s === "credit" || s === "on account" || s === "on_account" || s === "account") {
    return "Credit";
  }
  return null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWalkInName(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return s === "walk-in" || s === "walk in" || s === "walkin";
}

function normalizeStatus(raw, { allowVoided = false } = {}) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "pending") return "pending";
  if (s === "completed") return "completed";
  if (allowVoided && s === "voided") return "voided";
  return undefined;
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

async function resolveSaleItems(rawItems) {
  const items = [];
  let subtotal = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const row = rawItems[i];
    const productId = row?.productId ?? row?.product;
    if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
      return {
        error: `items[${i}]: productId must be a valid product id`,
      };
    }

    const qty = parseQty(row?.quantity, `items[${i}] quantity`);
    if (qty.error) {
      return { error: qty.error };
    }

    const product = await Product.findById(productId).lean();
    if (!product) {
      return { error: `items[${i}]: product not found` };
    }

    const price =
      row?.price !== undefined && row?.price !== null && row?.price !== ""
        ? roundMoney(Number(row.price))
        : roundMoney(product.sellingPrice);

    if (!Number.isFinite(price) || price < 0) {
      return { error: `items[${i}]: price must be zero or greater` };
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

  return { items, subtotal };
}

function computeTotals({ subtotal, discount, paymentMethod, cashTenderedRaw, requireCashCover }) {
  if (discount > subtotal + 0.001) {
    return { error: "Discount cannot exceed subtotal" };
  }

  const total = roundMoney(Math.max(0, subtotal - discount));
  const taxBreakdown = computeGraBreakdown(total);

  let cashTendered;
  let change = 0;

  if (paymentMethod === "Cash") {
    if (cashTenderedRaw !== undefined && cashTenderedRaw !== null && cashTenderedRaw !== "") {
      const t = Number(cashTenderedRaw);
      if (!Number.isFinite(t) || t < 0) {
        return { error: "cashTendered must be zero or greater" };
      }
      cashTendered = roundMoney(t);
    } else if (requireCashCover) {
      return { error: "cashTendered is required for Cash payments" };
    } else {
      cashTendered = 0;
    }

    if (requireCashCover && cashTendered < total - 0.01) {
      return { error: "Cash tendered is less than the total due" };
    }
    change = roundMoney(Math.max(0, (cashTendered || 0) - total));
  }

  return { total, taxBreakdown, cashTendered, change };
}

async function resolveCustomer(body) {
  let customer =
    typeof body?.customer === "string" && body.customer.trim()
      ? body.customer.trim().slice(0, 200)
      : typeof body?.customerName === "string" && body.customerName.trim()
        ? body.customerName.trim().slice(0, 200)
        : null;

  let customerId = null;
  const rawId = body?.customerId;
  if (rawId !== undefined && rawId !== null && rawId !== "") {
    if (!mongoose.Types.ObjectId.isValid(String(rawId))) {
      return { error: "customerId must be a valid id" };
    }
    const doc = await Customer.findById(rawId).lean();
    if (!doc) {
      return { error: "Customer not found" };
    }
    customerId = doc._id;
    if (!customer) {
      customer = doc.name;
    }
  }

  if (!customer) {
    customer = "Walk-in";
  }

  if (isWalkInName(customer)) {
    return { customer: "Walk-in", customerId: null };
  }

  // Link sale to the customer record by name when id was not sent
  // (Cash / MoMo / Credit all count toward that person's totals).
  if (!customerId) {
    const doc = await Customer.findOne({
      name: new RegExp(`^${escapeRegex(customer)}$`, "i"),
    }).lean();
    if (doc) {
      customerId = doc._id;
      customer = doc.name;
    }
  }

  return { customer, customerId };
}

/**
 * Completed sale stats for a linked customer:
 * - totalPurchases += sale total for Cash, Mobile Money, and Credit
 * - balance (receivables) += sale total only for Credit (unpaid);
 *   Cash / MoMo are settled at POS so balance is unchanged
 * - lastPurchaseDate = sale timestamp on complete; recomputed after void
 */
async function refreshLastPurchaseDate(customerId, excludeSaleId = null) {
  if (!customerId) return;
  const filter = {
    customerId,
    status: "completed",
  };
  if (excludeSaleId) {
    filter._id = { $ne: excludeSaleId };
  }

  const latest = await Sale.findOne(filter)
    .sort({ timestamp: -1 })
    .select("timestamp")
    .lean();

  await Customer.updateOne(
    { _id: customerId },
    { $set: { lastPurchaseDate: latest?.timestamp || null } }
  );
}

async function applyCustomerSaleStats(
  customerId,
  { total, paymentMethod, soldAt, reverse = false, excludeSaleId = null }
) {
  if (!customerId) return;

  const amount = roundMoney(Math.abs(Number(total) || 0));
  const signed = reverse ? -amount : amount;
  const inc = {};

  if (amount > 0) {
    inc.totalPurchases = signed;
    if (paymentMethod === "Credit") {
      inc.balance = signed;
    }
  }

  if (Object.keys(inc).length > 0) {
    const update = { $inc: inc };
    if (!reverse && soldAt) {
      update.$set = { lastPurchaseDate: soldAt };
    }
    await Customer.updateOne({ _id: customerId }, update);
    await Customer.updateOne(
      { _id: customerId, totalPurchases: { $lt: 0 } },
      { $set: { totalPurchases: 0 } }
    );
    await Customer.updateOne(
      { _id: customerId, balance: { $lt: 0 } },
      { $set: { balance: 0 } }
    );
  } else if (!reverse && soldAt) {
    await Customer.updateOne(
      { _id: customerId },
      { $set: { lastPurchaseDate: soldAt } }
    );
  }

  if (reverse) {
    await refreshLastPurchaseDate(customerId, excludeSaleId);
  }
}

async function findSaleByParam(id) {
  let sale = null;
  if (mongoose.Types.ObjectId.isValid(id)) {
    sale = await Sale.findById(id);
  }
  if (!sale) {
    sale = await Sale.findOne({
      receiptId: new RegExp(
        `^${String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i"
      ),
    });
  }
  return sale;
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
  o.status = o.status || "completed";
  if (o.timestamp instanceof Date) {
    const parts = formatTimestampParts(o.timestamp);
    o.timestamp = parts.timestamp;
    if (!o.date) o.date = parts.date;
    if (!o.time) o.time = parts.time;
  }
  delete o.__v;
  return o;
}

router.post(
  "/",
  requireAuth,
  requireEntitlement("sales_pos"),
  express.json(),
  async (req, res, next) => {
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

      const statusRaw = normalizeStatus(req.body?.status, { allowVoided: false });
      if (req.body?.status !== undefined && req.body?.status !== null && req.body?.status !== "" && statusRaw === undefined) {
        res.status(400).json({ message: 'status must be "pending" or "completed"' });
        return;
      }
      const status = statusRaw || "completed";

      const customerResolved = await resolveCustomer(req.body);
      if (customerResolved.error) {
        res.status(400).json({ message: customerResolved.error });
        return;
      }
      const { customer, customerId } = customerResolved;

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
        res.status(400).json({
          message: 'paymentMethod must be "Cash", "Mobile Money", or "Credit"',
        });
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

      const { date, time } = formatTimestampParts(soldAt);

      const resolved = await resolveSaleItems(rawItems);
      if (resolved.error) {
        res.status(400).json({ message: resolved.error });
        return;
      }
      const { items, subtotal } = resolved;

      const totals = computeTotals({
        subtotal,
        discount,
        paymentMethod,
        cashTenderedRaw: req.body?.cashTendered ?? req.body?.amountTendered,
        requireCashCover: status === "completed",
      });
      if (totals.error) {
        res.status(400).json({ message: totals.error });
        return;
      }

      const { total, taxBreakdown, cashTendered, change } = totals;
      const consolidated = consolidateQuantities(items);

      let stockApplied = false;
      if (status === "completed") {
        const dec = await decrementStockConsolidated(consolidated);
        if (!dec.ok) {
          res.status(409).json({ message: dec.error });
          return;
        }
        stockApplied = true;
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
        customerId: customerId || undefined,
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
        status,
        stockApplied,
        items,
        idempotencyKey: idempotencyKey || undefined,
      };

      let sale;
      try {
        sale = await Sale.create(payload);
      } catch (err) {
        if (stockApplied) {
          await revertStockConsolidated(consolidated);
        }
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
            if (stockApplied) {
              const dec = await decrementStockConsolidated(consolidated);
              if (!dec.ok) {
                res.status(409).json({ message: dec.error });
                return;
              }
            }
            sale = await Sale.create(payload);
          } catch (e2) {
            if (stockApplied) {
              await revertStockConsolidated(consolidated);
            }
            next(e2);
            return;
          }
        } else if (err.code === 11000 && err.keyPattern?.idempotencyKey && idempotencyKey) {
          const existing = await Sale.findOne({ idempotencyKey }).lean();
          if (existing) {
            res.status(200).json(formatSale(existing));
            return;
          }
          res.status(409).json({ message: "Idempotency conflict" });
          return;
        } else if (err.name === "ValidationError") {
          const msg = Object.values(err.errors || {})[0]?.message || err.message;
          res.status(400).json({ message: msg });
          return;
        } else {
          next(err);
          return;
        }
      }

      if (status === "completed" && customerId) {
        await applyCustomerSaleStats(customerId, {
          total,
          paymentMethod,
          soldAt,
        });
      }

      res.status(201).json(formatSale(sale));
    } catch (err) {
      next(err);
    }
  }
);

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50)
    );
    const skip = (page - 1) * limit;

    const filter = {};
    const statusQ = String(req.query.status || "").trim().toLowerCase();
    if (statusQ && SALE_STATUSES.includes(statusQ)) {
      filter.status = statusQ;
    } else if (req.query.includeVoided === "true") {
      // no status filter
    } else {
      filter.status = { $ne: "voided" };
    }

    const pm = normalizePaymentMethod(req.query.paymentMethod);
    if (pm) filter.paymentMethod = pm;

    const fromRaw = req.query.from ?? req.query.dateFrom;
    const toRaw = req.query.to ?? req.query.dateTo;
    if ((fromRaw && String(fromRaw).trim()) || (toRaw && String(toRaw).trim())) {
      filter.timestamp = {};
      if (fromRaw && String(fromRaw).trim()) {
        const from = new Date(String(fromRaw).trim());
        if (!Number.isNaN(from.getTime())) {
          const start = new Date(from);
          start.setUTCHours(0, 0, 0, 0);
          filter.timestamp.$gte = start;
        }
      }
      if (toRaw && String(toRaw).trim()) {
        const to = new Date(String(toRaw).trim());
        if (!Number.isNaN(to.getTime())) {
          const end = new Date(to);
          end.setUTCHours(23, 59, 59, 999);
          filter.timestamp.$lte = end;
        }
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

router.patch(
  "/:id",
  requireAuth,
  requireEntitlement("sales_pos", "receipts"),
  express.json(),
  async (req, res, next) => {
    try {
      const sale = await findSaleByParam(req.params.id);
      if (!sale) {
        res.status(404).json({ message: "Sale not found" });
        return;
      }

      if (sale.status === "voided") {
        res.status(409).json({ message: "Voided sales cannot be edited" });
        return;
      }

      const body = req.body || {};
      const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

      let nextStatus = sale.status;
      if (has("status")) {
        const statusRaw = normalizeStatus(body.status, { allowVoided: true });
        if (statusRaw === undefined || statusRaw === null) {
          res.status(400).json({
            message: 'status must be "pending", "completed", or "voided"',
          });
          return;
        }
        nextStatus = statusRaw;
      }

      const editingCore =
        has("items") ||
        has("lines") ||
        has("lineItems") ||
        has("customer") ||
        has("customerName") ||
        has("customerId") ||
        has("paymentMethod") ||
        has("discount") ||
        has("discountAmount") ||
        has("cashTendered") ||
        has("amountTendered");

      // Completed sales: only void (or idempotent re-complete with no edits).
      if (sale.status === "completed" && nextStatus !== "voided") {
        if (nextStatus === "pending" || editingCore) {
          res.status(409).json({
            message:
              "Completed sales can only be voided; edit pending carts before completing",
          });
          return;
        }
        // Idempotent: already completed, no stock change
        res.json(formatSale(sale));
        return;
      }

      // --- Void path ---
      if (nextStatus === "voided") {
        if (sale.stockApplied || sale.status === "completed") {
          const consolidated = consolidateQuantities(sale.items);
          await revertStockConsolidated(consolidated);
          sale.stockApplied = false;
        }
        if (sale.status === "completed" && sale.customerId) {
          await applyCustomerSaleStats(sale.customerId, {
            total: sale.total,
            paymentMethod: sale.paymentMethod,
            reverse: true,
            excludeSaleId: sale._id,
          });
        }
        sale.status = "voided";
        if (typeof body.notes === "string" && body.notes.trim()) {
          sale.notes = body.notes.trim().slice(0, 2000);
        }
        await sale.save();
        res.json(formatSale(sale));
        return;
      }

      // --- Pending / complete path ---
      if (has("customer") || has("customerName") || has("customerId")) {
        const customerResolved = await resolveCustomer({
          customer: has("customer") ? body.customer : sale.customer,
          customerName: body.customerName,
          customerId: has("customerId") ? body.customerId : sale.customerId,
        });
        if (customerResolved.error) {
          res.status(400).json({ message: customerResolved.error });
          return;
        }
        sale.customer = customerResolved.customer;
        sale.customerId = customerResolved.customerId || undefined;
      } else if (
        !sale.customerId &&
        sale.customer &&
        !isWalkInName(sale.customer)
      ) {
        // Pending carts stored by name only — link before complete
        const linked = await resolveCustomer({
          customer: sale.customer,
          customerId: sale.customerId,
        });
        if (!linked.error && linked.customerId) {
          sale.customer = linked.customer;
          sale.customerId = linked.customerId;
        }
      }

      if (has("paymentMethod")) {
        const paymentMethod = normalizePaymentMethod(body.paymentMethod);
        if (!paymentMethod) {
          res.status(400).json({
            message: 'paymentMethod must be "Cash", "Mobile Money", or "Credit"',
          });
          return;
        }
        sale.paymentMethod = paymentMethod;
      }

      if (has("discount") || has("discountAmount")) {
        const discountRaw = body.discount ?? body.discountAmount;
        const discount = Number(discountRaw);
        if (!Number.isFinite(discount) || discount < 0) {
          res.status(400).json({ message: "discount must be zero or greater" });
          return;
        }
        sale.discount = roundMoney(discount);
      }

      if (has("items") || has("lines") || has("lineItems")) {
        const rawItems = body.items ?? body.lines ?? body.lineItems;
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
          res.status(400).json({ message: "At least one item is required" });
          return;
        }
        const resolved = await resolveSaleItems(rawItems);
        if (resolved.error) {
          res.status(400).json({ message: resolved.error });
          return;
        }
        sale.items = resolved.items;
        sale.subtotal = resolved.subtotal;
      }

      const totals = computeTotals({
        subtotal: sale.subtotal,
        discount: sale.discount,
        paymentMethod: sale.paymentMethod,
        cashTenderedRaw: has("cashTendered") || has("amountTendered")
          ? body.cashTendered ?? body.amountTendered
          : sale.cashTendered,
        requireCashCover: nextStatus === "completed",
      });
      if (totals.error) {
        res.status(400).json({ message: totals.error });
        return;
      }

      sale.total = totals.total;
      sale.cashTendered = totals.cashTendered;
      sale.change = totals.change;
      sale.taxBreakdown = {
        taxableValue: totals.taxBreakdown.taxableValue,
        nhil: totals.taxBreakdown.nhil,
        getfund: totals.taxBreakdown.getfund,
        covid: totals.taxBreakdown.covid,
        vat: totals.taxBreakdown.vat,
      };

      const wasCompleted = sale.status === "completed";
      const becomingCompleted = nextStatus === "completed";

      if (becomingCompleted && !sale.stockApplied && !wasCompleted) {
        const consolidated = consolidateQuantities(sale.items);
        const dec = await decrementStockConsolidated(consolidated);
        if (!dec.ok) {
          res.status(409).json({ message: dec.error });
          return;
        }
        sale.stockApplied = true;
      }

      const prevStatus = sale.status;
      sale.status = nextStatus;

      if (typeof body.notes === "string") {
        sale.notes = body.notes.trim().slice(0, 2000);
      }

      try {
        await sale.save();
      } catch (err) {
        if (becomingCompleted && !wasCompleted && sale.stockApplied && prevStatus !== "completed") {
          // stock was just applied; revert on validation failure
          await revertStockConsolidated(consolidateQuantities(sale.items));
          sale.stockApplied = false;
        }
        if (err.name === "ValidationError") {
          const msg = Object.values(err.errors || {})[0]?.message || err.message;
          res.status(400).json({ message: msg });
          return;
        }
        throw err;
      }

      if (becomingCompleted && prevStatus !== "completed" && sale.customerId) {
        await applyCustomerSaleStats(sale.customerId, {
          total: sale.total,
          paymentMethod: sale.paymentMethod,
          soldAt: sale.timestamp,
        });
      }

      res.json(formatSale(sale));
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const sale = await findSaleByParam(req.params.id);
    if (!sale) {
      res.status(404).json({ message: "Sale not found" });
      return;
    }
    res.json(formatSale(sale));
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/:id/void",
  requireAuth,
  requireEntitlement("sales_pos", "receipts"),
  express.json(),
  async (req, res, next) => {
    try {
      const sale = await findSaleByParam(req.params.id);
      if (!sale) {
        res.status(404).json({ message: "Sale not found" });
        return;
      }
      if (sale.status === "voided") {
        res.status(409).json({ message: "Sale is already voided" });
        return;
      }

      if (sale.stockApplied || sale.status === "completed") {
        const consolidated = consolidateQuantities(sale.items);
        await revertStockConsolidated(consolidated);
        sale.stockApplied = false;
      }

      if (sale.status === "completed" && sale.customerId) {
        await applyCustomerSaleStats(sale.customerId, {
          total: sale.total,
          paymentMethod: sale.paymentMethod,
          reverse: true,
          excludeSaleId: sale._id,
        });
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
  }
);

router.delete(
  "/:id",
  requireAuth,
  requireEntitlement("sales_pos", "receipts"),
  async (req, res, next) => {
    try {
      const sale = await findSaleByParam(req.params.id);
      if (!sale) {
        res.status(404).json({ message: "Sale not found" });
        return;
      }
      if (sale.status === "voided") {
        res.status(409).json({ message: "Sale is already voided" });
        return;
      }

      if (sale.stockApplied || sale.status === "completed") {
        await revertStockConsolidated(consolidateQuantities(sale.items));
        sale.stockApplied = false;
      }
      if (sale.status === "completed" && sale.customerId) {
        await applyCustomerSaleStats(sale.customerId, {
          total: sale.total,
          paymentMethod: sale.paymentMethod,
          reverse: true,
          excludeSaleId: sale._id,
        });
      }

      sale.status = "voided";
      await sale.save();
      res.json(formatSale(sale));
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
