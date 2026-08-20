/**
 * Tests for Issue #159 — Privacy-safe proxy logging.
 *
 * These tests verify that:
 *  A. Successful requests log metadata but never log raw prompt content.
 *  B. Upstream errors do not leak upstream body to logs or to the client.
 *  C. Thrown/unexpected errors do not log sensitive prompt/model content.
 *  D. Secret/PII payloads (API keys, emails, tokens) never reach application logs.
 *  E. Model responses never appear in captured logs.
 *
 * They also include regression tests confirming safe metadata remains observable.
 */

// ── Captured-log infrastructure ───────────────────────────────────────────────

/** Collect every argument passed to console.log / console.warn / console.error. */
function captureConsoleLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];

  const serialize = (...args: unknown[]) => {
    try {
      return args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    } catch {
      return String(args);
    }
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    lines.push(serialize(...args));
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    lines.push(serialize(...args));
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    lines.push(serialize(...args));
    origError(...args);
  };

  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock crypto.randomUUID so we get a deterministic requestId in tests.
jest.mock("../utils/proxyLogger", () => {
  const actual = jest.requireActual<typeof import("../utils/proxyLogger")>(
    "../utils/proxyLogger"
  );
  return {
    ...actual,
    generateRequestId: () => "test-request-id-001",
  };
});

// Mock fetch so no real HTTP requests are made.
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Mock the AI SDK — TestPromptProxy uses streamText from "ai".
jest.mock("ai", () => ({
  streamText: jest.fn(),
}));
jest.mock("@ai-sdk/openai", () => ({
  openai: jest.fn(() => "mock-openai-model"),
}));

