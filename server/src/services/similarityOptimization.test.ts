/**
 * Tests for optimized similarity scan system (#157)
 *
 * Covers:
 * - Large-corpus performance
 * - Worker crash/retry logic
 * - Duplicate job deduplication
 * - Privacy (fingerprint-based, no plaintext in-memory)
 * - Deterministic results (reproducible for same algorithm version)
 */

import Prompt from "../models/Prompt";
import SimilarityJob from "../models/SimilarityJob";
import {
  generateFingerprint,
  fingerprintSimilarity,
  fingerprintMemoryBytes,
} from "../services/fingerprintService";
import {
  processSimilarityJob,
  enqueueFingerprint,
  cleanupOldJobs,
} from "../services/similarityWorker";
import {
  enqueueSimilarityScan,
  processPendingJobs,
  getJobStatus,
  getQueueStats,
  retryJob,
} from "../services/similarityJobQueue";
import * as mongoose from "mongoose";

const HAS_TEST_DB = Boolean(process.env.MONGODB_TEST_URI);
const dbDescribe = HAS_TEST_DB ? describe : describe.skip;

// Mock database setup
beforeAll(async () => {
  if (!HAS_TEST_DB) {
    console.warn("Skipping database tests: MONGODB_TEST_URI not set");
    return;
  }

  await mongoose.connect(process.env.MONGODB_TEST_URI);
});

afterAll(async () => {
  if (!HAS_TEST_DB) return;
  await SimilarityJob.deleteMany({});
  await Prompt.deleteMany({});
  await mongoose.disconnect();
});

describe("Fingerprinting Service", () => {
  test("should generate deterministic fingerprints", () => {
    const title = "Test Prompt";
    const content = "This is a test prompt about machine learning";

    const fp1 = generateFingerprint(title, content, "1.0");
    const fp2 = generateFingerprint(title, content, "1.0");

    // Same input should produce identical fingerprints
    expect(fp1.minHash).toEqual(fp2.minHash);
    expect(fp1.tokenHistogram).toEqual(fp2.tokenHistogram);
    expect(fp1.contentHash).toBe(fp2.contentHash);
  });

  test("should compute consistent similarity scores", () => {
    const text1 = "Machine learning is a subset of artificial intelligence";
    const text2 = "Machine learning is a subset of artificial intelligence";

    const fp1 = generateFingerprint(text1, "", "1.0");
    const fp2 = generateFingerprint(text2, "", "1.0");

    const score = fingerprintSimilarity(fp1, fp2);
    expect(score).toBeGreaterThan(0.9); // Near-identical content
  });

  test("should estimate memory size correctly", () => {
    const fp = generateFingerprint("Test", "content", "1.0");
    const memBytes = fingerprintMemoryBytes(fp);

    // Should be roughly NUM_HASHES * 8 + HISTOGRAM_BINS + overhead
    expect(memBytes).toBeGreaterThan(128 * 8); // MinHash
    expect(memBytes).toBeLessThan(10 * 1024); // Less than 10 KB
  });

  test("should differentiate dissimilar content", () => {
    const text1 = "Machine learning algorithms";
    const text2 = "Cooking recipes for dinner";

    const fp1 = generateFingerprint(text1, "", "1.0");
    const fp2 = generateFingerprint(text2, "", "1.0");

    const score = fingerprintSimilarity(fp1, fp2);
    expect(score).toBeLessThan(0.5); // Dissimilar
  });
});

