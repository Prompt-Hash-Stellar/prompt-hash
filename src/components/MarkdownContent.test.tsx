import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent, isSafeUrl, isSafeImageUrl, isTrackingPixel } from "./MarkdownContent";

describe("MarkdownContent Security and Sandboxing", () => {
  it("neutralizes script tags and inline executable scripts", () => {
    const maliciousPayload = '<script>window.pwned = true;</script>Safe text after script';
    render(<MarkdownContent>{maliciousPayload}</MarkdownContent>);

    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("Safe text after script")).toBeInTheDocument();
  });

  it("neutralizes javascript: URLs in markdown links", () => {
    const maliciousLink = "[Click Me](javascript:alert('xss'))";
    render(<MarkdownContent>{maliciousLink}</MarkdownContent>);

    const anchor = document.querySelector("a");
    expect(anchor).toBeNull();

    const unsafeSpan = screen.getByTestId("unsafe-link");
    expect(unsafeSpan).toBeInTheDocument();
    expect(unsafeSpan.textContent).toBe("Click Me");
  });

  it("neutralizes data: text/html URLs in markdown links", () => {
    const dataLink = "[Data Link](data:text/html,<script>alert(1)</script>)";
    render(<MarkdownContent>{dataLink}</MarkdownContent>);

    expect(document.querySelector("a")).toBeNull();
    const unsafeSpan = screen.getByTestId("unsafe-link");
    expect(unsafeSpan).toBeInTheDocument();
  });

  it("neutralizes vbscript: URLs in markdown links", () => {
    const vbLink = "[VB Link](vbscript:msgbox(1))";
    render(<MarkdownContent>{vbLink}</MarkdownContent>);

    expect(document.querySelector("a")).toBeNull();
    const unsafeSpan = screen.getByTestId("unsafe-link");
    expect(unsafeSpan).toBeInTheDocument();
  });

  it("neutralizes onerror and inline DOM event attributes", () => {
    const eventPayload = '<img src="https://example.com/invalid.png" onerror="alert(1)" />';
    render(<MarkdownContent>{eventPayload}</MarkdownContent>);

    const images = document.querySelectorAll("img");
    images.forEach((img) => {
      expect(img.getAttribute("onerror")).toBeNull();
    });
  });

  it("enforces target blank and hardened rel attributes on safe external links", () => {
    const safeLink = "[Official Stellar Docs](https://developers.stellar.org)";
    render(<MarkdownContent>{safeLink}</MarkdownContent>);

    const anchor = screen.getByTestId("safe-link");
    expect(anchor).toBeInTheDocument();
    expect(anchor.getAttribute("href")).toBe("https://developers.stellar.org");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("allows safe mailto and fragment links", () => {
    const links = "[Contact](mailto:team@prompthash.local)\n\n[Section](#details)";
    render(<MarkdownContent>{links}</MarkdownContent>);

    const renderedLinks = screen.getAllByTestId("safe-link");
    expect(renderedLinks).toHaveLength(2);
    expect(renderedLinks[0].getAttribute("href")).toBe("mailto:team@prompthash.local");
    expect(renderedLinks[1].getAttribute("href")).toBe("#details");
  });

  it("neutralizes iframe elements and prevents frame injections", () => {
    const iframePayload = '<iframe src="https://attacker.example.com"></iframe>Plain Content';
    render(<MarkdownContent>{iframePayload}</MarkdownContent>);

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Plain Content")).toBeInTheDocument();
  });

  it("neutralizes embed and object tags", () => {
    const embedPayload = '<embed src="https://attacker.example.com/exploit.swf">Object text</embed>';
    render(<MarkdownContent>{embedPayload}</MarkdownContent>);

    expect(document.querySelector("embed")).toBeNull();
    expect(document.querySelector("object")).toBeNull();
  });

  it("renders safe images with lazy loading and constrained styling", () => {
    const imagePayload = "![Hero Banner](https://images.unsplash.com/photo-1)";
    render(<MarkdownContent>{imagePayload}</MarkdownContent>);

    const img = screen.getByTestId("preview-image");
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("src")).toBe("https://images.unsplash.com/photo-1");
    expect(img.getAttribute("alt")).toBe("Hero Banner");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(img.className).toContain("max-w-full");
    expect(img.className).toContain("max-h-96");
  });

  it("suppresses tracking pixels matching common beacon naming patterns", () => {
    const pixelPayload = "![Analytics](https://analytics.tracker.example.com/pixel.gif)";
    render(<MarkdownContent>{pixelPayload}</MarkdownContent>);

    expect(screen.queryByTestId("preview-image")).toBeNull();
  });

  it("suppresses tracking pixels matching 1x1 dimensions", () => {
    const pixelPayload = "![Beacon](https://tracker.example.com/1x1.png)";
    render(<MarkdownContent>{pixelPayload}</MarkdownContent>);

    expect(screen.queryByTestId("preview-image")).toBeNull();
  });

  it("wraps long unbroken strings to prevent horizontal layout blowout", () => {
    const unbrokenPayload = "A".repeat(2000);
    render(<MarkdownContent>{unbrokenPayload}</MarkdownContent>);

    const container = screen.getByTestId("markdown-preview-container");
    expect(container.className).toContain("break-words");
    expect(container.className).toContain("[overflow-wrap:anywhere]");
    expect(container.className).toContain("overflow-hidden");
  });

  it("enforces maxLength budget and renders truncation notice when exceeded", () => {
    const content = "This is a long description with lots of detailed explanations.";
    render(<MarkdownContent maxLength={20}>{content}</MarkdownContent>);

    expect(screen.getByText("This is a long descr")).toBeInTheDocument();
    expect(screen.queryByText(content)).toBeNull();
    expect(screen.getByTestId("preview-truncation-notice")).toHaveTextContent(
      "Preview truncated to 20 characters."
    );
  });

  it("renders allowed markdown formatting constructs cleanly", () => {
    const markdown = `
# Main Header
## Secondary Subtitle

Paragraph with **bold text**, *italic text*, and ~~strikethrough~~.

> Blockquote citation here

- List item one
- List item two

\`\`\`typescript
const answer: number = 42;
\`\`\`

| Feature | Support |
| :--- | :--- |
| Markdown | Yes |
`;

    render(<MarkdownContent>{markdown}</MarkdownContent>);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Main Header");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Secondary Subtitle");
    expect(screen.getByText("Main Header")).toBeInTheDocument();
    expect(screen.getByText("bold text")).toBeInTheDocument();
    expect(screen.getByText("List item one")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
  });
});

