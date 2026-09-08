import {
  sanitizePreviewText,
  sanitizePreviewMarkdown,
} from "../utils/previewSanitizer";

describe("Server-Side Preview and Search Sanitization", () => {
  describe("sanitizePreviewText", () => {
    it("strips script blocks and enclosed JavaScript completely", () => {
      const payload = "<script>alert('pwned'); document.cookie = '';</script>Legitimate description";
      const result = sanitizePreviewText(payload);

      expect(result).toBe("Legitimate description");
      expect(result).not.toContain("alert");
      expect(result).not.toContain("<script>");
    });

    it("strips style and iframe tags completely", () => {
      const payload = "<style>body{display:none;}</style><iframe src=\"https://malicious.example.com\"></iframe>Clean preview text";
      const result = sanitizePreviewText(payload);

      expect(result).toBe("Clean preview text");
      expect(result).not.toContain("iframe");
      expect(result).not.toContain("display:none");
    });

    it("strips embed and object tags", () => {
      const payload = "<embed src=\"exploit.swf\"><object data=\"exploit.pdf\">fallback</object>Valid content";
      const result = sanitizePreviewText(payload);

      expect(result).toBe("Valid content");
      expect(result).not.toContain("embed");
      expect(result).not.toContain("object");
    });

    it("strips HTML tags while preserving inner text content", () => {
      const payload = "<p>This is <strong>bold</strong> and <em>italic</em> with a <a href=\"https://stellar.org\">link</a>.</p>";
      const result = sanitizePreviewText(payload);

      expect(result).toBe("This is bold and italic with a link.");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });

    it("extracts markdown link and image labels cleanly without URLs", () => {
      const payload = "Check out [Stellar](https://stellar.org) and ![Logo](https://stellar.org/logo.png).";
      const result = sanitizePreviewText(payload);

      expect(result).toBe("Check out Stellar and Logo.");
      expect(result).not.toContain("https://");
    });

    it("normalizes excessive whitespace, linebreaks, and tabs", () => {
      const payload = "  First line \n\n  Second line \t with  spaces   ";
      const result = sanitizePreviewText(payload);

      expect(result).toBe("First line Second line with spaces");
    });

    it("enforces length budget with ellipsis without cutting surrogate pairs", () => {
      const longInput = "A".repeat(500);
      const result = sanitizePreviewText(longInput, 100);

      expect(result.length).toBe(103);
      expect(result.endsWith("...")).toBe(true);
      expect(result.startsWith("A".repeat(100))).toBe(true);
    });

    it("handles non-string or falsy input gracefully", () => {
      expect(sanitizePreviewText(null)).toBe("");
      expect(sanitizePreviewText(undefined)).toBe("");
      expect(sanitizePreviewText(12345 as unknown as string)).toBe("");
      expect(sanitizePreviewText("")).toBe("");
    });
  });

  describe("sanitizePreviewMarkdown", () => {
    it("neutralizes script injection attempts and reports blocked elements", () => {
      const input = "## Heading\n\n<script>alert(1)</script>\n\nValid description text.";
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(input);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("script_injection");
      expect(sanitized).not.toContain("<script");
      expect(sanitized).toContain("## Heading");
      expect(sanitized).toContain("Valid description text.");
    });

    it("neutralizes iframe and embed injections", () => {
      const input = "<iframe src=\"https://malicious.org\"></iframe>\n<embed src=\"test.swf\"/>\nParagraph.";
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(input);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("iframe_injection");
      expect(blockedTypes).toContain("embed_object_injection");
      expect(sanitized).not.toContain("<iframe");
      expect(sanitized).not.toContain("<embed");
      expect(sanitized).toContain("Paragraph.");
    });

    it("neutralizes inline event handlers like onerror and onload", () => {
      const input = "<img src=\"https://example.com/pic.png\" onerror=\"alert('xss')\" onload=\"alert(2)\" />";
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(input);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("event_handler_injection");
      expect(sanitized).not.toContain("onerror");
      expect(sanitized).not.toContain("onload");
      expect(sanitized).not.toContain("alert");
    });

    it("neutralizes javascript: and data: protocols in markdown links", () => {
      const input = "[Malicious](javascript:alert(1)) and [Data](data:text/html,<script>alert(2)</script>)";
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(input);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("unsafe_link_protocol");
      expect(sanitized).not.toContain("javascript:");
      expect(sanitized).not.toContain("data:");
      expect(sanitized).toContain("[Malicious](#blocked-protocol)");
      expect(sanitized).toContain("[Data](#blocked-protocol)");
    });

    it("neutralizes unsafe protocol attributes in raw tags", () => {
      const input = "<a href=\"javascript:void(0)\">Click</a>";
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(input);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("unsafe_attribute_protocol");
      expect(sanitized).toContain("href=\"#blocked-protocol\"");
    });

    it("strips tracking pixels matching beacon patterns", () => {
      const input = "Prompt overview.\n\n![tracker](https://metrics.example.com/pixel.gif?user=test)\n\n![1x1](https://tracker.com/1x1.png)";
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(input);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("tracking_pixel");
      expect(sanitized).not.toContain("pixel.gif");
      expect(sanitized).not.toContain("1x1.png");
      expect(sanitized).toContain("Prompt overview.");
    });

    it("preserves standard markdown formatting without false positive flag triggers", () => {
      const validMarkdown = [
        "# Title",
        "## Subtitle",
        "",
        "This is a **bold** paragraph with *italics* and `inline code`.",
        "",
        "- Bullet one",
        "- Bullet two",
        "",
        "[Legitimate Stellar Link](https://stellar.org)",
        "",
        "```typescript",
        "const price: number = 50;",
        "```",
      ].join("\n");

      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(validMarkdown);

      expect(hasBlockedElements).toBe(false);
      expect(blockedTypes).toHaveLength(0);
      expect(sanitized).toBe(validMarkdown);
    });

    it("enforces length budget when content exceeds maximum allowed characters", () => {
      const excessiveContent = "B".repeat(5000);
      const { sanitized, hasBlockedElements, blockedTypes } = sanitizePreviewMarkdown(excessiveContent, 4000);

      expect(hasBlockedElements).toBe(true);
      expect(blockedTypes).toContain("length_budget_exceeded");
      expect(sanitized.length).toBe(4000);
    });

    it("handles non-string inputs gracefully without throwing exceptions", () => {
      const result = sanitizePreviewMarkdown(null);
      expect(result.sanitized).toBe("");
      expect(result.hasBlockedElements).toBe(false);
      expect(result.blockedTypes).toEqual([]);
    });
  });
});
