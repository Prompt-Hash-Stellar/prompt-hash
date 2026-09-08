import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

export interface MarkdownContentProps {
  children: string;
  className?: string;
  maxLength?: number;
}

const DISALLOWED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "embed",
  "object",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "base",
  "link",
  "meta",
  "applet",
]);

export const previewSanitizeSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => !DISALLOWED_TAGS.has(tag)),
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  attributes: {
    ...defaultSchema.attributes,
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading", "decoding"],
    code: ["className"],
    th: ["align"],
    td: ["align"],
  },
};

/**
 * Strips executable script blocks and embedded frames before AST parsing to prevent
 * raw HTML block absorption from swallowing following inline text.
 */
export function stripDangerousRawTags(input: string): string {
  if (!input || typeof input !== "string") {
    return "";
  }
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<iframe\b[^>]*\/?>/gi, "")
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "")
    .replace(/<object\b[^>]*\/?>/gi, "");
}

/**
 * Validates link targets against allowed protocols.
 * Allows http, https, mailto, and in-page anchor fragments.
 */
export function isSafeUrl(url?: string): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, "https://prompthash.local");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validates image sources to prevent XSS and unsafe protocols.
 * Restricts sources strictly to http and https.
 */
export function isSafeImageUrl(url?: string): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed, "https://prompthash.local");
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Detects tracking pixel signatures through zero/one dimensions or known beacon patterns.
 */
export function isTrackingPixel(
  src?: string,
  width?: string | number,
  height?: string | number
): boolean {
  if (width !== undefined && height !== undefined) {
    const numW = typeof width === "number" ? width : Number.parseInt(String(width), 10);
    const numH = typeof height === "number" ? height : Number.parseInt(String(height), 10);
    if (!Number.isNaN(numW) && !Number.isNaN(numH) && numW <= 1 && numH <= 1) {
      return true;
    }
  }
  if (!src || typeof src !== "string") {
    return false;
  }
  const lower = src.toLowerCase();
  return (
    lower.includes("1x1") ||
    lower.includes("pixel.gif") ||
    lower.includes("tracking.gif") ||
    lower.includes("/pixel") ||
    lower.includes("/beacon") ||
    lower.includes("track.")
  );
}

/**
 * Sandboxed markdown and rich text preview renderer.
 * Enforces sanitization, neutralizes malicious protocols, sandboxes links and media,
 * and restricts layout-breaking payloads.
 */
export function MarkdownContent({
  children,
  className = "",
  maxLength,
}: MarkdownContentProps) {
  if (!children) {
    return null;
  }

  const isTruncated = typeof maxLength === "number" && children.length > maxLength;
  const rawContent = isTruncated ? children.slice(0, maxLength) : children;
  const contentToRender = stripDangerousRawTags(rawContent);

  return (
    <div
      data-testid="markdown-preview-container"
      className={[
        "prose prose-invert prose-sm max-w-none break-words [overflow-wrap:anywhere] overflow-hidden",
        "prose-headings:text-slate-100 prose-headings:font-semibold",
        "prose-p:text-slate-300 prose-p:leading-relaxed",
        "prose-strong:text-slate-100",
        "prose-blockquote:border-l-emerald-500/50 prose-blockquote:text-slate-400",
        "prose-ul:text-slate-300 prose-ol:text-slate-300",
        "prose-hr:border-white/10",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, previewSanitizeSchema]]}
        components={{
          a: ({ href, children: linkChildren, ...props }) => {
            if (!href || !isSafeUrl(href)) {
              return (
                <span
                  data-testid="unsafe-link"
                  className="text-slate-400 underline decoration-dotted cursor-not-allowed"
                  title="Unsafe link neutralized"
                >
                  {linkChildren}
                </span>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                data-testid="safe-link"
                className="text-emerald-400 no-underline hover:underline break-words"
                {...props}
              >
                {linkChildren}
              </a>
            );
          },
          img: ({ src, alt, width, height, ...props }) => {
            if (isTrackingPixel(src, width, height) || !isSafeImageUrl(src)) {
              return null;
            }
            return (
              <img
                src={src}
                alt={alt || "Preview media"}
                loading="lazy"
                decoding="async"
                data-testid="preview-image"
                className="max-w-full h-auto max-h-96 rounded-lg border border-white/10 object-contain my-2 block"
                {...props}
              />
            );
          },
          iframe: () => (
            <div
              data-testid="neutralized-iframe"
              className="my-2 p-2 rounded bg-slate-800/80 border border-slate-700 text-xs text-slate-400"
            >
              Embedded content is disabled in preview mode.
            </div>
          ),
          embed: () => (
            <div
              data-testid="neutralized-embed"
              className="my-2 p-2 rounded bg-slate-800/80 border border-slate-700 text-xs text-slate-400"
            >
              Embedded plugins are disabled in preview mode.
            </div>
          ),
          object: () => (
            <div
              data-testid="neutralized-object"
              className="my-2 p-2 rounded bg-slate-800/80 border border-slate-700 text-xs text-slate-400"
            >
              Embedded objects are disabled in preview mode.
            </div>
          ),
          pre: ({ children: preChildren, ...props }) => (
            <pre
              className="bg-slate-800/60 border border-white/10 rounded-lg overflow-x-auto max-w-full p-3 my-2"
              {...props}
            >
              {preChildren}
            </pre>
          ),
          code: ({ children: codeChildren, className: codeClassName, ...props }) => {
            const isInline = !codeClassName;
            if (isInline) {
              return (
                <code
                  className="text-emerald-300 bg-slate-800/60 px-1 py-0.5 rounded text-xs break-all"
                  {...props}
                >
                  {codeChildren}
                </code>
              );
            }
            return (
              <code className={codeClassName} {...props}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {contentToRender}
      </ReactMarkdown>

      {isTruncated && (
        <div
          data-testid="preview-truncation-notice"
          className="mt-2 text-xs text-amber-400/90 italic"
        >
          Preview truncated to {maxLength} characters.
        </div>
      )}
    </div>
  );
}
