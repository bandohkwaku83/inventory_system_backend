const bcrypt = require("bcryptjs");
const Category = require("./models/Category");
const Department = require("./models/Department");
const User = require("./models/User");
const Role = require("./models/Role");
const Settings = require("./models/Settings");
const Warehouse = require("./models/Warehouse");
const { SETTINGS_DEFAULTS } = require("./models/Settings");
const { ALL_ENTITLEMENT_KEYS } = require("./constants/entitlements");

const DEFAULT_CATEGORIES = ["Lighting", "Sanitary Ware", "General"];

const DEFAULT_DEPARTMENTS = [
  { name: "Technical", divisions: ["Frontend", "Backend", "Sound"] },
  { name: "Media", divisions: ["Production", "Editing"] },
  { name: "Sales", divisions: ["Retail", "Wholesale"] },
  { name: "Stock", divisions: ["Receiving", "Dispatch"] },
  { name: "Delivery", divisions: [] },
  { name: "Admin", divisions: ["HR", "Operations"] },
  { name: "Finance", divisions: ["Accounts", "Payroll"] },
];

const DEFAULT_ROLES = [
  {
    slug: "admin",
    name: "Administrator",
    description: "Full access to all features",
    entitlements: ALL_ENTITLEMENT_KEYS,
    isSystem: true,
  },
  {
    slug: "warehouse_manager",
    name: "Warehouse Manager",
    description: "Approve requests and manage inventory across warehouses",
    entitlements: [
      "dashboard",
      "charts",
      "products",
      "inventory",
      "categories",
      "suppliers",
      "purchases",
      "warehouses",
      "warehouse_transfers",
      "goods_receipt",
      "goods_issue",
      "stock_counts",
      "all_categories",
      "approvals",
      "audit_log",
      "sales_reports",
      "sales_history",
    ],
    isSystem: true,
  },
  {
    slug: "store_keeper",
    name: "Store Keeper",
    description: "Receive goods, pick and issue stock, perform cycle counts",
    entitlements: [
      "dashboard",
      "products",
      "inventory",
      "warehouses",
      "warehouse_transfers",
      "goods_receipt",
      "goods_issue",
      "stock_counts",
      "suppliers",
    ],
    isSystem: true,
  },
  {
    slug: "requester",
    name: "Requester",
    description: "Request products from warehouses",
    entitlements: ["dashboard", "products", "inventory", "goods_issue"],
    isSystem: true,
  },
  {
    slug: "auditor",
    name: "Auditor",
    description: "View reports, movement history, and audit trail",
    entitlements: [
      "dashboard",
      "charts",
      "products",
      "inventory",
      "warehouses",
      "sales_reports",
      "sales_history",
      "receipts",
      "gra_reports",
      "audit_log",
    ],
    isSystem: true,
  },
  {
    slug: "cashier",
    name: "Cashier",
    description: "Point-of-sale and catalog access (today's own sales only)",
    entitlements: [
      "dashboard",
      "products",
      "inventory",
      "price_list",
      "sales_pos",
      "sales_reports",
      "receipts",
      "proforma_invoices",
      "customers",
    ],
    isSystem: true,
  },
  {
    slug: "sales",
    name: "Sales",
    description: "Sales floor POS and customer access (today's own sales only)",
    entitlements: [
      "dashboard",
      "products",
      "inventory",
      "price_list",
      "sales_pos",
      "sales_reports",
      "receipts",
      "proforma_invoices",
      "customers",
    ],
    isSystem: true,
  },
  {
    slug: "sales_manager",
    name: "Sales Manager",
    description: "POS plus full sales history across all cashiers",
    entitlements: [
      "dashboard",
      "charts",
      "products",
      "inventory",
      "price_list",
      "sales_pos",
      "sales_reports",
      "sales_history",
      "receipts",
      "proforma_invoices",
      "customers",
    ],
    isSystem: true,
  },
  {
    slug: "gra_reporter",
    name: "GRA Reporter",
    description: "GRA tax reporting and sales visibility",
    entitlements: [
      "dashboard",
      "charts",
      "sales_reports",
      "sales_history",
      "receipts",
      "gra_reports",
    ],
    isSystem: true,
  },
];

const ADMIN_USER = {
  name: "Administrator",
  email: "bandohkwaku@gmail.com",
  password: "123456",
  roleSlug: "admin",
};

const DEFAULT_USERS = [
  {
    name: "GRA Reporter",
    email: "gra@ladepuls.com",
    roleSlug: "gra_reporter",
    categoryNames: [],
  },
  {
    name: "Lighting Cashier",
    email: "light@ladepuls.com",
    roleSlug: "cashier",
    categoryNames: ["Lighting"],
  },
  {
    name: "Multi-Section Cashier",
    email: "multi@ladepuls.com",
    roleSlug: "cashier",
    categoryNames: ["Lighting", "Sanitary Ware"],
  },
];

async function seedCategories() {
  for (const name of DEFAULT_CATEGORIES) {
    await Category.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true });
  }
}

async function seedDepartments() {
  for (const dept of DEFAULT_DEPARTMENTS) {
    await Department.updateOne(
      { name: dept.name },
      {
        $setOnInsert: {
          name: dept.name,
          divisions: dept.divisions.map((name) => ({ name })),
        },
      },
      { upsert: true }
    );
  }
}

async function seedSettings() {
  await Settings.updateOne(
    { _id: "app" },
    {
      $setOnInsert: {
        business: { ...SETTINGS_DEFAULTS.business },
        receipt: { ...SETTINGS_DEFAULTS.receipt },
      },
    },
    { upsert: true }
  );
}