describe("URL and Pixel Helper Security Validation", () => {
  it("validates safe and unsafe link protocols accurately", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("http://example.com")).toBe(true);
    expect(isSafeUrl("mailto:support@prompthash.local")).toBe(true);
    expect(isSafeUrl("#anchor-target")).toBe(true);

    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,evil")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
  });

  it("validates image protocols strictly to http and https", () => {
    expect(isSafeImageUrl("https://example.com/pic.png")).toBe(true);
    expect(isSafeImageUrl("http://example.com/pic.png")).toBe(true);

    expect(isSafeImageUrl("data:image/svg+xml;utf8,<svg onload=alert(1)>")).toBe(false);
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("file:///tmp/pic.png")).toBe(false);
    expect(isSafeImageUrl("")).toBe(false);
    expect(isSafeImageUrl(undefined)).toBe(false);
  });

  it("detects tracking pixel patterns and 1x1 dimensions accurately", () => {
    expect(isTrackingPixel("https://cdn.example.com/tracker/1x1.png")).toBe(true);
    expect(isTrackingPixel("https://cdn.example.com/pixel.gif")).toBe(true);
    expect(isTrackingPixel("https://cdn.example.com/tracking.gif")).toBe(true);
    expect(isTrackingPixel("https://cdn.example.com/beacon")).toBe(true);
    expect(isTrackingPixel("https://track.example.com/img")).toBe(true);

    expect(isTrackingPixel("https://cdn.example.com/avatar.png", 1, 1)).toBe(true);
    expect(isTrackingPixel("https://cdn.example.com/avatar.png", "1", "1")).toBe(true);
    expect(isTrackingPixel("https://cdn.example.com/avatar.png", 0, 0)).toBe(true);

    expect(isTrackingPixel("https://cdn.example.com/banner.png", 800, 600)).toBe(false);
    expect(isTrackingPixel("https://cdn.example.com/banner.png")).toBe(false);
  });
});
