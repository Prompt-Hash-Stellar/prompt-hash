/**
 * emailNotifications.test.ts
 *
 * Test suite for durable email notifications:
 * - Telemetry & email redaction
 * - Event & recipient idempotency / duplicate prevention
 * - Bounded worker processing & large fanout
 * - Transient retries with exponential backoff & dead-letter queueing
 * - Crash recovery (resuming pending / stuck processing jobs)
 * - User preference snapshots
 * - SMTP provider timeout handling
 */

import {
  redactEmail,
  enqueueNotificationJob,
  processPendingJobs,
  notifyPromptPurchased,
  notifyPromptUpdated,
  getNotificationJobStatus,
  getBatchNotificationStatus,
  setTransport,
  closeTransport,
  escapeHtml,
  sanitizeForSubject,
  getAppOrigin,
  buildPromptUrl,
  PurchasePayload,
  UpdatePayload,
} from "../services/emailNotifications";

// ── In-Memory Database Store Mocking ─────────────────────────────────────────

interface MockJobDoc {
  _id: string;
  idempotencyKey: string;
  event: string;
  recipientWallet: string;
  recipientEmail: string | null;
  preferenceSnapshot: { optedIn: boolean };
  payload: any;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  save: () => Promise<MockJobDoc>;
}

let jobStore: MockJobDoc[] = [];
let userStore: Map<string, { walletAddress: string; email?: string; notificationPreferences?: any }> = new Map();

function createMockJobDoc(data: any): MockJobDoc {
  const doc: MockJobDoc = {
    _id: `job-${Math.random().toString(36).slice(2, 9)}`,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    nextRetryAt: new Date(),
    completedAt: null,
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
    save: async function () {
      this.updatedAt = new Date();
      return this;
    },
  };
  return doc;
}

jest.mock("../models/User", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn().mockImplementation((query: { walletAddress?: string }) => {
      const wallet = query.walletAddress?.toLowerCase();
      const userData = wallet ? userStore.get(wallet) : null;
      return {
        lean: jest.fn().mockResolvedValue(userData ? { ...userData } : null),
      };
    }),
  },
}));

jest.mock("../models/EmailNotificationJob", () => {
  const mockModel: any = {
    findOne: jest.fn().mockImplementation((query: { idempotencyKey?: string; _id?: string }) => {
      const found = jobStore.find(
        (j) =>
          (query.idempotencyKey && j.idempotencyKey === query.idempotencyKey) ||
          (query._id && j._id === query._id)
      );
      return {
        exec: jest.fn().mockResolvedValue(found ?? null),
        then: (cb: any) => Promise.resolve(found ?? null).then(cb),
      };
    }),

    create: jest.fn().mockImplementation((data: any) => {
      const existing = jobStore.find((j) => j.idempotencyKey === data.idempotencyKey);
      if (existing) {
        const err: any = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
      }
      const doc = createMockJobDoc(data);
      jobStore.push(doc);
      return Promise.resolve(doc);
    }),

    find: jest.fn().mockImplementation((query: any) => {
      let results = [...jobStore];

      if (query.idempotencyKey?.$in) {
        const keys = query.idempotencyKey.$in as string[];
        results = results.filter((j) => keys.includes(j.idempotencyKey));
      } else if (query.$or) {
        results = results.filter((j) => {
          const now = new Date();
          const matchesPending =
            j.status === "pending" && (!j.nextRetryAt || j.nextRetryAt <= now);
          const matchesStaleProcessing =
            j.status === "processing" &&
            j.updatedAt.getTime() <= now.getTime() - 5 * 60 * 1000;
          return matchesPending || matchesStaleProcessing;
        });
      }

      return {
        limit: (n: number) => ({
          exec: async () => results.slice(0, n),
        }),
        exec: async () => results,
      };
    }),

    findOneAndUpdate: jest.fn().mockImplementation((query: any, update: any) => {
      const job = jobStore.find((j) => j._id === query._id && query.status.$in.includes(j.status));
      if (!job) return Promise.resolve(null);

      if (update.$inc?.attempts) {
        job.attempts += update.$inc.attempts;
      }
      if (update.status) {
        job.status = update.status;
      }
      job.updatedAt = new Date();
      return Promise.resolve(job);
    }),
  };

  return {
    __esModule: true,
    default: mockModel,
  };
});

