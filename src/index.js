require("dotenv").config();

const path = require("path");
const cors = require("cors");
const express = require("express");
const mongoose = require("mongoose");

const { connectDb } = require("./db");
const { runSeed } = require("./seed");
const categoriesRouter = require("./routes/categories");
const productsRouter = require("./routes/products");
const {
  router: suppliersByIdRouter,
  createSupplier,
  listSuppliers,
  getSuppliersSummary,
} = require("./routes/suppliers");
const {
  router: purchasesByIdRouter,
  createPurchase,
  listPurchases,
  getPurchasesSummary,
} = require("./routes/purchases");
const { PRODUCT_UNITS } = require("./models/Product");
const {
  SUPPLIER_CATEGORIES,
  SUPPLIER_STATUSES,
} = require("./models/Supplier");
const salesRouter = require("./routes/sales");
const { router: customersRouter } = require("./routes/customers");
const authRouter = require("./routes/auth");
const usersRouter = require("./routes/users");
const rolesRouter = require("./routes/roles");
const settingsRouter = require("./routes/settings");
const proformasRouter = require("./routes/proformas");
const reportsRouter = require("./routes/reports");
const dashboardRouter = require("./routes/dashboard");
const staffRouter = require("./routes/staff");
const { router: departmentsRouter } = require("./routes/departments");
const attendanceRouter = require("./routes/attendance");
const expensesRouter = require("./routes/expenses");
const { router: warehousesRouter } = require("./routes/warehouses");
const { router: stockMovementsRouter } = require("./routes/stockMovements");
const { router: transfersRouter } = require("./routes/transfers");
const { router: approvalsRouter } = require("./routes/approvals");
const { router: goodsReceiptsRouter } = require("./routes/goodsReceipts");
const { router: goodsIssuesRouter } = require("./routes/goodsIssues");
const { router: stockCountsRouter } = require("./routes/stockCounts");
const { router: auditLogsRouter } = require("./routes/auditLogs");
const smsRouter = require("./routes/sms");

const app = express();
const PORT = Number(process.env.PORT) || 8000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

app.use((req, _res, next) => {
  if (req.url.startsWith("//")) {
    req.url = req.url.replace(/^\/+/, "/");
  }
  next();
});

app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
    ],
  })
);
app.use(express.json());

app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "uploads"))
);

