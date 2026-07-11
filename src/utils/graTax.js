const TAX_INCLUSIVE_MULTIPLIER = 1.219;

const RATES = {
  nhil: 0.025,
  getfund: 0.025,
  covid: 0.01,
  vat: 0.15,
};

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Break down a tax-inclusive total using Ghana GRA rules (multiplier 1.219).
 * @param {number} taxInclusiveTotal
 */
function computeGraBreakdown(taxInclusiveTotal) {
  const total = roundMoney(Math.max(0, Number(taxInclusiveTotal) || 0));
  if (total === 0) {
    return {
      total: 0,
      taxableValue: 0,
      nhil: 0,
      getfund: 0,
      covid: 0,
      vat: 0,
      leviesTotal: 0,
      taxInclusiveMultiplier: TAX_INCLUSIVE_MULTIPLIER,
    };
  }

  const taxableValue = roundMoney(total / TAX_INCLUSIVE_MULTIPLIER);
  const nhil = roundMoney(taxableValue * RATES.nhil);
  const getfund = roundMoney(taxableValue * RATES.getfund);
  const covid = roundMoney(taxableValue * RATES.covid);
  const leviesTotal = roundMoney(nhil + getfund + covid);
  const vatBase = roundMoney(taxableValue + leviesTotal);
  const vat = roundMoney(vatBase * RATES.vat);

  return {
    total,
    taxableValue,
    nhil,
    getfund,
    covid,
    vat,
    leviesTotal,
    taxInclusiveMultiplier: TAX_INCLUSIVE_MULTIPLIER,
  };
}

module.exports = {
  TAX_INCLUSIVE_MULTIPLIER,
  RATES,
  roundMoney,
  computeGraBreakdown,
};
