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
      { key: "warehouses", label: "Warehouses", description: "Manage warehouses and storage locations" },
      { key: "warehouse_transfers", label: "Warehouse Transfers", description: "Create and manage warehouse stock transfers" },
      { key: "goods_receipt", label: "Goods Receipt", description: "Receive supplier deliveries into warehouse stock" },
      { key: "goods_issue", label: "Goods Issue", description: "Request, pick, and issue stock from warehouses" },
      { key: "stock_counts", label: "Stock Counts", description: "Cycle counts and inventory variance adjustments" },
      { key: "all_categories", label: "All categories", description: "Access every shop section (not restricted by category assignment)" },
    ],
  },
  {
    group: "SALES",
    items: [
      { key: "sales_pos", label: "Sales (POS)", description: "Process point-of-sale transactions" },
      { key: "sales_reports", label: "Sales Reports", description: "View sales analytics" },
      {
        key: "sales_history",
        label: "Sales History",
        description:
          "View sales for any date and all cashiers (managers/admins). Without this, users only see their own sales for today.",
      },
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
      { key: "departments", label: "Departments", description: "Manage departments and divisions" },
      { key: "payroll", label: "Payroll", description: "Manage staff payroll" },
      { key: "staff_attendance", label: "Staff Attendance", description: "Track attendance records" },
      { key: "users", label: "Users", description: "Manage system users" },
      { key: "sms", label: "SMS", description: "Send and manage SMS messages" },
    ],
  },
  {
    group: "SYSTEM",
    items: [
      { key: "settings", label: "Settings", description: "Configure business and system settings" },
      { key: "manage_roles", label: "Manage roles", description: "Create and edit user roles and permissions" },
      { key: "approvals", label: "Approvals", description: "Review and decide approval requests" },
      { key: "audit_log", label: "Audit Log", description: "View system audit trail of user actions" },
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
