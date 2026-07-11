const express = require("express");
const Sale = require("../models/Sale");
const { roundMoney, computeGraBreakdown } = require("../utils/graTax");

const router = express.Router();

function parseDateRange(fromRaw, toRaw) {
  const filter = {};
  if (fromRaw && String(fromRaw).trim()) {
    const from = new Date(String(fromRaw).trim());
    if (!Number.isNaN(from.getTime())) {
      filter.$gte = from;
    }
  }
  if (toRaw && String(toRaw).trim()) {
    const to = new Date(String(toRaw).trim());
    if (!Number.isNaN(to.getTime())) {
      filter.$lte = to;
    }
  }
  return Object.keys(filter).length ? filter : null;
}

async function getGraReport(req, res, next) {
  try {
    const dateFilter = parseDateRange(req.query.from, req.query.to);
    const match = { status: { $ne: "voided" } };
    if (dateFilter) {
      match.timestamp = dateFilter;
    }

    const sales = await Sale.find(match).sort({ timestamp: 1 }).lean();

    let grossSales = 0;
    let totalDiscount = 0;
    const aggregated = {
      taxableValue: 0,
      nhil: 0,
      getfund: 0,
      covid: 0,
      vat: 0,
    };

    const saleRows = sales.map((s) => {
      grossSales = roundMoney(grossSales + (s.subtotal || 0));
      totalDiscount = roundMoney(totalDiscount + (s.discount || 0));
      const breakdown =
        s.taxBreakdown || computeGraBreakdown(s.total || 0);

      aggregated.taxableValue = roundMoney(
        aggregated.taxableValue + breakdown.taxableValue
      );
      aggregated.nhil = roundMoney(aggregated.nhil + breakdown.nhil);
      aggregated.getfund = roundMoney(aggregated.getfund + breakdown.getfund);
      aggregated.covid = roundMoney(aggregated.covid + breakdown.covid);
      aggregated.vat = roundMoney(aggregated.vat + breakdown.vat);

      return {
        _id: s._id,
        receiptId: s.receiptId,
        date: s.date,
        time: s.time,
        customer: s.customer,
        subtotal: s.subtotal,
        discount: s.discount,
        total: s.total,
        paymentMethod: s.paymentMethod,
        taxBreakdown: breakdown,
      };
    });

    const netSales = roundMoney(grossSales - totalDiscount);

    res.json({
      period: {
        from: req.query.from || null,
        to: req.query.to || null,
      },
      summary: {
        transactionCount: sales.length,
        grossSales,
        totalDiscount,
        netSales,
        ...aggregated,
        currency: "GHS",
      },
      sales: saleRows,
    });
  } catch (err) {
    next(err);
  }
}

router.get("/gra", getGraReport);
router.get("/gra-reports", getGraReport);

module.exports = router;
