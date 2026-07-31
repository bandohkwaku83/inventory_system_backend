const mongoose = require("mongoose");

/**
 * Connects to MongoDB using MONGODB_URI from the environment.
 * @returns {Promise<typeof mongoose>}
 */
async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set in the environment");
  }

  mongoose.set("strictQuery", true);

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
  } catch (err) {
    const local =
      /127\.0\.0\.1|localhost/i.test(uri) ||
      uri.startsWith("mongodb://mongo:");
    const hint = local
      ? " Start MongoDB (e.g. `brew services start mongodb-community` on macOS, or run `mongod`), or set MONGODB_URI to MongoDB Atlas."
      : " Check MONGODB_URI, Atlas IP allowlist, username/password, and that the cluster is running.";
    throw new Error(`${err.message}.${hint}`);
  }

  const { host, name } = mongoose.connection;
  console.log(`MongoDB connected (${host}, database: ${name})`);

  // MongoDB does not list a database until it has data; connecting alone does not create it.
  await mongoose.connection.db.collection("_meta").updateOne(
    { _id: "inventory-backend" },
    {
      $set: { lastStartedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  // Drop legacy unique SKU index so duplicate SKUs are allowed.
  // Same index name (sku_1) with different options is not replaced by createIndexes alone.
  try {
    const products = mongoose.connection.collection("products");
    const indexes = await products.indexes();
    const skuIndex = indexes.find((idx) => idx.name === "sku_1" && idx.unique);
    if (skuIndex) {
      await products.dropIndex("sku_1");
      console.log("Dropped unique products.sku_1 index (duplicates allowed)");
    }
  } catch (err) {
    if (err.code !== 26 && err.codeName !== "NamespaceNotFound") {
      console.warn("Could not inspect/drop products.sku_1:", err.message);
    }
  }

  return mongoose;
}

module.exports = { connectDb };
