/**
 * Similarity Worker — Processes queued scans with budget enforcement
 *
 * Handles:
 * - Bounded candidate selection (avoids quadratic growth)
 * - Memory budget enforcement
 * - CPU/time budget enforcement
 * - Deterministic fingerprint-based comparison
 * - Graceful degradation under load
 * - Error recovery and retry logic
 */

import Prompt from "../models/Prompt";
import SimilarityJob, { ISimilarityJob } from "../models/SimilarityJob";
import {
  generateFingerprint,
  fingerprintSimilarity,
  fingerprintMemoryBytes,
  PromptFingerprint,
} from "./fingerprintService";
import { classifyScore, SIMILARITY_THRESHOLDS } from "./similarityDetection";
import crypto from "crypto";

// Deterministic algorithm parameters for reproducibility
const ALGORITHM_VERSION = "1.0";
const INDEX_VERSION = "1.0";

function getAlgorithmHash(): string {
  const params = `${ALGORITHM_VERSION}:${INDEX_VERSION}:minHashWeight=0.6`;
  return crypto.createHash("sha256").update(params).digest("hex");
}

export interface WorkerBudget {
  maxCandidates: number;
  maxMemoryBytes: number;
  maxTimeMs: number;
}

export interface WorkerStats {
  candidatesScanned: number;
  memoryUsedBytes: number;
  processingTimeMs: number;
  budgetExceeded: string | null; // which budget limit was hit
}

const DEFAULT_BUDGET: WorkerBudget = {
  maxCandidates: 10000,
  maxMemoryBytes: 100 * 1024 * 1024, // 100 MB
  maxTimeMs: 60 * 1000, // 60 seconds
};

/**
 * Select a bounded set of candidate prompts for comparison
 * Strategies:
 * - Recent prompts (more likely to be similar to new ones)
 * - Random sampling for statistical coverage
 * - Prompts in same category (if applicable)
 */
async function selectCandidates(
  excludeOnChainId: string,
  limit: number,
): Promise<Array<{ onChainId: string; fingerprint: PromptFingerprint }>> {
  // Fetch recent active prompts (weighted towards recent)
  const candidates = await Prompt.find(
    {
      onChainId: { $ne: excludeOnChainId },
      isActive: true,
      fingerprint: { $exists: true },
    },
    {
      onChainId: 1,
      fingerprintVersion: 1,
      fingerprint: 1,
      createdAt: 1,
    },
  )
    .sort({ createdAt: -1 }) // Recent first
    .limit(limit)
    .lean();

  return candidates
    .filter((p) => p.fingerprint && p.fingerprintVersion === INDEX_VERSION)
    .map((p) => ({
      onChainId: p.onChainId,
      fingerprint: {
        version: p.fingerprintVersion,
        minHash: p.fingerprint.minHash,
        tokenHistogram: new Uint8Array(p.fingerprint.tokenHistogram),
        contentHash: p.fingerprint.contentHash,
        tokenCount: p.fingerprint.tokenCount,
        length: p.fingerprint.length,
      },
    }));
}

/**
 * Process a single similarity scan job with budget enforcement
 * Updates the job document and the Prompt with results
 */