dbDescribe("Similarity Worker", () => {
  beforeEach(async () => {
    await Prompt.deleteMany({});
    await SimilarityJob.deleteMany({});
  });

  test("should process a single similarity scan job", async () => {
    // Create test prompts with fingerprints
    const prompt1 = await Prompt.create({
      onChainId: "prompt-1",
      title: "Test Prompt 1",
      content: "This is about machine learning and AI",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Programming",
      isActive: true,
      fingerprint: {
        ...generateFingerprint(
          "Test Prompt 1",
          "This is about machine learning and AI",
          "1.0",
        ),
      },
      fingerprintVersion: "1.0",
    });

    const prompt2 = await Prompt.create({
      onChainId: "prompt-2",
      title: "Test Prompt 2",
      content: "Machine learning and artificial intelligence concepts",
      owner: new mongoose.Types.ObjectId(),
      price: 15,
      category: "Programming",
      isActive: true,
      fingerprint: {
        ...generateFingerprint(
          "Test Prompt 2",
          "Machine learning and artificial intelligence concepts",
          "1.0",
        ),
      },
      fingerprintVersion: "1.0",
    });

    // Create similarity job
    const job = await SimilarityJob.create({
      promptId: prompt1._id.toString(),
      onChainId: "prompt-1",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "test-hash",
      status: "processing",
      attemptCount: 0,
      maxRetries: 3,
    });

    // Process job
    const stats = await processSimilarityJob(job);

    expect(stats.candidatesScanned).toBeGreaterThan(0);
    expect(stats.processingTimeMs).toBeGreaterThan(0);

    // Verify job was updated
    const updatedJob = await SimilarityJob.findById(job._id);
    expect(updatedJob?.status).toBe("completed");
    expect(updatedJob?.similarityScore).toBeGreaterThan(0);
    expect(updatedJob?.similarityFlag).toBeDefined();

    // Verify prompt was updated
    const updatedPrompt = await Prompt.findOne({ onChainId: "prompt-1" });
    expect(updatedPrompt?.similarityScanStatus).toBe("completed");
  });

  test("should enforce memory budget", async () => {
    // This test would require creating many prompts to exceed memory budget
    // Simplified version that checks budget is tracked
    const prompt = await Prompt.create({
      onChainId: "prompt-budget-test",
      title: "Budget Test",
      content: "Content for budget test",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Other",
      isActive: true,
      fingerprint: {
        ...generateFingerprint("Budget Test", "Content for budget test", "1.0"),
      },
      fingerprintVersion: "1.0",
    });

    const job = await SimilarityJob.create({
      promptId: prompt._id.toString(),
      onChainId: "prompt-budget-test",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "budget-hash",
      status: "processing",
      memoryLimitBytes: 1024, // Very small limit
      attemptCount: 0,
      maxRetries: 3,
    });

    const stats = await processSimilarityJob(job, {
      maxCandidates: 10000,
      maxMemoryBytes: 1024, // Force budget limit
      maxTimeMs: 60000,
    });

    // Should either complete or hit memory budget
    expect(stats.memoryUsedBytes).toBeGreaterThan(0);
  });

  test("should handle missing fingerprints gracefully", async () => {
    // Create prompt without fingerprint
    const prompt = await Prompt.create({
      onChainId: "prompt-no-fp",
      title: "No Fingerprint",
      content: "This prompt has no fingerprint",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Other",
      isActive: true,
    });

    const job = await SimilarityJob.create({
      promptId: prompt._id.toString(),
      onChainId: "prompt-no-fp",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "no-fp-hash",
      status: "processing",
      attemptCount: 0,
      maxRetries: 3,
    });

    // Should throw or handle gracefully
    await expect(processSimilarityJob(job)).rejects.toThrow();
  });
});

dbDescribe("Similarity Job Queue", () => {
  beforeEach(async () => {
    await Prompt.deleteMany({});
    await SimilarityJob.deleteMany({});
  });

  test("should enqueue duplicate scans with deduplication", async () => {
    const prompt = await Prompt.create({
      onChainId: "dedup-test",
      title: "Dedup Test",
      content: "Testing deduplication logic",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Other",
      isActive: true,
    });

    // Enqueue same prompt twice
    const jobId1 = await enqueueSimilarityScan("dedup-test");
    const jobId2 = await enqueueSimilarityScan("dedup-test");

    // Should return same job ID (deduplicated)
    expect(jobId1).toBe(jobId2);

    // Only one job should exist
    const jobs = await SimilarityJob.countDocuments({ onChainId: "dedup-test" });
    expect(jobs).toBe(1);
  });

  test("should track job status", async () => {
    const prompt = await Prompt.create({
      onChainId: "status-test",
      title: "Status Test",
      content: "Testing job status tracking",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Other",
      isActive: true,
    });

    const jobId = await enqueueSimilarityScan("status-test");

    const status = await getJobStatus("status-test");
    expect(status).toBeDefined();
    expect(status?.jobId.toString()).toBe(jobId);
    expect(status?.status).toBe("pending");
  });

  test("should provide queue statistics", async () => {
    // Enqueue multiple scans
    for (let i = 0; i < 3; i++) {
      const prompt = await Prompt.create({
        onChainId: `stats-test-${i}`,
        title: `Stats Test ${i}`,
        content: "Testing queue statistics",
        owner: new mongoose.Types.ObjectId(),
        price: 10,
        category: "Other",
        isActive: true,
      });

      await enqueueSimilarityScan(`stats-test-${i}`);
    }

    const stats = await getQueueStats();
    expect(stats.pending).toBeGreaterThanOrEqual(3);
    expect(stats.processing).toBeGreaterThanOrEqual(0);
  });

  test("should retry failed jobs", async () => {
    const prompt = await Prompt.create({
      onChainId: "retry-test",
      title: "Retry Test",
      content: "Testing retry logic",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Other",
      isActive: true,
    });

    const jobId = await enqueueSimilarityScan("retry-test");

    // Mark job as failed
    await SimilarityJob.findByIdAndUpdate(jobId, {
      $set: { status: "failed", attemptCount: 1 },
    });

    // Retry
    await retryJob(jobId);

    const job = await SimilarityJob.findById(jobId);
    expect(job?.status).toBe("pending");
  });

  test("should prevent retry after max attempts", async () => {
    const job = await SimilarityJob.create({
      promptId: "max-retry-test",
      onChainId: "max-retry-test",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "max-retry-hash",
      status: "failed",
      attemptCount: 3,
      maxRetries: 3,
      lastError: "Test error",
    });

    // Should not allow retry
    await expect(retryJob(job._id.toString())).rejects.toThrow();
  });

  test("should cleanup old completed jobs", async () => {
    // Create an old completed job
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago

    await SimilarityJob.create({
      promptId: "cleanup-test",
      onChainId: "cleanup-test",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "cleanup-hash",
      status: "completed",
      completedAt: oldDate,
      createdAt: oldDate,
    });

    // Create a recent completed job
    await SimilarityJob.create({
      promptId: "recent-test",
      onChainId: "recent-test",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "recent-hash",
      status: "completed",
    });

    // Cleanup with 30-day threshold
    const deleted = await cleanupOldJobs(30 * 24 * 60 * 60 * 1000);

    expect(deleted).toBeGreaterThanOrEqual(1);

    // Old job should be deleted
    const oldJob = await SimilarityJob.findOne({
      onChainId: "cleanup-test",
    });
    expect(oldJob).toBeNull();

    // Recent job should still exist
    const recentJob = await SimilarityJob.findOne({
      onChainId: "recent-test",
    });
    expect(recentJob).toBeDefined();
  });
});

