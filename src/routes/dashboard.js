const express = require("express");
const Product = require("../models/Product");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const Supplier = require("../models/Supplier");
const { roundMoney, computePurchaseTotals } = require("../utils/purchaseTotals");
const {
  startOfDay,
  endOfDay,
  addDays,
  toDateKey,
  parseDays,
  parseLimit,
  percentChange,
  buildDayRange,
  fillDailySeries,
  formatItemsSummary,
  formatRestockQuantity,
} = require("../utils/dashboard");

const router = express.Router();

const WALK_IN_CUSTOMER = "Walk-in";

async function aggregateSalesRevenue(match) {
  const rows = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        revenue: { $sum: "$total" },
        count: { $sum: 1 },
      },
    },
  ]);
  const row = rows[0] || { revenue: 0, count: 0 };
  return {
    revenue: roundMoney(row.revenue || 0),
    count: row.count || 0,
  };
}

async function aggregateSalesByDate(start, end) {
  const rows = await Sale.aggregate([
    {
      $match: {
        status: { $ne: "voided" },
        timestamp: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: "$date",
        revenue: { $sum: "$total" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows;
}

async function aggregatePurchaseSpendByDate(start, end) {
  const purchases = await Purchase.find({
    date: { $gte: start, $lte: end },
  })
    .select("date lineItems")
    .lean();

  const byDate = new Map();
  for (const purchase of purchases) {
    const key = toDateKey(new Date(purchase.date));
    const spend = roundMoney(
      (purchase.lineItems || []).reduce(
        (sum, li) => sum + (li.quantity || 0) * (li.unitPrice || 0),
        0
      )
    );
    const existing = byDate.get(key) || { _id: key, amount: 0 };
    existing.amount = roundMoney(existing.amount + spend);
    byDate.set(key, existing);
  }

  return Array.from(byDate.values());
}

async function countActiveCustomers(start, end) {
  const rows = await Sale.aggregate([
    {
      $match: {
        status: { $ne: "voided" },
        timestamp: { $gte: start, $lte: end },
        customer: { $nin: [WALK_IN_CUSTOMER, "", null] },
      },
    },
    { $group: { _id: "$customer" } },
    { $count: "count" },
  ]);
  return rows[0]?.count || 0;
}

async function sumInventoryUnits() {
  const rows = await Product.aggregate([
    {
      $group: {
        _id: null,
        totalUnits: { $sum: "$stockQuantity" },
        productCount: { $sum: 1 },
      },
    },
  ]);
  const row = rows[0] || { totalUnits: 0, productCount: 0 };
  return {
    totalUnits: row.totalUnits || 0,
    productCount: row.productCount || 0,
  };
}

async function sumUnitsSold(start, end) {
  const rows = await Sale.aggregate([
    {
      $match: {
        status: { $ne: "voided" },
        timestamp: { $gte: start, $lte: end },
      },
    },
    { $unwind: "$items" },
    {
      $group: {
        _id: null,
        units: { $sum: "$items.quantity" },
      },
    },
  ]);
  return rows[0]?.units || 0;
}

async function sumUnitsPurchased(start, end) {
  const purchases = await Purchase.find({
    date: { $gte: start, $lte: end },
  })
    .select("lineItems")
    .lean();

  return purchases.reduce((sum, purchase) => {
    const units = (purchase.lineItems || []).reduce(
      (lineSum, li) => lineSum + (li.quantity || 0),
      0
    );
    return sum + units;
  }, 0);
}

async function getMetrics() {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const yesterdayStart = startOfDay(addDays(now, -1));
  const yesterdayEnd = endOfDay(addDays(now, -1));

  const last7Start = startOfDay(addDays(now, -6));
  const prior7Start = startOfDay(addDays(now, -13));
  const prior7End = endOfDay(addDays(now, -7));

  const last30Start = startOfDay(addDays(now, -29));
  const prior30Start = startOfDay(addDays(now, -59));
  const prior30End = endOfDay(addDays(now, -30));

  const [
    todaySales,
    yesterdaySales,
    revenue7d,
    revenuePrior7d,
    inventory,
    unitsSold7d,
    unitsPurchased7d,
    activeCustomers30d,
    activeCustomersPrior30d,
  ] = await Promise.all([
    aggregateSalesRevenue({
      status: { $ne: "voided" },
      timestamp: { $gte: todayStart, $lte: todayEnd },
    }),
    aggregateSalesRevenue({
      status: { $ne: "voided" },
      timestamp: { $gte: yesterdayStart, $lte: yesterdayEnd },
    }),
    aggregateSalesRevenue({
      status: { $ne: "voided" },
      timestamp: { $gte: last7Start, $lte: todayEnd },
    }),
    aggregateSalesRevenue({
      status: { $ne: "voided" },
      timestamp: { $gte: prior7Start, $lte: prior7End },
    }),
    sumInventoryUnits(),
    sumUnitsSold(last7Start, todayEnd),
    sumUnitsPurchased(last7Start, todayEnd),
    countActiveCustomers(last30Start, todayEnd),
    countActiveCustomers(prior30Start, prior30End),
  ]);

  const netStockMovement = unitsPurchased7d - unitsSold7d;
  const estimatedPreviousStock = inventory.totalUnits - netStockMovement;
  const inventoryChange = percentChange(
    inventory.totalUnits,
    estimatedPreviousStock
  );

  return {
    todaysSales: {
      value: todaySales.revenue,
      count: todaySales.count,
      changePercent: percentChange(todaySales.revenue, yesterdaySales.revenue),
      currency: "GHS",
    },
    revenue7d: {
      value: revenue7d.revenue,
      count: revenue7d.count,
      changePercent: percentChange(revenue7d.revenue, revenuePrior7d.revenue),
      currency: "GHS",
    },
    inventoryItems: {
      value: inventory.totalUnits,
      productCount: inventory.productCount,
      changePercent: inventoryChange,
    },
    activeCustomers: {
      value: activeCustomers30d,
      changePercent: percentChange(activeCustomers30d, activeCustomersPrior30d),
      periodDays: 30,
    },
  };
}

async function getSalesPerformance(days) {
  const dayRange = buildDayRange(days);
  const start = dayRange[0].start;
  const end = dayRange[dayRange.length - 1].end;
  const rows = await aggregateSalesByDate(start, end);

  return {
    periodDays: days,
    currency: "GHS",
    series: fillDailySeries(dayRange, rows, "revenue"),
  };
}

async function getTopProducts(days, limit) {
  const dayRange = buildDayRange(days);
  const start = dayRange[0].start;
  const end = dayRange[dayRange.length - 1].end;

  const items = await Sale.aggregate([
    {
      $match: {
        status: { $ne: "voided" },
        timestamp: { $gte: start, $lte: end },
      },
    },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.name",
        productId: { $first: "$items.productId" },
        quantity: { $sum: "$items.quantity" },
        revenue: {
          $sum: { $multiply: ["$items.price", "$items.quantity"] },
        },
      },
    },
    { $sort: { quantity: -1, revenue: -1 } },
    { $limit: limit },
  ]);

  return {
    periodDays: days,
    currency: "GHS",
    items: items.map((row) => ({
      name: row._id,
      productId: row.productId,
      quantity: row.quantity,
      revenue: roundMoney(row.revenue || 0),
    })),
  };
}

async function getRecentSales(limit) {
  const sales = await Sale.find({ status: { $ne: "voided" } })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select(
      "receiptId items total time timestamp currency customer paymentMethod servedBy servedByName"
    )
    .lean();

  return sales.map((sale) => ({
    _id: sale._id,
    receiptId: sale.receiptId,
    itemsSummary: formatItemsSummary(sale.items),
    items: sale.items,
    total: roundMoney(sale.total || 0),
    currency: sale.currency || "GHS",
    time: sale.time,
    timestamp: sale.timestamp,
    customer: sale.customer,
    paymentMethod: sale.paymentMethod,
    servedByName: sale.servedByName || "",
    servedByUser: sale.servedBy
      ? { _id: sale.servedBy, name: sale.servedByName || "" }
      : null,
  }));
}

async function getRecentRestocks(limit) {
  const purchases = await Purchase.find()
    .sort({ date: -1, createdAt: -1 })
    .limit(Math.max(limit, 20))
    .populate("supplier", "name")
    .populate("lineItems.product", "name unit")
    .lean();

  const rows = [];
  for (const purchase of purchases) {
    const date =
      purchase.date instanceof Date
        ? toDateKey(purchase.date)
        : String(purchase.date).slice(0, 10);
    const supplierName = purchase.supplier?.name || "Unknown supplier";

    for (const lineItem of purchase.lineItems || []) {
      const product = lineItem.product;
      rows.push({
        _id: `${purchase._id}-${lineItem._id}`,
        purchaseId: purchase._id,
        item: product?.name || "Unknown product",
        productId: product?._id || lineItem.product,
        quantity: lineItem.quantity,
        quantityLabel: formatRestockQuantity(
          lineItem.quantity,
          product?.unit
        ),
        supplier: supplierName,
        supplierId: purchase.supplier?._id || purchase.supplier,
        date,
      });
    }
  }

  return rows.slice(0, limit);
}

async function getCashflow(days) {
  const dayRange = buildDayRange(days);
  const start = dayRange[0].start;
  const end = dayRange[dayRange.length - 1].end;

  const [incomeRows, expenseRows] = await Promise.all([
    aggregateSalesByDate(start, end),
    aggregatePurchaseSpendByDate(start, end),
  ]);

  return {
    periodDays: days,
    currency: "GHS",
    income: {
      title: `Income (last ${days} days)`,
      series: fillDailySeries(dayRange, incomeRows, "revenue").map(
        ({ date, day, revenue }) => ({
          date,
          day,
          amount: revenue,
        })
      ),
    },
    expenses: {
      title: `Expenses (last ${days} days)`,
      note: "Derived from purchase spend until an Expense model exists",
      series: fillDailySeries(dayRange, expenseRows, "amount"),
    },
  };
}

async function getLegacySummary() {
  const [
    productCount,
    lowStockCount,
    supplierCount,
    purchaseCount,
    salesAgg,
    recentSales,
    metrics,
  ] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({
      $expr: { $lte: ["$stockQuantity", "$reorderAt"] },
    }),
    Supplier.countDocuments({ status: "active" }),
    Purchase.countDocuments(),
    Sale.aggregate([
      { $match: { status: { $ne: "voided" } } },
      {
        $group: {
          _id: null,
          salesCount: { $sum: 1 },
          revenue: { $sum: "$total" },
        },
      },
    ]),
    getRecentSales(5),
    getMetrics(),
  ]);

  const purchases = await Purchase.find().populate("lineItems.product").lean();
  let outstandingPurchases = 0;
  for (const purchase of purchases) {
    outstandingPurchases += computePurchaseTotals(purchase).balance;
  }

  const salesRow = salesAgg[0] || { salesCount: 0, revenue: 0 };

  return {
    products: { total: productCount, lowStock: lowStockCount },
    suppliers: { active: supplierCount },
    purchases: {
      count: purchaseCount,
      outstanding: roundMoney(outstandingPurchases),
    },
    sales: {
      count: salesRow.salesCount,
      revenue: roundMoney(salesRow.revenue || 0),
      currency: "GHS",
    },
    metrics,
    recentSales,
  };
}

router.get("/summary", async (_req, res, next) => {
  try {
    res.json(await getLegacySummary());
  } catch (err) {
    next(err);
  }
});

router.get("/metrics", async (_req, res, next) => {
  try {
    res.json({ metrics: await getMetrics(), currency: "GHS" });
  } catch (err) {
    next(err);
  }
});

router.get("/sales-performance", async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 7);
    res.json(await getSalesPerformance(days));
  } catch (err) {
    next(err);
  }
});

router.get("/top-products", async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 7);
    const limit = parseLimit(req.query.limit, 5);
    res.json(await getTopProducts(days, limit));
  } catch (err) {
    next(err);
  }
});

router.get("/recent-sales", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 10);
    res.json({ items: await getRecentSales(limit) });
  } catch (err) {
    next(err);
  }
});

router.get("/recent-restocks", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 10);
    res.json({ items: await getRecentRestocks(limit) });
  } catch (err) {
    next(err);
  }
});

router.get("/cashflow", async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 7);
    res.json(await getCashflow(days));
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 7);
    const topLimit = parseLimit(req.query.topLimit, 5);
    const recentLimit = parseLimit(req.query.recentLimit, 10);

    const [
      metrics,
      salesPerformance,
      topProducts,
      recentSales,
      recentRestocks,
      cashflow,
    ] = await Promise.all([
      getMetrics(),
      getSalesPerformance(days),
      getTopProducts(days, topLimit),
      getRecentSales(recentLimit),
      getRecentRestocks(recentLimit),
      getCashflow(days),
    ]);

    res.json({
      metrics,
      salesPerformance,
      topProducts,
      recentSales,
      recentRestocks,
      cashflow,
      currency: "GHS",
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
