const express = require("express");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const Product = require("../models/Product");

const router = express.Router();

router.get("/", async (_req, res, next) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).lean();
    res.json(categories);
  } catch (err) {
    next(err);
  }
});

router.post("/", express.json(), async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Import-friendly: reuse an existing category instead of failing on duplicate names.
    const existing = await Category.findOne({ name }).collation({
      locale: "en",
      strength: 2,
    });
    if (existing) {
      res.status(200).json(existing);
      return;
    }

    try {
      const doc = await Category.create({ name });
      res.status(201).json(doc);
    } catch (err) {
      if (err.code === 11000) {
        const again = await Category.findOne({ name }).collation({
          locale: "en",
          strength: 2,
        });
        if (again) {
          res.status(200).json(again);
          return;
        }
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid category id" });
      return;
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const category = await Category.findByIdAndUpdate(
      id,
      { name },
      { new: true, runValidators: true }
    ).lean();

    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    res.json(category);
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ error: "A category with this name already exists" });
      return;
    }
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid category id" });
      return;
    }

    const inUse = await Product.countDocuments({ category: id });
    if (inUse > 0) {
      res.status(409).json({
        error: "Cannot delete a category that has products assigned",
      });
      return;
    }

    const removed = await Category.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