export async function processSimilarityJob(
  job: ISimilarityJob,
  budget: WorkerBudget = DEFAULT_BUDGET,
): Promise<WorkerStats> {
  const startTime = Date.now();
  const stats: WorkerStats = {
    candidatesScanned: 0,
    memoryUsedBytes: 0,
    processingTimeMs: 0,
    budgetExceeded: null,
  };

  try {
    // Fetch the prompt to scan
    const prompt = await Prompt.findOne({ onChainId: job.onChainId }).lean();
    if (!prompt || !prompt.fingerprint) {
      throw new Error(`Prompt ${job.onChainId} not found or has no fingerprint`);
    }

    const queryFingerprint: PromptFingerprint = {
      version: prompt.fingerprintVersion || INDEX_VERSION,
      minHash: prompt.fingerprint.minHash,
      tokenHistogram: new Uint8Array(prompt.fingerprint.tokenHistogram),
      contentHash: prompt.fingerprint.contentHash,
      tokenCount: prompt.fingerprint.tokenCount,
      length: prompt.fingerprint.length,
    };

    // Estimate memory for query fingerprint
    stats.memoryUsedBytes += fingerprintMemoryBytes(queryFingerprint);

    // Select bounded candidate set
    const candidates = await selectCandidates(job.onChainId, budget.maxCandidates);
    stats.candidatesScanned = candidates.length;

    let maxScore = 0;
    let mostSimilarId: string | null = null;

    // Scan candidates with budget enforcement
    for (const candidate of candidates) {
      // Time budget check
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > budget.maxTimeMs) {
        stats.budgetExceeded = "time";
        break;
      }

      // Memory budget check (rough estimate)
      stats.memoryUsedBytes += fingerprintMemoryBytes(candidate.fingerprint);
      if (stats.memoryUsedBytes > budget.maxMemoryBytes) {
        stats.budgetExceeded = "memory";
        break;
      }

      // Compute similarity using deterministic fingerprints
      const score = fingerprintSimilarity(queryFingerprint, candidate.fingerprint, 0.6);

      if (score > maxScore) {
        maxScore = score;
        mostSimilarId = candidate.onChainId;
      }
    }

    stats.processingTimeMs = Date.now() - startTime;

    // Classify result
    const flag = classifyScore(maxScore);

    // Update job with results
    await SimilarityJob.findByIdAndUpdate(job._id, {
      $set: {
        status: "completed",
        completedAt: new Date(),
        similarityFlag: flag,
        similarityScore: maxScore,
        similarTo: flag !== "clean" ? mostSimilarId : null,
        candidatesScanned: stats.candidatesScanned,
        memoryUsedBytes: stats.memoryUsedBytes,
        processingTimeMs: stats.processingTimeMs,
        lastError: null,
      },
    });

    // Update the original prompt with results
    await Prompt.findOneAndUpdate(
      { onChainId: job.onChainId },
      {
        $set: {
          similarityScanStatus: "completed",
          similarityFlag: flag,
          similarityScore: maxScore,
          similarTo: flag !== "clean" ? mostSimilarId : null,
          similarityCheckedAt: new Date(),
        },
      },
    );

    if (flag !== "clean") {
      console.warn(
        `[similarity-worker] Prompt ${job.onChainId} flagged as "${flag}" ` +
          `(score=${maxScore.toFixed(3)}, similar to ${mostSimilarId})`,
      );
    }

    return stats;
  } catch (error) {
    stats.processingTimeMs = Date.now() - startTime;

    const errorMsg = error instanceof Error ? error.message : String(error);

    // Update job with error
    await SimilarityJob.findByIdAndUpdate(job._id, {
      $set: {
        status: "failed",
        lastError: errorMsg,
        attemptCount: job.attemptCount + 1,
      },
      $push: {
        errorHistory: {
          timestamp: new Date(),
          error: errorMsg,
          attemptNumber: job.attemptCount + 1,
        },
      },
    });

    throw error;
  }
}

/**
 * Enqueue a fingerprint generation job for a prompt
 * (Fingerprints must be computed before similarity scanning)
 */
export async function enqueueFingerprint(
  onChainId: string,
): Promise<void> {
  const prompt = await Prompt.findOne({ onChainId }).lean();
  if (!prompt) {
    throw new Error(`Prompt ${onChainId} not found`);
  }

  // Generate and store fingerprint
  const fingerprint = generateFingerprint(
    prompt.title,
    prompt.content,
    INDEX_VERSION,
  );

  await Prompt.findOneAndUpdate(
    { onChainId },
    {
      $set: {
        fingerprintVersion: INDEX_VERSION,
        fingerprint: {
          minHash: fingerprint.minHash,
          tokenHistogram: Buffer.from(fingerprint.tokenHistogram),
          contentHash: fingerprint.contentHash,
          tokenCount: fingerprint.tokenCount,
          length: fingerprint.length,
        },
      },
    },
  );
}

/**
 * Retry a failed similarity job
 */
export async function retryFailedJob(
  jobId: string,
  budget: WorkerBudget = DEFAULT_BUDGET,
): Promise<WorkerStats> {
  const job = await SimilarityJob.findById(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (job.status === "completed") {
    return {
      candidatesScanned: job.candidatesScanned,
      memoryUsedBytes: job.memoryUsedBytes,
      processingTimeMs: job.processingTimeMs,
      budgetExceeded: null,
    };
  }

  if (job.attemptCount >= job.maxRetries) {
    throw new Error(
      `Job ${jobId} exceeded max retries (${job.maxRetries}) after ${job.attemptCount} attempts`,
    );
  }

  // Mark job as processing
  await SimilarityJob.findByIdAndUpdate(jobId, {
    $set: { status: "processing", startedAt: new Date() },
  });

  return processSimilarityJob(job, budget);
}

/**
 * Cleanup old, completed jobs (privacy/retention)
 */
export async function cleanupOldJobs(
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000, // 30 days
): Promise<number> {
  const cutoffDate = new Date(Date.now() - maxAgeMs);

  const result = await SimilarityJob.deleteMany({
    status: "completed",
    completedAt: { $lt: cutoffDate },
  });

  return result.deletedCount || 0;
}
