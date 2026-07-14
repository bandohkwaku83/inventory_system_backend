const Warehouse = require("../models/Warehouse");
const StorageLocation = require("../models/StorageLocation");

/**
 * Build composite location path: WH001-A-02-15
 */
async function buildLocationFullPath(warehouseId, code, parentId) {
  const warehouse = await Warehouse.findById(warehouseId).select("code").lean();
  const parts = [];
  if (warehouse?.code) parts.push(String(warehouse.code).toUpperCase());

  const ancestorCodes = [];
  let currentParent = parentId || null;
  const seen = new Set();
  while (currentParent) {
    if (seen.has(String(currentParent))) break;
    seen.add(String(currentParent));
    const parent = await StorageLocation.findById(currentParent)
      .select("code parent")
      .lean();
    if (!parent) break;
    ancestorCodes.unshift(String(parent.code).toUpperCase());
    currentParent = parent.parent || null;
  }

  parts.push(...ancestorCodes, String(code).toUpperCase());
  return parts.filter(Boolean).join("-");
}

module.exports = { buildLocationFullPath };