app.use("/api/categories", categoriesRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/roles", rolesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/proformas", proformasRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/staff", staffRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/expenses", expensesRouter);
app.use("/api/warehouses", warehousesRouter);
app.use("/api/stock-movements", stockMovementsRouter);
app.use("/api/warehouse-transfers", transfersRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/goods-receipts", goodsReceiptsRouter);
app.use("/api/goods-issues", goodsIssuesRouter);
app.use("/api/stock-counts", stockCountsRouter);
app.use("/api/audit-logs", auditLogsRouter);
app.use("/api/sms", smsRouter);

app.get("/api", (_req, res) => {
  res.json({
    service: "inventory-backend",
    port: PORT,
    endpoints: {
      health: "/health",
      auth: "/api/auth/login, /api/auth/logout, /api/auth/me, /api/auth/forgot-password, /api/auth/reset-password, /api/auth/change-password",
      users: "/api/users",
      roles: "/api/roles",
      roleEntitlements: "/api/roles/entitlements",
      settings: "/api/settings",
      categories: "/api/categories",
      products: "/api/products",
      suppliers: "/api/suppliers",
      supplierMetaCategories: "/api/suppliers/meta/categories",
      supplierMetaStatuses: "/api/suppliers/meta/statuses",
      suppliersSummary: "/api/suppliers/summary",
      purchases: "/api/purchases",
      purchasesSummary: "/api/purchases/summary",
      sales: "/api/sales",
      salePatch: "/api/sales/:id (PATCH)",
      saleVoid: "/api/sales/:id/void (PATCH)",
      customers: "/api/customers",
      proformas: "/api/proformas",
      dashboard: "/api/dashboard",
      dashboardSummary: "/api/dashboard/summary",
      dashboardMetrics: "/api/dashboard/metrics",
      dashboardSalesPerformance: "/api/dashboard/sales-performance",
      dashboardTopProducts: "/api/dashboard/top-products",
      dashboardRecentSales: "/api/dashboard/recent-sales",
      dashboardRecentRestocks: "/api/dashboard/recent-restocks",
      dashboardCashflow: "/api/dashboard/cashflow",
      staff: "/api/staff",
      staffMeta: "/api/staff/meta",
      staffSummary: "/api/staff/summary",
      departments: "/api/departments",
      departmentDivisions: "/api/departments/:id/divisions",
      attendance: "/api/attendance",
      attendanceDaily: "/api/attendance/daily",
      attendanceHistory: "/api/attendance/history",
      attendanceMarkAllPresent: "/api/attendance/mark-all-present (POST)",
      expenses: "/api/expenses",
      expensesMeta: "/api/expenses/meta",
      expensesSummary: "/api/expenses/summary",
      expenseMarkPaid: "/api/expenses/:id/mark-paid (PATCH)",
      warehouses: "/api/warehouses",
      warehouseMeta: "/api/warehouses/meta",
      warehouseLocations: "/api/warehouses/:id/locations",
      warehouseStructure: "/api/warehouses/:id/structure",
      warehouseInventory: "/api/warehouses/:id/inventory",
      warehouseHistory: "/api/warehouses/:id/history",
      warehouseAssignLocation: "/api/warehouses/:id/assign-location (POST)",
      stockMovements: "/api/stock-movements",
      stockMovementsMeta: "/api/stock-movements/meta",
      warehouseTransfers: "/api/warehouse-transfers",
      warehouseTransferSubmit: "/api/warehouse-transfers/:id/submit (POST)",
      warehouseTransferApprove: "/api/warehouse-transfers/:id/approve (POST)",
      warehouseTransferReceive: "/api/warehouse-transfers/:id/receive (POST)",
      goodsReceipts: "/api/goods-receipts",
      goodsIssues: "/api/goods-issues",
      stockCounts: "/api/stock-counts",
      auditLogs: "/api/audit-logs",
      sms: "/api/sms",
      smsMeta: "/api/sms/meta",
      smsSend: "/api/sms/send (POST)",
      approvals: "/api/approvals",
      approvalsSummary: "/api/approvals/summary",
      approvalApprove: "/api/approvals/:id/approve (POST)",
      approvalReject: "/api/approvals/:id/reject (POST)",
      graReports: "/api/reports/gra",
      productUnits: "/api/products/meta/units",
      productSearch: "/api/products/search",
      productLookupSku: "/api/products/lookup/sku/:sku",
    },
  });
});

app.get("/api/products/meta/units", (_req, res) => {
  res.json({ units: PRODUCT_UNITS });
});

app.use("/api/products", productsRouter);
app.use("/api/sales", salesRouter);
app.use("/api/customers", customersRouter);

app.get("/api/suppliers/meta/categories", (_req, res) => {
  res.json({ categories: SUPPLIER_CATEGORIES });
});

app.get("/api/suppliers/meta/statuses", (_req, res) => {
  res.json({ statuses: SUPPLIER_STATUSES });
});

app.get("/api/suppliers/summary", getSuppliersSummary);

app.post("/api/suppliers", createSupplier);
app.get("/api/suppliers", listSuppliers);
app.use("/api/suppliers", suppliersByIdRouter);

app.post("/api/purchases", createPurchase);
app.get("/api/purchases/summary", getPurchasesSummary);
app.get("/api/purchases", listPurchases);
app.use("/api/purchases", purchasesByIdRouter);

app.get("/health", (_req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.json({
    ok: true,
    mongodb: dbConnected ? "connected" : "disconnected",
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: "Not Found",
    service: "inventory-backend",
    hint:
      "If you expected inventory routes here, restart this server — or GET /api to verify this process.",
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    message: err.message || "Something went wrong",
    error: err.message || "Something went wrong",
  });
});

async function start() {
  await connectDb();
  try {
    await runSeed();
  } catch (err) {
    console.error("Seed failed (server will still start):", err.message);
  }

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`API index: GET http://localhost:${PORT}/api`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
