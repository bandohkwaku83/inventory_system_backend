function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** `p` is a plain object or lean doc with `lineItems` and `amountPaid` */
function computePurchaseTotals(p) {
  const lineItems = p.lineItems || [];
  const purchaseTotal = roundMoney(
    lineItems.reduce((s, li) => {
      const q = li.quantity ?? 0;
      const up = li.unitPrice ?? 0;
      return s + q * up;
    }, 0)
  );
  const paid = roundMoney(p.amountPaid ?? 0);
  const balance = roundMoney(Math.max(0, purchaseTotal - paid));

  let paymentStatus = "unpaid";
  if (purchaseTotal <= 0) {
    paymentStatus = paid > 0 ? "paid" : "unpaid";
  } else if (paid <= 0) {
    paymentStatus = "unpaid";
  } else if (balance <= 0.005) {
    paymentStatus = "paid";
  } else {
    paymentStatus = "partial";
  }

  return {
    purchaseTotal,
    amountPaid: paid,
    balance,
    paymentStatus,
    currency: p.currency || "GHS",
  };
}

/** Attach totals to a single purchase object for API JSON */
function enrichPurchase(p) {
  if (!p) {
    return p;
  }
  const totals = computePurchaseTotals(p);
  const out = { ...p, ...totals };
  if (out.date instanceof Date) {
    out.date = out.date.toISOString().slice(0, 10);
  } else if (typeof out.date === "string" && out.date.length > 10) {
    out.date = out.date.slice(0, 10);
  }
  return out;
}

module.exports = {
  roundMoney,
  computePurchaseTotals,
  enrichPurchase,
};