// ── Test Suites ───────────────────────────────────────────────────────────────

describe("emailNotifications", () => {
  let mockSendMail: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jobStore = [];
    userStore = new Map();

    mockSendMail = jest.fn().mockResolvedValue({ messageId: "msg-123" });
    setTransport({
      sendMail: mockSendMail,
      close: jest.fn(),
    } as any);
  });

  afterEach(async () => {
    await closeTransport();
  });

  // 1. Redaction & Telemetry
  describe("Telemetry & Redaction", () => {
    it("redacts email local part and domain for PII safety", () => {
      expect(redactEmail("seller@domain.com")).toBe("s***r@d***n.com");
      expect(redactEmail("alice.bob@company.org")).toBe("a***b@c***y.org");
      expect(redactEmail("a@b.com")).toBe("a***@b***.com");
    });

    it("handles null, undefined, or malformed email strings gracefully", () => {
      expect(redactEmail(null)).toBe("[REDACTED_EMAIL]");
      expect(redactEmail(undefined)).toBe("[REDACTED_EMAIL]");
      expect(redactEmail("not-an-email")).toBe("[REDACTED_EMAIL]");
    });
  });

  // 2. Duplicate Event & Idempotency
  describe("Event Idempotency & Duplicate Prevention", () => {
    it("prevents duplicate email sends when duplicate purchase event is received", async () => {
      userStore.set("seller1", {
        walletAddress: "seller1",
        email: "seller1@example.com",
        notificationPreferences: { PromptPurchased: true },
      });

      const payload: PurchasePayload = {
        buyerWallet: "buyer1",
        promptTitle: "GPT-4 Writer",
        promptId: "prompt-101",
        txHash: "tx-abc-123",
      };

      // First purchase event
      const job1 = await notifyPromptPurchased("seller1", payload, {
        idempotencyKey: "PromptPurchased:seller1:prompt-101:tx-abc-123",
      });

      expect(job1).toBeDefined();
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(job1?.status).toBe("completed");

      mockSendMail.mockClear();

      // Duplicate purchase event
      const job2 = await notifyPromptPurchased("seller1", payload, {
        idempotencyKey: "PromptPurchased:seller1:prompt-101:tx-abc-123",
      });

      expect(job2?._id).toBe(job1?._id);
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(jobStore.length).toBe(1);
    });

    it("handles E11000 duplicate key error when race condition occurs", async () => {
      userStore.set("seller2", {
        walletAddress: "seller2",
        email: "seller2@example.com",
      });

      const payload: PurchasePayload = {
        buyerWallet: "buyer2",
        promptTitle: "Coder Assistant",
        promptId: "prompt-102",
      };

      const key = "PromptPurchased:seller2:prompt-102:buyer2";

      // Pre-populate job in store
      const existingDoc = createMockJobDoc({
        idempotencyKey: key,
        event: "PromptPurchased",
        recipientWallet: "seller2",
        recipientEmail: "seller2@example.com",
        preferenceSnapshot: { optedIn: true },
        payload,
        status: "completed",
      });
      jobStore.push(existingDoc);

      // Attempt enqueueing duplicate
      const job = await enqueueNotificationJob({
        event: "PromptPurchased",
        recipientWallet: "seller2",
        payload,
        idempotencyKey: key,
      });

      expect(job.idempotencyKey).toBe(key);
      expect(jobStore.length).toBe(1);
    });
  });

  // 3. Transient / Permanent Failure & Retry Backoff
  describe("Retry, Backoff, and Dead-Lettering", () => {
    it("retries on transient SMTP failure and succeeds on retry", async () => {
      userStore.set("buyer1", {
        walletAddress: "buyer1",
        email: "buyer1@example.com",
      });

      const payload: UpdatePayload = {
        ownerWallet: "seller1",
        promptTitle: "SEO Tool",
        promptId: "prompt-200",
        versionIndex: 1,
      };

      // 1st attempt fails with network error
      mockSendMail.mockRejectedValueOnce(new Error("ECONNRESET Connection lost"));

      const job = await enqueueNotificationJob({
        event: "PromptUpdated",
        recipientWallet: "buyer1",
        payload,
        idempotencyKey: "PromptUpdated:buyer1:prompt-200:v1",
      });

      expect(job.status).toBe("pending");

      // First worker run fails and schedules backoff retry
      const result1 = await processPendingJobs();
      expect(result1.processed).toBe(1);
      expect(result1.failed).toBe(1);
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(1);
      expect(job.lastError).toContain("ECONNRESET");

      // Reset nextRetryAt so worker picks it up for retry
      job.nextRetryAt = new Date(Date.now() - 1000);

      // 2nd attempt succeeds
      mockSendMail.mockResolvedValueOnce({ messageId: "msg-retry-ok" });
      const result2 = await processPendingJobs();

      expect(result2.succeeded).toBe(1);
      expect(job.status).toBe("completed");
      expect(job.completedAt).toBeDefined();
    });

    it("moves job to dead-letter when max attempts are exceeded", async () => {
      userStore.set("buyer2", {
        walletAddress: "buyer2",
        email: "buyer2@example.com",
      });

      const payload: UpdatePayload = {
        ownerWallet: "seller1",
        promptTitle: "SEO Tool",
        promptId: "prompt-201",
        versionIndex: 1,
      };

      const job = await enqueueNotificationJob({
        event: "PromptUpdated",
        recipientWallet: "buyer2",
        payload,
        idempotencyKey: "PromptUpdated:buyer2:prompt-201:v1",
        maxAttempts: 2,
      });

      mockSendMail.mockRejectedValue(new Error("SMTP server temporary error"));

      // Attempt 1
      await processPendingJobs();
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(1);

      job.nextRetryAt = new Date(Date.now() - 1000);

      // Attempt 2 (maxAttempts = 2 reached)
      const result = await processPendingJobs();

      expect(result.deadLetter).toBe(1);
      expect(job.status).toBe("dead-letter");
      expect(job.failedAt).toBeDefined();
      expect(job.lastError).toContain("SMTP server temporary error");
    });

    it("immediately dead-letters permanent SMTP errors (e.g. 550 User Unknown)", async () => {
      userStore.set("buyer3", {
        walletAddress: "buyer3",
        email: "invalid@nonexistent.domain",
      });

      const payload: UpdatePayload = {
        ownerWallet: "seller1",
        promptTitle: "Tool",
        promptId: "prompt-202",
        versionIndex: 1,
      };

      const job = await enqueueNotificationJob({
        event: "PromptUpdated",
        recipientWallet: "buyer3",
        payload,
        idempotencyKey: "PromptUpdated:buyer3:prompt-202:v1",
      });

      mockSendMail.mockRejectedValueOnce(new Error("550 5.1.1 User unknown"));

      const result = await processPendingJobs();

      expect(result.deadLetter).toBe(1);
      expect(job.status).toBe("dead-letter");
      expect(job.lastError).toContain("550 5.1.1 User unknown");
    });
  });

  // 4. Preference Snapshot & Changes
  describe("Preference Snapshot & Preference Changes", () => {
    it("honors preference snapshot recorded at job enqueue time", async () => {
      // User is opted OUT initially
      userStore.set("user_optout", {
        walletAddress: "user_optout",
        email: "optout@example.com",
        notificationPreferences: { PromptPurchased: false },
      });

      const payload: PurchasePayload = {
        buyerWallet: "buyer-x",
        promptTitle: "Title X",
        promptId: "prompt-x",
      };

      const job = await enqueueNotificationJob({
        event: "PromptPurchased",
        recipientWallet: "user_optout",
        payload,
        idempotencyKey: "PromptPurchased:user_optout:prompt-x",
      });

      expect(job.preferenceSnapshot.optedIn).toBe(false);
      expect(job.status).toBe("skipped");

      // Even if user opts back IN later, the job's preference snapshot remains opted out
      userStore.set("user_optout", {
        walletAddress: "user_optout",
        email: "optout@example.com",
        notificationPreferences: { PromptPurchased: true },
      });

      const result = await processPendingJobs();
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(result.skipped).toBe(0); // already skipped at enqueue
    });
  });

  // 5. Crash Recovery
  describe("Crash Recovery", () => {
    it("resumes pending jobs that survived a server restart", async () => {
      userStore.set("seller_crash", {
        walletAddress: "seller_crash",
        email: "crash@example.com",
      });

      // Simulate jobs created prior to server restart
      const pendingJob = createMockJobDoc({
        idempotencyKey: "PromptPurchased:seller_crash:p1",
        event: "PromptPurchased",
        recipientWallet: "seller_crash",
        recipientEmail: "crash@example.com",
        preferenceSnapshot: { optedIn: true },
        payload: { buyerWallet: "b1", promptTitle: "P1", promptId: "p1" },
        status: "pending",
        nextRetryAt: new Date(Date.now() - 5000),
      });

      jobStore.push(pendingJob);

      // Call processPendingJobs (as would happen on server startup)
      const result = await processPendingJobs();

      expect(result.succeeded).toBe(1);
      expect(pendingJob.status).toBe("completed");
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it("resumes stuck 'processing' jobs that crashed mid-execution", async () => {
      userStore.set("seller_stuck", {
        walletAddress: "seller_stuck",
        email: "stuck@example.com",
      });

      // Stuck processing job (updatedAt older than 5 minutes threshold)
      const staleDate = new Date(Date.now() - 10 * 60 * 1000);
      const stuckJob = createMockJobDoc({
        idempotencyKey: "PromptPurchased:seller_stuck:p2",
        event: "PromptPurchased",
        recipientWallet: "seller_stuck",
        recipientEmail: "stuck@example.com",
        preferenceSnapshot: { optedIn: true },
        payload: { buyerWallet: "b2", promptTitle: "P2", promptId: "p2" },
        status: "processing",
        updatedAt: staleDate,
      });

      jobStore.push(stuckJob);

      const result = await processPendingJobs();

      expect(result.succeeded).toBe(1);
      expect(stuckJob.status).toBe("completed");
    });
  });

  // 6. Large Fanout & Bounded Concurrency
  describe("Large Buyer Fanout & Bounded Concurrency", () => {
    it("handles large buyer list fanout with bounded concurrency and observable completion", async () => {
      const buyerWallets: string[] = [];
      const totalBuyers = 50;

      for (let i = 0; i < totalBuyers; i++) {
        const wallet = `buyer_fanout_${i}`;
        buyerWallets.push(wallet);
        userStore.set(wallet, {
          walletAddress: wallet,
          email: `${wallet}@example.com`,
          notificationPreferences: { PromptUpdated: true },
        });
      }

      const payload: UpdatePayload = {
        ownerWallet: "creator",
        promptTitle: "Popular Prompt",
        promptId: "prompt-popular",
        versionIndex: 2,
      };

      // Notify prompt updated with processSync: false to enqueue all jobs first
      const jobs = await notifyPromptUpdated(buyerWallets, payload, {
        idempotencyKeyPrefix: "PromptUpdated:popular",
        batchSize: 10,
        processSync: false,
      });

      expect(jobs.length).toBe(totalBuyers);

      const keys = jobs.map((j) => j.idempotencyKey);
      let statusSummary = await getBatchNotificationStatus(keys);
      expect(statusSummary.pending).toBe(totalBuyers);

      // Run worker with concurrency limit = 5
      const processResult = await processPendingJobs({ concurrency: 5, maxBatch: 100 });

      expect(processResult.succeeded).toBe(totalBuyers);
      expect(mockSendMail).toHaveBeenCalledTimes(totalBuyers);

      statusSummary = await getBatchNotificationStatus(keys);
      expect(statusSummary.completed).toBe(totalBuyers);
      expect(statusSummary.pending).toBe(0);
    });
  });

  // 7. Timeout Handling
  describe("SMTP Provider Timeout", () => {
    it("handles SMTP socket timeout and retries or dead-letters cleanly", async () => {
      userStore.set("timeout_user", {
        walletAddress: "timeout_user",
        email: "timeout@example.com",
      });

      // Mock transport that hangs indefinitely
      mockSendMail.mockImplementation(() => new Promise(() => {}));

      const job = await enqueueNotificationJob({
        event: "PromptPurchased",
        recipientWallet: "timeout_user",
        payload: { buyerWallet: "b-timeout", promptTitle: "Hanging Prompt", promptId: "p-hang" },
        idempotencyKey: "PromptPurchased:timeout_user:p-hang",
      });

      // Run worker with very short timeout (e.g. 50ms)
      const result = await processPendingJobs({ timeoutMs: 50 });

      expect(result.failed).toBe(1);
      expect(job.status).toBe("pending");
      expect(job.lastError).toContain("SMTP send mail timed out after 50ms");
    });
  });

  // 8. HTML Escaping & Safe Link Construction (#168)
  describe("HTML Escaping & Safe Link Construction", () => {
    it("escapes HTML-significant characters and strips line breaks", () => {
      expect(escapeHtml(`<script>alert('xss')</script>`)).toBe(
        "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
      );
      expect(escapeHtml(`"onmouseover="alert(1)`)).toBe("&quot;onmouseover=&quot;alert(1)");
      expect(escapeHtml("line1\r\nline2\rline3\nline4")).toBe("line1 line2 line3 line4");
      expect(escapeHtml("Écrire un café ☕ prompt")).toBe("Écrire un café ☕ prompt");
    });

    it("strips CR/LF from subject values without HTML-encoding other characters", () => {
      expect(sanitizeForSubject("Injected\r\nBcc: attacker@evil.com")).toBe(
        "Injected Bcc: attacker@evil.com"
      );
      expect(sanitizeForSubject("  Normal Title  ")).toBe("Normal Title");
    });

    it("returns the default origin when APP_URL is unset, malformed, or not HTTPS", () => {
      const original = process.env.APP_URL;
      try {
        delete process.env.APP_URL;
        expect(getAppOrigin()).toBe("https://prompthash.io");

        process.env.APP_URL = "not a url";
        expect(getAppOrigin()).toBe("https://prompthash.io");

        process.env.APP_URL = "javascript:alert(1)";
        expect(getAppOrigin()).toBe("https://prompthash.io");

        process.env.APP_URL = "http://attacker.example";
        expect(getAppOrigin()).toBe("https://prompthash.io");

        process.env.APP_URL = "https://app.prompthash.io";
        expect(getAppOrigin()).toBe("https://app.prompthash.io");
      } finally {
        if (original === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = original;
      }
    });

    it("URL-encodes the prompt id when building a prompt link", () => {
      const original = process.env.APP_URL;
      try {
        process.env.APP_URL = "https://app.prompthash.io";
        expect(buildPromptUrl("prompt/../../evil?x=1")).toBe(
          "https://app.prompthash.io/prompts/prompt%2F..%2F..%2Fevil%3Fx%3D1"
        );
      } finally {
        if (original === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = original;
      }
    });

    it("sends escaped HTML and a plain-text alternative for a malicious purchase payload", async () => {
      userStore.set("seller_xss", {
        walletAddress: "seller_xss",
        email: "seller_xss@example.com",
      });

      const maliciousPayload: PurchasePayload = {
        buyerWallet: `<img src=x onerror=alert(1)>abcdefgh`,
        promptTitle: `Evil"><script>alert('title')</script>`,
        promptId: `p1"><img src=x onerror=alert(2)>`,
        txHash: `tx"><script>alert('hash')</script>`,
      };

      await notifyPromptPurchased("seller_xss", maliciousPayload, {
        idempotencyKey: "PromptPurchased:seller_xss:xss",
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const sentMail = mockSendMail.mock.calls[0][0];

      expect(sentMail.html).not.toContain("<script>");
      expect(sentMail.html).not.toContain("onerror=alert");
      expect(sentMail.html).toContain("&lt;script&gt;");
      expect(typeof sentMail.text).toBe("string");
      expect(sentMail.text.length).toBeGreaterThan(0);
      expect(sentMail.subject).not.toMatch(/[\r\n]/);
    });

    it("sends escaped HTML and a plain-text alternative for a malicious update payload", async () => {
      const maliciousBuyers = ["buyer_xss_1"];
      userStore.set("buyer_xss_1", {
        walletAddress: "buyer_xss_1",
        email: "buyer_xss_1@example.com",
      });

      const maliciousPayload: UpdatePayload = {
        ownerWallet: "creator_xss",
        promptTitle: `<b>Bold</b> & "quoted" title\r\nInjected-Header: evil`,
        promptId: "prompt-xss",
        versionIndex: 0,
      };

      await notifyPromptUpdated(maliciousBuyers, maliciousPayload, {
        idempotencyKeyPrefix: "PromptUpdated:xss",
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const sentMail = mockSendMail.mock.calls[0][0];

      expect(sentMail.html).not.toContain("<b>Bold</b>");
      expect(sentMail.html).toContain("&lt;b&gt;");
      expect(sentMail.html).toContain("&amp;");
      expect(sentMail.html).toContain("&quot;quoted&quot;");
      expect(sentMail.subject).not.toMatch(/[\r\n]/);
      expect(typeof sentMail.text).toBe("string");
    });
  });
});