// Mock all DB/service dependencies used by other controllers — avoids connection errors.
jest.mock("../db/connectDb", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../models/User", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Prompt", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Report", () => ({ __esModule: true, default: {} }));
jest.mock("../services/listingValidation", () => ({
  validateListingMetadata: jest.fn(),
}));
jest.mock("../services/cacheService", () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
  cacheDelPattern: jest.fn(),
  CACHE_KEYS: { promptList: jest.fn(), promptDetail: jest.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { streamText } from "ai";
import { ImproveProxy, TestPromptProxy } from "../controllers/controllers";
import type { Request, Response } from "express";

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>;

/** Build a minimal Express-like mock Request. */
function makeReq(body: unknown): Request {
  return { body } as Request;
}

/** Build a mock Express Response that captures the status and JSON body. */
function makeRes(): Response & { _status: number; _body: unknown } {
  const r = {
    _status: 200,
    _body: undefined as unknown,
    status(code: number) {
      r._status = code;
      return r;
    },
    json(data: unknown) {
      r._body = data;
      return r;
    },
  };
  return r as unknown as Response & { _status: number; _body: unknown };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ImproveProxy — privacy-safe logging", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── Case A: Successful request ──────────────────────────────────────────

  describe("Case A — successful improve-proxy request", () => {
    it("logs request metadata (requestId, durationMs, status, bytes) on success", async () => {
      const FAKE_RESPONSE_BODY = JSON.stringify({ improved: "some text" });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => FAKE_RESPONSE_BODY,
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("Write a poem about Stellar.");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      // At least one log line must be emitted.
      expect(lines.length).toBeGreaterThan(0);

      // The combined log output must include our correlation ID.
      const allLogs = lines.join("\n");
      expect(allLogs).toContain("test-request-id-001");
    });

    it("does NOT log the raw prompt text on success (Case A — absence check)", async () => {
      const PROPRIETARY_PROMPT = "PROPRIETARY_PROMPT_XK29_SENSITIVE";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: "improved version" }),
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq(PROPRIETARY_PROMPT);
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(PROPRIETARY_PROMPT);
    });
  });

  // ─── Case B: Upstream error ───────────────────────────────────────────────

  describe("Case B — upstream HTTP error", () => {
    it("does NOT include upstream error body in logs", async () => {
      const UPSTREAM_SECRET = "SECRET_UPSTREAM_ERROR_BODY_XK99";

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => `{"error": "service unavailable", "debug": "${UPSTREAM_SECRET}"}`,
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("some prompt text");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(UPSTREAM_SECRET);
    });

    it("does NOT return the upstream error body to the client", async () => {
      const UPSTREAM_BODY = '{"internal":"debug info LEAKED_TOKEN_ABC"}';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => UPSTREAM_BODY,
      });

      const req = makeReq("some prompt text");
      const res = makeRes();

      await ImproveProxy(req, res);

      // The client response must not contain the upstream body at all.
      const clientBody = JSON.stringify(res._body);
      expect(clientBody).not.toContain("LEAKED_TOKEN_ABC");
      expect(clientBody).not.toContain("internal");
      expect(clientBody).not.toContain("debug info");
    });

    it("returns a safe errorCode and preserves the HTTP status code", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      });

      const req = makeReq("some prompt");
      const res = makeRes();

      await ImproveProxy(req, res);

      expect(res._status).toBe(429);
      expect((res._body as Record<string, unknown>).errorCode).toBe("upstream_error");
      expect((res._body as Record<string, unknown>).error).toBe("Upstream service error");
    });

    it("logs errorCode and requestId on upstream error (metadata only)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => "bad gateway",
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("some prompt");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).toContain("upstream_error");
      expect(allLogs).toContain("test-request-id-001");
      // The upstream response text must not be in logs.
      expect(allLogs).not.toContain("bad gateway");
    });
  });

  // ─── Case C: Thrown/unexpected error ─────────────────────────────────────

  describe("Case C — thrown/unexpected error", () => {
    it("does NOT include sensitive error message text in logs", async () => {
      const SENSITIVE_CONTENT = "SENSITIVE_PROMPT_IN_ERROR_MSG_ZQ77";

      mockFetch.mockRejectedValueOnce(
        new Error(`Connection failed. Prompt was: ${SENSITIVE_CONTENT}`)
      );

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("original prompt text");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(SENSITIVE_CONTENT);
    });

    it("returns a safe error response (no stack trace, no err.message) to the client", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Internal stack trace details SENSITIVE"));

      const req = makeReq("some prompt");
      const res = makeRes();

      await ImproveProxy(req, res);

      expect(res._status).toBe(500);
      const body = res._body as Record<string, unknown>;
      // Must use safe error code, not raw message.
      expect(body.errorCode).toBe("proxy_exception");
      expect(body.message).toBeUndefined();
      expect(body.stack).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("SENSITIVE");
    });

    it("logs errorCode and requestId on thrown error (metadata only)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("something went wrong"));

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("prompt text");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).toContain("proxy_exception");
      expect(allLogs).toContain("test-request-id-001");
    });
  });

  // ─── Case D: Secret/PII payload ───────────────────────────────────────────

  describe("Case D — secret/PII payload", () => {
    it("does NOT log API keys embedded in prompt text", async () => {
      const FAKE_API_KEY = "sk-FAKEAPIKEY12345ABCDEFGHIJKLMNOP";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: "improved" }),
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq(`Use this key: ${FAKE_API_KEY} in your prompt`);
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(FAKE_API_KEY);
    });

    it("does NOT log email addresses embedded in prompt text", async () => {
      const FAKE_EMAIL = "user.private@example-sensitive.com";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: "done" }),
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq(`Send results to ${FAKE_EMAIL}`);
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(FAKE_EMAIL);
    });

    it("does NOT log proprietary prompt text in any log line", async () => {
      const PROPRIETARY = "PROPRIETARY_WORKFLOW_PROMPT_TOKEN_9X2Z";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: "improved" }),
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq(PROPRIETARY);
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      for (const line of lines) {
        expect(line).not.toContain(PROPRIETARY);
      }
    });
  });

  // ─── Case E: Model response ───────────────────────────────────────────────

  describe("Case E — model response content", () => {
    it("does NOT log model-generated response content", async () => {
      const UNIQUE_MODEL_RESPONSE = "MODEL_GENERATED_OUTPUT_UNIQUE_STRING_WX99";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            improved: UNIQUE_MODEL_RESPONSE,
            metadata: { tokens: 42 },
          }),
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("some input prompt");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(UNIQUE_MODEL_RESPONSE);
    });

    it("does NOT log upstream response text even for large responses", async () => {
      const LARGE_RESPONSE_MARKER = "LARGE_RESPONSE_CONTENT_MARKER_ZZ88";
      const largeBody = JSON.stringify({
        improved: LARGE_RESPONSE_MARKER.repeat(100),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => largeBody,
      });

      const { lines, restore } = captureConsoleLogs();
      const req = makeReq("prompt text");
      const res = makeRes();

      await ImproveProxy(req, res);
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).not.toContain(LARGE_RESPONSE_MARKER);
    });
  });

  // ─── Regression tests ─────────────────────────────────────────────────────

  describe("Regression — metadata remains observable", () => {
    it("logs durationMs (latency) on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });

      const { lines, restore } = captureConsoleLogs();
      await ImproveProxy(makeReq("a prompt"), makeRes());
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).toContain("durationMs");
    });

    it("logs requestBytes on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });

      const { lines, restore } = captureConsoleLogs();
      await ImproveProxy(makeReq("a prompt"), makeRes());
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).toContain("requestBytes");
    });

    it("logs responseBytes on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: "improved" }),
      });

      const { lines, restore } = captureConsoleLogs();
      await ImproveProxy(makeReq("a prompt"), makeRes());
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).toContain("responseBytes");
    });

    it("logs status code on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });

      const { lines, restore } = captureConsoleLogs();
      await ImproveProxy(makeReq("a prompt"), makeRes());
      restore();

      const allLogs = lines.join("\n");
      expect(allLogs).toContain('"status":200');
    });

    it("returns the parsed JSON from upstream on success (functional regression)", async () => {
      const UPSTREAM_DATA = { improved: "better prompt text", score: 9 };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(UPSTREAM_DATA),
      });

      const req = makeReq("original prompt");
      const res = makeRes();

      await ImproveProxy(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toEqual(UPSTREAM_DATA);
    });
  });
});

