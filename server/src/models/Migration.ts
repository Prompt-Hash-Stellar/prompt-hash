import mongoose from "mongoose";

const migrationSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    appliedAt: { type: Date, default: Date.now },
  },
  { collection: "_migrations" }
);

export const MigrationModel = mongoose.model("Migration", migrationSchema);