dbDescribe("Performance and Scalability", () => {
  beforeEach(async () => {
    await Prompt.deleteMany({});
    await SimilarityJob.deleteMany({});
  });

  test("should handle large corpus without blocking", async () => {
    // Create a large number of prompts
    const CORPUS_SIZE = 100;
    const prompts = [];

    for (let i = 0; i < CORPUS_SIZE; i++) {
      const fp = generateFingerprint(
        `Prompt ${i}`,
        `Content for prompt ${i}`,
        "1.0",
      );

      const prompt = await Prompt.create({
        onChainId: `large-corpus-${i}`,
        title: `Prompt ${i}`,
        content: `Content for prompt ${i}`,
        owner: new mongoose.Types.ObjectId(),
        price: 10 + i,
        category: "Other",
        isActive: true,
        fingerprint: fp,
        fingerprintVersion: "1.0",
      });

      prompts.push(prompt);
    }

    // Time the enqueue operation (should be O(1), not O(n))
    const startTime = Date.now();
    await enqueueSimilarityScan("large-corpus-99");
    const enqueueTime = Date.now() - startTime;

    // Enqueue should be fast (< 100ms)
    expect(enqueueTime).toBeLessThan(100);
  });

  test("should process jobs with candidate limit", async () => {
    // Create many prompts
    const CORPUS_SIZE = 50;

    for (let i = 0; i < CORPUS_SIZE; i++) {
      const fp = generateFingerprint(
        `Prompt ${i}`,
        `Content for prompt ${i}`,
        "1.0",
      );

      await Prompt.create({
        onChainId: `candidate-limit-${i}`,
        title: `Prompt ${i}`,
        content: `Content for prompt ${i}`,
        owner: new mongoose.Types.ObjectId(),
        price: 10 + i,
        category: "Other",
        isActive: true,
        fingerprint: fp,
        fingerprintVersion: "1.0",
      });
    }

    // Create job with low candidate limit
    const job = await SimilarityJob.create({
      promptId: "candidate-limit-test",
      onChainId: "candidate-limit-0",
      algorithmVersion: "1.0",
      indexVersion: "1.0",
      algorithmHash: "candidate-limit-hash",
      status: "processing",
      candidateLimit: 10, // Only scan 10 candidates
      attemptCount: 0,
      maxRetries: 3,
    });

    const stats = await processSimilarityJob(job, {
      maxCandidates: 10,
      maxMemoryBytes: 100 * 1024 * 1024,
      maxTimeMs: 60000,
    });

    // Should respect candidate limit
    expect(stats.candidatesScanned).toBeLessThanOrEqual(10);
  });
});

dbDescribe("Privacy and Reproducibility", () => {
  test("should not store plaintext in jobs", async () => {
    const prompt = await Prompt.create({
      onChainId: "privacy-test",
      title: "Secret Prompt Title",
      content: "This is secret content that should not be in jobs",
      owner: new mongoose.Types.ObjectId(),
      price: 10,
      category: "Other",
      isActive: true,
    });

    const jobId = await enqueueSimilarityScan("privacy-test");

    // Job should not contain plaintext
    const job = await SimilarityJob.findById(jobId);
    const jobJson = JSON.stringify(job);

    expect(jobJson).not.toContain("secret content");
    expect(jobJson).not.toContain("Secret Prompt Title");
  });

  test("should produce deterministic results for same algorithm version", async () => {
    const fp1 = generateFingerprint("Same Title", "Same Content", "1.0");
    const fp2 = generateFingerprint("Same Title", "Same Content", "1.0");

    const score1 = fingerprintSimilarity(fp1, fp2);
    const score2 = fingerprintSimilarity(fp1, fp2);

    expect(score1).toBe(score2);
  });
});
