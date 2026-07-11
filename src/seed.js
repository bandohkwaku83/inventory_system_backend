const bcrypt = require("bcryptjs");
const Category = require("./models/Category");
const User = require("./models/User");
const Role = require("./models/Role");
const Settings = require("./models/Settings");
const { SETTINGS_DEFAULTS } = require("./models/Settings");
const { ALL_ENTITLEMENT_KEYS } = require("./constants/entitlements");

const DEFAULT_CATEGORIES = ["Lighting", "Sanitary Ware", "General"];

const DEFAULT_ROLES = [
  {
    slug: "admin",
    name: "Administrator",
    description: "Full access to all features",
    entitlements: ALL_ENTITLEMENT_KEYS,
    isSystem: true,
  },
  {
    slug: "cashier",
    name: "Cashier",
    description: "Point-of-sale and catalog access",
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
    slug: "gra_reporter",
    name: "GRA Reporter",
    description: "GRA tax reporting and sales visibility",
    entitlements: [
      "dashboard",
      "charts",
      "sales_reports",
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

async function seedRoles() {
  for (const role of DEFAULT_ROLES) {
    await Role.updateOne(
      { slug: role.slug },
      {
        $setOnInsert: {
          name: role.name,
          description: role.description,
          entitlements: role.entitlements,
          isSystem: role.isSystem,
        },
      },
      { upsert: true }
    );
  }

  // Keep admin entitlements in sync with the canonical key list.
  await Role.updateOne(
    { slug: "admin" },
    { $set: { entitlements: ALL_ENTITLEMENT_KEYS } }
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

/**
 * Idempotent seed for categories, settings, roles, and default users.
 */
async function runSeed() {
  const defaultPassword =
    process.env.SEED_DEFAULT_PASSWORD || "ChangeMe123!";

  await seedCategories();
  await seedSettings();
  await seedRoles();
  await seedAdminUser();
  await seedUsers(defaultPassword);

  console.log(
    `Seed complete (default user password: ${defaultPassword === process.env.SEED_DEFAULT_PASSWORD ? "from SEED_DEFAULT_PASSWORD" : "ChangeMe123!"})`
  );
}

module.exports = { runSeed, DEFAULT_CATEGORIES, DEFAULT_ROLES, ADMIN_USER, DEFAULT_USERS };