// ── TestPromptProxy tests ─────────────────────────────────────────────────────

describe("TestPromptProxy — privacy-safe logging", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("does NOT echo err.message to the client on thrown error", async () => {
    const SENSITIVE_MSG = "SENSITIVE_MODEL_ERROR_CONTENT_PQ55";
    mockStreamText.mockRejectedValueOnce(new Error(SENSITIVE_MSG));

    const req = makeReq({ previewPrompt: "system instructions", userInput: "user query" });
    const res = makeRes();

    await TestPromptProxy(req, res);

    const body = JSON.stringify(res._body);
    expect(body).not.toContain(SENSITIVE_MSG);
    expect((res._body as Record<string, unknown>).message).toBeUndefined();
    expect((res._body as Record<string, unknown>).errorCode).toBe("proxy_exception");
  });

  it("does NOT log sensitive error content to console on thrown error", async () => {
    const SENSITIVE_ERR = "SENSITIVE_SYSTEM_PROMPT_IN_ERROR_LM22";
    mockStreamText.mockRejectedValueOnce(new Error(SENSITIVE_ERR));

    const { lines, restore } = captureConsoleLogs();
    const req = makeReq({ previewPrompt: "secret instructions", userInput: "hello" });
    const res = makeRes();

    await TestPromptProxy(req, res);
    restore();

    const allLogs = lines.join("\n");
    expect(allLogs).not.toContain(SENSITIVE_ERR);
  });

  it("logs metadata (requestId, errorCode) on exception", async () => {
    mockStreamText.mockRejectedValueOnce(new Error("some internal error"));

    const { lines, restore } = captureConsoleLogs();
    await TestPromptProxy(
      makeReq({ previewPrompt: "p", userInput: "u" }),
      makeRes()
    );
    restore();

    const allLogs = lines.join("\n");
    expect(allLogs).toContain("proxy_exception");
    expect(allLogs).toContain("test-request-id-001");
  });

  it("returns 400 with safe error when previewPrompt or userInput is missing", async () => {
    const req = makeReq({ previewPrompt: "something" }); // missing userInput
    const res = makeRes();

    await TestPromptProxy(req, res);

    expect(res._status).toBe(400);
    expect((res._body as Record<string, unknown>).error).toBe(
      "Missing previewPrompt or userInput"
    );
  });

  it("does NOT log previewPrompt or userInput on validation failure", async () => {
    const SECRET_PROMPT = "SECRET_PREVIEW_PROMPT_TEXT_RR44";

    const { lines, restore } = captureConsoleLogs();
    await TestPromptProxy(makeReq({ previewPrompt: SECRET_PROMPT }), makeRes());
    restore();

    const allLogs = lines.join("\n");
    expect(allLogs).not.toContain(SECRET_PROMPT);
  });
});
