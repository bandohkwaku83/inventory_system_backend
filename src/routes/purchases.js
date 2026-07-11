const express = require("express");
const mongoose = require("mongoose");
const Purchase = require("../models/Purchase");
const Product = require("../models/Product");
const Supplier = require("../models/Supplier");
const {
  roundMoney,
  computePurchaseTotals,
  enrichPurchase,
} = require("../utils/purchaseTotals");

function parseDate(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v, label) {
  if (v === undefined || v === null || v === "") {
    return { error: `${label} is required` };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return { error: `${label} must be a valid number` };
  }
  return { value: n };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineItemsPurchaseTotal(normalizedItems) {
  return roundMoney(
    normalizedItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0)
  );
}

async function createPurchase(req, res, next) {
  try {
    const date = parseDate(req.body?.date);
    if (!date) {
      res.status(400).json({ error: "A valid date is required" });
      return;
    }

    const supplierId = req.body?.supplierId ?? req.body?.supplier;
    if (!supplierId || !mongoose.Types.ObjectId.isValid(String(supplierId))) {
      res.status(400).json({ error: "supplierId must be a valid supplier id" });
      return;
    }

    const supplierExists = await Supplier.exists({ _id: supplierId });
    if (!supplierExists) {
      res.status(400).json({ error: "Supplier not found" });
      return;
    }

    let invoiceNumber =
      typeof req.body?.invoiceNumber === "string"
        ? req.body.invoiceNumber.trim()
        : "";
    if (invoiceNumber.length > 120) {
      res.status(400).json({ error: "invoiceNumber is too long" });
      return;
    }

    const paid = num(req.body?.amountPaid, "Amount paid");
    if (paid.error) {
      res.status(400).json({ error: paid.error });
      return;
    }
    if (paid.value < 0) {
      res.status(400).json({ error: "Amount paid must be zero or greater" });
      return;
    }

    const rawItems = req.body?.lineItems;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      res.status(400).json({ error: "At least one line item is required" });
      return;
    }

    const normalizedItems = [];
    for (let i = 0; i < rawItems.length; i++) {
      const row = rawItems[i];
      const productId = row?.productId ?? row?.product;
      if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
        res.status(400).json({
          error: `lineItems[${i}]: productId must be a valid product id`,
        });
        return;
      }

      const qty = num(row?.quantity, `lineItems[${i}] quantity`);
      if (qty.error) {
        res.status(400).json({ error: qty.error });
        return;
      }
      if (!Number.isInteger(qty.value) || qty.value < 1) {
        res.status(400).json({
          error: `lineItems[${i}]: quantity must be a positive integer`,
        });
        return;
      }

      const price = num(row?.unitPrice, `lineItems[${i}] unitPrice`);
      if (price.error) {
        res.status(400).json({ error: price.error });
        return;
      }
      if (price.value < 0) {
        res.status(400).json({
          error: `lineItems[${i}]: unit price must be zero or greater`,
        });
        return;
      }

      normalizedItems.push({
        product: productId,
        quantity: qty.value,
        unitPrice: price.value,
      });
    }

    const productIds = [...new Set(normalizedItems.map((li) => String(li.product)))];
    const productsFound = await Product.countDocuments({
      _id: { $in: productIds },
    });
    if (productsFound !== productIds.length) {
      res.status(400).json({ error: "One or more products were not found" });
      return;
    }

    const purchaseTotal = lineItemsPurchaseTotal(normalizedItems);
    if (paid.value > purchaseTotal + 0.01) {
      res.status(400).json({
        error: "Amount paid cannot exceed the purchase line total",
      });
      return;
    }

    const payments =
      paid.value > 0
        ? [{ amount: paid.value, recordedAt: new Date() }]
        : [];

    let purchase;
    try {
      purchase = await Purchase.create({
        date,
        supplier: supplierId,
        invoiceNumber,
        amountPaid: paid.value,
        lineItems: normalizedItems,
        payments,
      });
    } catch (err) {
      if (err.name === "ValidationError") {
        const msg =
          err.errors?.lineItems?.message ||
          Object.values(err.errors || {})[0]?.message ||
          err.message;
        res.status(400).json({ error: msg });
        return;
      }
      throw err;
    }

    try {
      for (const li of purchase.lineItems) {
        const result = await Product.updateOne(
          { _id: li.product },
          { $inc: { stockQuantity: li.quantity } }
        );
        if (result.matchedCount === 0) {
          throw new Error("PRODUCT_GONE");
        }
      }
    } catch (err) {
      await Purchase.deleteOne({ _id: purchase._id });
      if (err.message === "PRODUCT_GONE") {
        res.status(400).json({
          error: "A product was removed while saving the purchase; try again",
        });
        return;
      }
      throw err;
    }

    const populated = await Purchase.findById(purchase._id)
      .populate("supplier")
      .populate("lineItems.product")
      .lean();

    res.status(201).json(enrichPurchase(populated));
  } catch (err) {
    next(err);
  }
}