async function upsertSystemRole(role) {
  const payload = {
    description: role.description,
    entitlements: role.entitlements,
    isSystem: true,
  };

  const bySlug = await Role.findOne({ slug: role.slug });
  if (bySlug) {
    try {
      await Role.updateOne(
        { _id: bySlug._id },
        { $set: { ...payload, name: role.name } }
      );
    } catch (err) {
      // Name may collide with another role under case-insensitive unique index.
      if (err.code === 11000) {
        await Role.updateOne({ _id: bySlug._id }, { $set: payload });
        console.warn(
          `[seed] Role "${role.slug}" kept existing name "${bySlug.name}" (name conflict with "${role.name}")`
        );
        return;
      }
      throw err;
    }
    return;
  }

  // Reuse an existing role with the same display name (common on prod after manual creates).
  const byName = await Role.findOne({ name: role.name }).collation({
    locale: "en",
    strength: 2,
  });
  if (byName) {
    if (byName.slug && byName.slug !== role.slug) {
      console.warn(
        `[seed] Role name "${role.name}" already used by slug "${byName.slug}"; skipping create of "${role.slug}"`
      );
      return;
    }
    await Role.updateOne(
      { _id: byName._id },
      { $set: { ...payload, slug: role.slug, name: role.name } }
    );
    return;
  }

  try {
    await Role.create({
      slug: role.slug,
      name: role.name,
      ...payload,
    });
  } catch (err) {
    if (err.code === 11000) {
      console.warn(
        `[seed] Skipped creating role "${role.slug}" due to duplicate key: ${err.message}`
      );
      return;
    }
    throw err;
  }
}

async function seedRoles() {
  for (const role of DEFAULT_ROLES) {
    await upsertSystemRole(role);
  }

  // Keep admin entitlements in sync with the canonical key list.
  await Role.updateOne(
    { slug: "admin" },
    { $set: { entitlements: ALL_ENTITLEMENT_KEYS, isSystem: true } }
  );
}

async function migrateLegacyUsers() {
  const roles = await Role.find().lean();
  const bySlug = new Map(roles.filter((r) => r.slug).map((r) => [r.slug, r._id]));

  const legacyUsers = await User.find({
    $or: [{ roleId: { $exists: false } }, { role: { $exists: true } }],
  }).lean();

  for (const u of legacyUsers) {
    const slug = u.role || "cashier";
    const roleId = bySlug.get(slug);
    if (!roleId) continue;

    await User.updateOne(
      { _id: u._id },
      {
        $set: { roleId },
        $unset: { role: "" },
      }
    );
  }
}

async function seedAdminUser() {
  const passwordHash = await bcrypt.hash(ADMIN_USER.password, 10);
  const roles = await Role.find().lean();
  const roleId = roles.find((r) => r.slug === ADMIN_USER.roleSlug)?._id;
  if (!roleId) return;

  await User.updateOne(
    { email: ADMIN_USER.email.toLowerCase() },
    {
      $set: {
        name: ADMIN_USER.name,
        email: ADMIN_USER.email.toLowerCase(),
        passwordHash,
        roleId,
        categoryIds: [],
        active: true,
      },
    },
    { upsert: true }
  );

  await User.deleteOne({ email: "admin@ladepuls.com" });
}

async function seedUsers(defaultPassword) {
  const passwordHash = await bcrypt.hash(defaultPassword, 10);
  const categories = await Category.find().lean();
  const byName = new Map(categories.map((c) => [c.name, c._id]));
  const roles = await Role.find().lean();
  const roleBySlug = new Map(roles.filter((r) => r.slug).map((r) => [r.slug, r._id]));

  for (const u of DEFAULT_USERS) {
    const categoryIds = u.categoryNames
      .map((n) => byName.get(n))
      .filter(Boolean);
    const roleId = roleBySlug.get(u.roleSlug);
    if (!roleId) continue;

    await User.updateOne(
      { email: u.email.toLowerCase() },
      {
        $setOnInsert: {
          name: u.name,
          email: u.email.toLowerCase(),
          passwordHash,
          roleId,
          categoryIds,
          active: true,
        },
      },
      { upsert: true }
    );
  }

  await migrateLegacyUsers();
}

async function seedDefaultWarehouse() {
  const count = await Warehouse.countDocuments();
  if (count > 0) return;

  await Warehouse.create({
    code: "MAIN",
    name: "Main Warehouse",
    description: "Default primary warehouse",
    address: "Main Street",
    city: "Accra",
    phone: "+233 00 000 0000",
    isDefault: true,
    status: "active",
  });
}

/**
 * Idempotent seed for categories, settings, roles, and default users.
 */
async function runSeed() {
  const defaultPassword =
    process.env.SEED_DEFAULT_PASSWORD || "ChangeMe123!";

  await seedCategories();
  await seedDepartments();
  await seedSettings();
  await seedRoles();
  await seedAdminUser();
  await seedUsers(defaultPassword);
  await seedDefaultWarehouse();

  console.log(
    `Seed complete (default user password: ${defaultPassword === process.env.SEED_DEFAULT_PASSWORD ? "from SEED_DEFAULT_PASSWORD" : "ChangeMe123!"})`
  );
}

module.exports = {
  runSeed,
  DEFAULT_CATEGORIES,
  DEFAULT_DEPARTMENTS,
  DEFAULT_ROLES,
  ADMIN_USER,
  DEFAULT_USERS,
};
