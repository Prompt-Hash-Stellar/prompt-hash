/**
 * Similarity Job Queue Manager
 *
 * Manages queued, retryable similarity scan jobs:
 * - Enqueue new scans with deterministic deduplication
 * - Process pending jobs with configurable concurrency
 * - Handle retries with exponential backoff
 * - Track job state and expose pending/failed scan status
 */

import SimilarityJob from "../models/SimilarityJob";
import Prompt from "../models/Prompt";
import {
  processSimilarityJob,
  enqueueFingerprint,
  retryFailedJob,
  cleanupOldJobs,
  WorkerBudget,
  DEFAULT_BUDGET,
} from "./similarityWorker";
import crypto from "crypto";

const ALGORITHM_VERSION = "1.0";
const INDEX_VERSION = "1.0";

export interface JobQueueConfig {
  maxConcurrentJobs: number; // number of workers
  budget: WorkerBudget;
  retryBackoffMs: number; // base retry delay
  maxRetries: number;
}

const DEFAULT_CONFIG: JobQueueConfig = {
  maxConcurrentJobs: 4,
  budget: DEFAULT_BUDGET,
  retryBackoffMs: 1000, // 1 second base, exponential
  maxRetries: 3,
};

let isProcessing = false;
let activeJobs = 0;

/**
 * Enqueue a similarity scan for a newly indexed prompt
 * Deduplicates by algorithmHash to ensure deterministic results
 */
export async function enqueueSimilarityScan(
  onChainId: string,
  promptId?: string,
): Promise<string> {
  // Ensure fingerprint exists
  await enqueueFingerprint(onChainId);

  const algorithmHash = crypto
    .createHash("sha256")
    .update(`${ALGORITHM_VERSION}:${INDEX_VERSION}:minHashWeight=0.6`)
    .digest("hex");

  // Check if a recent job for this prompt already exists
  const existing = await SimilarityJob.findOne({
    onChainId,
    algorithmHash,
    status: { $in: ["pending", "processing", "completed"] },
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // within 24 hours
  });

  if (existing) {
    console.log(
      `[similarity-queue] Job already exists for ${onChainId} (${existing._id})`,
    );
    return existing._id.toString();
  }

  // Create new job
  const job = await SimilarityJob.create({
    promptId: promptId || onChainId,
    onChainId,
    algorithmVersion: ALGORITHM_VERSION,
    indexVersion: INDEX_VERSION,
    algorithmHash,
    status: "pending",
    attemptCount: 0,
    maxRetries: DEFAULT_CONFIG.maxRetries,
    candidateLimit: DEFAULT_CONFIG.budget.maxCandidates,
    memoryLimitBytes: DEFAULT_CONFIG.budget.maxMemoryBytes,
    timeLimitMs: DEFAULT_CONFIG.budget.maxTimeMs,
  });

  console.log(`[similarity-queue] Enqueued scan for ${onChainId} (${job._id})`);

  // Update prompt to reference this job
  await Prompt.findOneAndUpdate(
    { onChainId },
    {
      $set: {
        similarityScanStatus: "pending",
        similarityScanJobId: job._id,
      },
    },
  );

  return job._id.toString();
}

/**
 * Process pending jobs with concurrency control
 * Called periodically by the background worker
 */
export async function processPendingJobs(
  config: JobQueueConfig = DEFAULT_CONFIG,
): Promise<{ processed: number; failed: number }> {
  if (isProcessing) {
    console.log("[similarity-queue] Already processing jobs, skipping");
    return { processed: 0, failed: 0 };
  }

  isProcessing = true;
  let processed = 0;
  let failed = 0;

  try {
    while (activeJobs < config.maxConcurrentJobs) {
      // Fetch next pending job
      const job = await SimilarityJob.findOneAndUpdate(
        { status: "pending" },
        { $set: { status: "processing", startedAt: new Date() } },
        { sort: { createdAt: 1 }, new: true },
      );

      if (!job) {
        break; // No more pending jobs
      }

      activeJobs++;

      // Process job asynchronously without waiting
      processJobWithRetry(job, config)
        .then(() => {
          activeJobs--;
          processed++;
        })
        .catch((error) => {
          activeJobs--;
          failed++;
          console.error(
            `[similarity-queue] Job ${job._id} processing failed:`,
            error,
          );
        });
    }
  } finally {
    isProcessing = false;
  }

  return { processed, failed };
}

