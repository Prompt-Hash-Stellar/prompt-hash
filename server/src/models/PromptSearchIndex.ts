import mongoose from "mongoose";

const schema = new mongoose.Schema({
  promptId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  category: { type: String, required: true, index: true },
  preview: { type: String, default: "", maxlength: 280 },
  tags: { type: [String], default: [], index: true },
  creator: { type: String, required: true, index: true },
  active: { type: Boolean, default: true, index: true },
  sourceLedger: { type: Number, required: true },
}, { timestamps: true });

schema.index({ title: "text", preview: "text", tags: "text" });
schema.index({ active: 1, createdAt: -1, _id: -1 });

export const PromptSearchIndex = mongoose.models.PromptSearchIndex || mongoose.model("PromptSearchIndex", schema);
