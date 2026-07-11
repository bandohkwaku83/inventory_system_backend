const mongoose = require("mongoose");

const STAFF_GENDERS = ["male", "female", "other"];

const STAFF_RELATIONSHIPS = [
  "spouse",
  "parent",
  "sibling",
  "child",
  "relative",
  "friend",
  "other",
];

const STAFF_DEPARTMENTS = [
  "sales",
  "stock",
  "delivery",
  "admin",
  "finance",
  "other",
];

const STAFF_EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "casual",
];

const STAFF_STATUSES = ["active", "inactive"];

const emergencyContactSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    relationship: {
      type: String,
      required: true,
      enum: STAFF_RELATIONSHIPS,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    alternatePhone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
  },
  { _id: false }
);

const staffSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    employeeId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      unique: true,
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      enum: STAFF_GENDERS,
    },
    ghanaCardId: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 20,
      default: "",
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: "",
    },
    city: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    residentialAddress: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    emergencyContact: {
      type: emergencyContactSchema,
      required: true,
    },
    role: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    department: {
      type: String,
      enum: STAFF_DEPARTMENTS,
    },
    hireDate: {
      type: Date,
      required: true,
    },
    employmentType: {
      type: String,
      enum: STAFF_EMPLOYMENT_TYPES,
      default: "full_time",
    },
    status: {
      type: String,
      enum: STAFF_STATUSES,
      default: "active",
    },
    baseSalary: {
      type: Number,
      min: 0,
      default: 0,
    },
    transport: {
      type: Number,
      min: 0,
      default: 0,
    },
    otherAllowances: {
      type: Number,
      min: 0,
      default: 0,
    },
    ssnitDeduction: {
      type: Number,
      min: 0,
      default: 0,
    },
    payeDeduction: {
      type: Number,
      min: 0,
      default: 0,
    },
    bankName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    accountNumber: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
  },
  { timestamps: true }
);

staffSchema.index({ fullName: "text", employeeId: "text", role: "text", phone: "text" });
staffSchema.index({ status: 1, fullName: 1 });

const Staff = mongoose.model("Staff", staffSchema);

module.exports = Staff;
module.exports.STAFF_GENDERS = STAFF_GENDERS;
module.exports.STAFF_RELATIONSHIPS = STAFF_RELATIONSHIPS;
module.exports.STAFF_DEPARTMENTS = STAFF_DEPARTMENTS;
module.exports.STAFF_EMPLOYMENT_TYPES = STAFF_EMPLOYMENT_TYPES;
module.exports.STAFF_STATUSES = STAFF_STATUSES;
