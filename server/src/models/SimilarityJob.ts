/**
 * SimilarityJob Model — Queued, retryable similarity scan jobs
 *
 * Stores metadata about pending/completed/failed similarity scans with:
 * - Versioned algorithm/index state
 * - Budget tracking (candidate limit, memory, time)
 * - Retry state and error history
 * - Privacy-preserving result storage
 */

import mongoose, { Document, Schema } from "mongoose";

export interface ISimilarityJob extends Document {
  // Primary reference
  promptId: string;
  onChainId: string;

  // Algorithm version (to ensure reproducibility)
  algorithmVersion: string; // e.g., "1.0"
  indexVersion: string; // e.g., "1.0" — fingerprint index format version

  // Job state
  status: "pending" | "processing" | "completed" | "failed";
  
  // For reproducible results: hash of algorithm parameters
  algorithmHash: string;

  // Processing metadata
  startedAt: Date | null;
  completedAt: Date | null;

  // Result (privacy-preserving)
  similarityFlag: "clean" | "suspicious" | "highly_similar" | null;
  similarityScore: number | null;
  similarTo: string | null; // onChainId of most similar prompt

  // Budget tracking
  candidatesScanned: number;
  memoryUsedBytes: number;
  processingTimeMs: number;

  // Budget limits (enforced during scan)
  candidateLimit: number; // max number of candidates to compare
  memoryLimitBytes: number;
  timeLimitMs: number;

  // Retry state
  attemptCount: number;
  maxRetries: number;
  lastError: string | null;
  errorHistory: Array<{
    timestamp: Date;
    error: string;
    attemptNumber: number;
  }>;

  // Expiration (cleanup old jobs)
  expiresAt: Date;
}

const similarityJobSchema = new Schema<ISimilarityJob>(
  {
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    onChainId: {
      type: String,
      required: true,
      index: true,
    },
    algorithmVersion: {
      type: String,
      required: true,
      default: "1.0",
    },
    indexVersion: {
      type: String,
      required: true,
      default: "1.0",
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    algorithmHash: {
      type: String,
      required: true,
      index: true, // for grouping deterministic results
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    similarityFlag: {
      type: String,
      enum: ["clean", "suspicious", "highly_similar", null],
      default: null,
    },
    similarityScore: {
      type: Number,
      default: null,
      min: 0,
      max: 1,
    },
    similarTo: {
      type: String,
      default: null,
    },
    candidatesScanned: {
      type: Number,
      default: 0,
      min: 0,
    },
    memoryUsedBytes: {
      type: Number,
      default: 0,
      min: 0,
    },
    processingTimeMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    candidateLimit: {
      type: Number,
      default: 10000, // reasonable default for large corpus
      min: 1,
    },
    memoryLimitBytes: {
      type: Number,
      default: 100 * 1024 * 1024, // 100 MB
      min: 1024 * 1024, // at least 1 MB
    },
    timeLimitMs: {
      type: Number,
      default: 60 * 1000, // 60 seconds
      min: 1000, // at least 1 second
    },
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxRetries: {
      type: Number,
      default: 3,
      min: 0,
    },
    lastError: {
      type: String,
      default: null,
    },
    errorHistory: {
      type: [
        {
          timestamp: Date,
          error: String,
          attemptNumber: Number,
        },
      ],
      default: [],
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      index: { expireAfterSeconds: 0 }, // auto-delete after expiration
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient pending job retrieval
similarityJobSchema.index({ status: 1, createdAt: 1 });

const SimilarityJob =
  mongoose.models.SimilarityJob || mongoose.model<ISimilarityJob>("SimilarityJob", similarityJobSchema);

export default SimilarityJob;
