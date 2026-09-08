export interface SanitizeMarkdownResult {
  sanitized: string;
  hasBlockedElements: boolean;
  blockedTypes: string[];
}

/**
 * Strips HTML tags, script blocks, tracking beacons, and markdown images/links,
 * returning a safe, normalized plain-text preview snippet bounded to maxLength.
 */
export function sanitizePreviewText(input: unknown, maxLength = 280): string {
  if (!input || typeof input !== "string") {
    return "";
  }

  let text = input;
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  text = text.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  text = text.replace(/<iframe\b[^>]*\/?>/gi, "");
  text = text.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "");
  text = text.replace(/<embed\b[^>]*\/?>/gi, "");
  text = text.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "");
  text = text.replace(/<object\b[^>]*\/?>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

  const codePoints = Array.from(text);
  if (codePoints.length > maxLength) {
    return codePoints.slice(0, maxLength).join("").trimEnd() + "...";
  }

  return text;
}

/**
 * Sanitizes markdown content by neutralizing executable scripts, embedded frames,
 * inline event handlers, unsafe URI protocols, and tracking pixels while preserving
 * standard formatting constructs.
 */
export function sanitizePreviewMarkdown(
  input: unknown,
  maxLength = 4000
): SanitizeMarkdownResult {
  if (!input || typeof input !== "string") {
    return {
      sanitized: "",
      hasBlockedElements: false,
      blockedTypes: [],
    };
  }

  let text = input;
  const blockedTypes: string[] = [];

  const codePoints = Array.from(text);
  if (codePoints.length > maxLength) {
    text = codePoints.slice(0, maxLength).join("");
    blockedTypes.push("length_budget_exceeded");
  }

  if (/<script\b/i.test(text)) {
    blockedTypes.push("script_injection");
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  }

  if (/<style\b/i.test(text)) {
    blockedTypes.push("style_injection");
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  }

  if (/<iframe\b/i.test(text)) {
    blockedTypes.push("iframe_injection");
    text = text.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
    text = text.replace(/<iframe\b[^>]*\/?>/gi, "");
  }

  if (/<(embed|object|applet)\b/i.test(text)) {
    blockedTypes.push("embed_object_injection");
    text = text.replace(
      /<(embed|object|applet)\b[^<]*(?:(?!<\/(embed|object|applet)>)<[^<]*)*<\/(embed|object|applet)>/gi,
      ""
    );
    text = text.replace(/<(embed|object|applet)\b[^>]*\/?>/gi, "");
  }

  if (/\bon[a-z]+\s*=/i.test(text)) {
    blockedTypes.push("event_handler_injection");
    text = text.replace(/\s*\bon[a-z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, "");
  }

  const unsafeMarkdownLinkRegex = /(\[[^\]]*\])\(\s*(?:javascript|data|vbscript|file):[^)]*\)/gi;
  if (unsafeMarkdownLinkRegex.test(text)) {
    blockedTypes.push("unsafe_link_protocol");
    text = text.replace(
      unsafeMarkdownLinkRegex,
      (_match, label) => `${label}(#blocked-protocol)`
    );
  }

  const unsafeAttrRegex = /\b(href|src)\s*=\s*['"]?\s*(?:javascript|data|vbscript|file):[^'"> ]*['"]?/gi;
  if (unsafeAttrRegex.test(text)) {
    blockedTypes.push("unsafe_attribute_protocol");
    text = text.replace(unsafeAttrRegex, '$1="#blocked-protocol"');
  }

  const trackingPixelRegex = /!\[[^\]]*\]\([^)]*(?:1x1|pixel\.gif|tracking\.gif|\/beacon|track\.)[^)]*\)/gi;
  if (trackingPixelRegex.test(text)) {
    blockedTypes.push("tracking_pixel");
    text = text.replace(trackingPixelRegex, "");
  }

  return {
    sanitized: text,
    hasBlockedElements: blockedTypes.length > 0,
    blockedTypes,
  };
}
