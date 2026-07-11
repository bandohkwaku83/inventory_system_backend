/** Canonical entitlement keys and UI metadata for role management. */
const ENTITLEMENT_GROUPS = [
  {
    group: "OVERVIEW",
    items: [
      { key: "dashboard", label: "Dashboard", description: "View main dashboard" },
      { key: "charts", label: "Charts", description: "View analytics charts" },
    ],
  },
  {
    group: "CATALOG",
    items: [
      { key: "products", label: "Products", description: "Manage product catalog" },
      { key: "inventory", label: "Inventory", description: "View and adjust stock levels" },
      { key: "categories", label: "Categories", description: "Manage product categories" },
      { key: "price_list", label: "Price List", description: "View and export price lists" },
      { key: "suppliers", label: "Suppliers", description: "Manage suppliers" },
      { key: "purchases", label: "Purchases", description: "Record purchase orders" },
      { key: "all_categories", label: "All categories", description: "Access every shop section (not restricted by category assignment)" },
    ],
  },
  {
    group: "SALES",
    items: [
      { key: "sales_pos", label: "Sales (POS)", description: "Process point-of-sale transactions" },
      { key: "sales_reports", label: "Sales Reports", description: "View sales analytics" },
      { key: "receipts", label: "Receipts", description: "View and reprint receipts" },
    ],
  },
  {
    group: "FINANCE",
    items: [
      { key: "proforma_invoices", label: "Proforma Invoices", description: "Create proforma invoices" },
      { key: "customers", label: "Customers", description: "Manage customer records" },
      { key: "bank", label: "Bank", description: "Bank accounts and transactions" },
      { key: "expenses", label: "Expenses", description: "Track business expenses" },
      { key: "chart_of_accounts", label: "Chart of Accounts", description: "Manage accounting structure" },
      { key: "gra_reports", label: "GRA Reports", description: "View and export GRA tax reports" },
    ],
  },
  {
    group: "PEOPLE",
    items: [
      { key: "staff", label: "Staff", description: "Manage staff members" },
      { key: "payroll", label: "Payroll", description: "Manage staff payroll" },
      { key: "staff_attendance", label: "Staff Attendance", description: "Track attendance records" },
      { key: "users", label: "Users", description: "Manage system users" },
    ],
  },
  {
    group: "SYSTEM",
    items: [
      { key: "settings", label: "Settings", description: "Configure business and system settings" },
      { key: "manage_roles", label: "Manage roles", description: "Create and edit user roles and permissions" },
    ],
  },
];

const ALL_ENTITLEMENT_KEYS = ENTITLEMENT_GROUPS.flatMap((g) =>
  g.items.map((item) => item.key)
);

function isValidEntitlement(key) {
  return ALL_ENTITLEMENT_KEYS.includes(key);
}

function validateEntitlements(keys) {
  if (!Array.isArray(keys)) {
    return { error: "entitlements must be an array" };
  }
  const unique = [...new Set(keys.map(String))];
  const invalid = unique.filter((k) => !isValidEntitlement(k));
  if (invalid.length > 0) {
    return { error: `Unknown entitlements: ${invalid.join(", ")}` };
  }
  return { value: unique };
}

module.exports = {
  ENTITLEMENT_GROUPS,
  ALL_ENTITLEMENT_KEYS,
  isValidEntitlement,
  validateEntitlements,
};