/**
 * Process a single job with retry logic
 */
async function processJobWithRetry(
  job: any,
  config: JobQueueConfig,
): Promise<void> {
  try {
    await processSimilarityJob(job, config.budget);
  } catch (error) {
    const nextAttempt = job.attemptCount + 1;

    if (nextAttempt <= config.maxRetries) {
      const backoffMs =
        config.retryBackoffMs * Math.pow(2, nextAttempt - 1); // exponential backoff
      console.log(
        `[similarity-queue] Job ${job._id} will retry in ${backoffMs}ms ` +
          `(attempt ${nextAttempt}/${config.maxRetries})`,
      );

      // Schedule retry
      setTimeout(() => {
        retryFailedJob(job._id.toString(), config.budget).catch((err) => {
          console.error(`[similarity-queue] Retry failed for job ${job._id}:`, err);
        });
      }, backoffMs);
    } else {
      // Mark job as permanently failed
      await SimilarityJob.findByIdAndUpdate(job._id, {
        $set: { status: "failed" },
      });
      console.error(
        `[similarity-queue] Job ${job._id} exceeded max retries`,
      );
    }
  }
}

/**
 * Get job status for a prompt
 */
export async function getJobStatus(onChainId: string) {
  const job = await SimilarityJob.findOne({ onChainId }).sort({
    createdAt: -1,
  });

  if (!job) {
    return null;
  }

  return {
    jobId: job._id,
    status: job.status,
    flag: job.similarityFlag,
    score: job.similarityScore,
    similarTo: job.similarTo,
    attemptCount: job.attemptCount,
    candidatesScanned: job.candidatesScanned,
    processingTimeMs: job.processingTimeMs,
    lastError: job.lastError,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  const [pending, processing, completed, failed] = await Promise.all([
    SimilarityJob.countDocuments({ status: "pending" }),
    SimilarityJob.countDocuments({ status: "processing" }),
    SimilarityJob.countDocuments({ status: "completed" }),
    SimilarityJob.countDocuments({ status: "failed" }),
  ]);

  const avgProcessingTimeMs = await SimilarityJob.aggregate([
    { $match: { status: "completed" } },
    { $group: { _id: null, avg: { $avg: "$processingTimeMs" } } },
  ]);

  return {
    pending,
    processing,
    completed,
    failed,
    totalActive: activeJobs,
    avgProcessingTimeMs: avgProcessingTimeMs[0]?.avg || 0,
  };
}

/**
 * Start background worker to process jobs periodically
 */
export function startSimilarityWorker(
  intervalMs: number = 5000,
  config: JobQueueConfig = DEFAULT_CONFIG,
) {
  console.log(
    `[similarity-queue] Starting worker (interval: ${intervalMs}ms, max concurrent: ${config.maxConcurrentJobs})`,
  );

  setInterval(async () => {
    try {
      await processPendingJobs(config);
      await cleanupOldJobs(); // cleanup every cycle
    } catch (error) {
      console.error("[similarity-queue] Worker error:", error);
    }
  }, intervalMs);
}

/**
 * Manually trigger retry for a failed job
 */
export async function retryJob(jobId: string): Promise<void> {
  const job = await SimilarityJob.findById(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  await SimilarityJob.findByIdAndUpdate(jobId, {
    $set: { status: "pending" },
  });

  console.log(`[similarity-queue] Marked job ${jobId} for retry`);
}
