const mongoose = require("mongoose");

const ATTENDANCE_STATUSES = ["present", "absent", "late", "on_leave"];

const attendanceSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ATTENDANCE_STATUSES,
    },
  },
  { timestamps: true }
);

attendanceSchema.index({ staffId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1, status: 1 });

const Attendance = mongoose.model("Attendance", attendanceSchema);

module.exports = Attendance;
module.exports.ATTENDANCE_STATUSES = ATTENDANCE_STATUSES;