/** $lookup + computed totals stages shared by list and summary */
function purchaseTotalsStages() {
  return [
    {
      $lookup: {
        from: "suppliers",
        localField: "supplier",
        foreignField: "_id",
        as: "_supplier",
      },
    },
    { $unwind: "$_supplier" },
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
      $addFields: {
        balance: {
          $round: [
            {
              $max: [
                0,
                { $subtract: ["$purchaseTotal", { $ifNull: ["$amountPaid", 0] }] },
              ],
            },
            2,
          ],
        },
      },
    },
    {
      $addFields: {
        paymentStatus: {
          $cond: [
            { $lte: [{ $ifNull: ["$amountPaid", 0] }, 0] },
            "unpaid",
            {
              $cond: [
                {
                  $lte: [
                    {
                      $subtract: [
                        "$purchaseTotal",
                        { $ifNull: ["$amountPaid", 0] },
                      ],
                    },
                    0.005,
                  ],
                },
                "paid",
                "partial",
              ],
            },
          ],
        },
      },
    },
  ];
}

async function listPurchases(req, res, next) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit || "10"), 10) || 10)
    );
    const skip = (page - 1) * limit;

    const matchPre = {};
    if (req.query.supplierId && mongoose.Types.ObjectId.isValid(req.query.supplierId)) {
      matchPre.supplier = new mongoose.Types.ObjectId(req.query.supplierId);
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const paymentStatusFilter =
      typeof req.query.paymentStatus === "string"
        ? req.query.paymentStatus.trim().toLowerCase()
        : "";

    if (
      paymentStatusFilter &&
      !["unpaid", "partial", "paid"].includes(paymentStatusFilter)
    ) {
      res.status(400).json({
        error: "paymentStatus must be unpaid, partial, or paid",
      });
      return;
    }

    const pipeline = [{ $match: matchPre }, ...purchaseTotalsStages()];

    if (q) {
      const rx = escapeRegex(q);
      pipeline.push({
        $match: {
          $or: [
            { invoiceNumber: { $regex: rx, $options: "i" } },
            { "_supplier.name": { $regex: rx, $options: "i" } },
          ],
        },
      });
    }

    if (paymentStatusFilter) {
      pipeline.push({ $match: { paymentStatus: paymentStatusFilter } });
    }

    const facetPipeline = [
      ...pipeline,
      {
        $facet: {
          meta: [{ $count: "total" }],
          ids: [
            { $sort: { date: -1, createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $project: { _id: 1 } },
          ],
        },
      },
    ];

    const [aggOne] = await Purchase.aggregate(facetPipeline);
    const total = aggOne?.meta?.[0]?.total ?? 0;
    const idList = (aggOne?.ids || []).map((d) => d._id);

    if (idList.length === 0) {
      res.json({
        items: [],
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      });
      return;
    }

    const raw = await Purchase.find({ _id: { $in: idList } })
      .populate("supplier")
      .populate("lineItems.product")
      .lean();

    const order = new Map(idList.map((id, i) => [String(id), i]));
    raw.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));

    res.json({
      items: raw.map((p) => enrichPurchase(p)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
}

async function getPurchasesSummary(_req, res, next) {
  try {
    const pipeline = [...purchaseTotalsStages()];
    pipeline.push({
      $group: {
        _id: null,
        purchaseCount: { $sum: 1 },
        totalSpend: { $sum: "$purchaseTotal" },
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
        unpaidInvoicesCount: {
          $sum: {
            $cond: [
              {
                $gt: [
                  {
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
                  0.005,
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    });

    pipeline.push({
      $project: {
        _id: 0,
        purchaseCount: 1,
        totalSpend: { $round: ["$totalSpend", 2] },
        outstanding: { $round: ["$outstanding", 2] },
        unpaidInvoicesCount: 1,
        currency: { $literal: "GHS" },
      },
    });

    const [row] = await Purchase.aggregate(pipeline);
    res.json(
      row || {
        purchaseCount: 0,
        totalSpend: 0,
        outstanding: 0,
        unpaidInvoicesCount: 0,
        currency: "GHS",
      }
    );
  } catch (err) {
    next(err);
  }
}

async function getPurchaseById(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ error: "Invalid purchase id" });
      return;
    }
    const purchase = await Purchase.findById(req.params.id)
      .populate("supplier")
      .populate("lineItems.product")
      .lean();
    if (!purchase) {
      res.status(404).json({ error: "Purchase not found" });
      return;
    }
    res.json(enrichPurchase(purchase));
  } catch (err) {
    next(err);
  }
}

async function recordPayment(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid purchase id" });
      return;
    }

    const raw = req.body?.amount ?? req.body?.paymentAmount;
    const amt = num(raw, "Payment amount");
    if (amt.error) {
      res.status(400).json({ error: amt.error });
      return;
    }
    if (amt.value <= 0) {
      res.status(400).json({ error: "Payment amount must be greater than zero" });
      return;
    }

    const purchase = await Purchase.findById(id);
    if (!purchase) {
      res.status(404).json({ error: "Purchase not found" });
      return;
    }

    const totals = computePurchaseTotals(purchase.toObject());
    if (amt.value > totals.balance + 0.01) {
      res.status(400).json({
        error: "Payment amount cannot exceed the outstanding balance",
      });
      return;
    }

    purchase.payments.push({ amount: amt.value, recordedAt: new Date() });
    purchase.amountPaid = roundMoney(purchase.amountPaid + amt.value);

    await purchase.save();

    const populated = await Purchase.findById(id)
      .populate("supplier")
      .populate("lineItems.product")
      .lean();

    res.json(enrichPurchase(populated));
  } catch (err) {
    next(err);
  }
}

async function deletePurchase(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid purchase id" });
      return;
    }

    const purchase = await Purchase.findById(id).lean();
    if (!purchase) {
      res.status(404).json({ error: "Purchase not found" });
      return;
    }

    for (const li of purchase.lineItems) {
      const prod = await Product.findById(li.product).select("stockQuantity").lean();
      if (!prod) {
        res.status(400).json({ error: "A product on this purchase no longer exists" });
        return;
      }
      if (prod.stockQuantity < li.quantity) {
        res.status(409).json({
          error:
            "Cannot delete this purchase: stock on hand is lower than the received quantity",
        });
        return;
      }
    }

    for (const li of purchase.lineItems) {
      await Product.updateOne(
        { _id: li.product },
        { $inc: { stockQuantity: -li.quantity } }
      );
    }

    await Purchase.deleteOne({ _id: id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

const router = express.Router();
router.post("/:id/payments", express.json(), recordPayment);
router.delete("/:id", deletePurchase);
router.get("/:id", getPurchaseById);

module.exports = {
  router,
  createPurchase,
  listPurchases,
  getPurchasesSummary,
};
