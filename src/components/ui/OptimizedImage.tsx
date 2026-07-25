import React, { useState, useCallback } from "react";
import { cn } from "@/lib/utils";

/** Fallback SVG rendered when an image URL is missing or fails to load.
 *  It is inlined to avoid a network round-trip and is intentionally small. */
const FallbackIcon = ({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) => (
  <div
    className={cn(
      "flex items-center justify-center bg-slate-900 text-slate-600",
      className,
    )}
    style={style}
    aria-hidden="true"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-1/3 w-1/3 opacity-40"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  </div>
);

export interface OptimizedImageProps
  extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** Source URL for the image. Falls back gracefully when empty or broken. */
  src?: string;
  /** Alt text — required for accessibility. */
  alt: string;
  /** Extra className applied to the outer wrapper div. */
  wrapperClassName?: string;
  /**
   * Aspect ratio to reserve space before the image loads, preventing CLS.
   * Expressed as a CSS aspect-ratio value, e.g. "16/9" or "1".
   * When provided, both the wrapper and the img fill 100% of their container.
   */
  aspectRatio?: string;
  /**
   * Loading strategy.
   * Defaults to "lazy" for below-the-fold images.
   * Set to "eager" for above-the-fold / LCP images.
   */
  loading?: "lazy" | "eager";
}

/**
 * OptimizedImage — a drop-in replacement for `<img>` that:
 *  - Prevents layout shift (CLS) via `aspect-ratio` reservation.
 *  - Lazy-loads by default (`loading="lazy"`).
 *  - Fades in smoothly once loaded.
 *  - Renders a consistent, inline fallback on missing/broken URLs.
 */
export const OptimizedImage = React.memo(function OptimizedImage({
  src,
  alt,
  className,
  wrapperClassName,
  aspectRatio,
  loading = "lazy",
  style,
  ...rest
}: OptimizedImageProps) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    src ? "loading" : "error",
  );

  const handleLoad = useCallback(() => setStatus("loaded"), []);
  const handleError = useCallback(() => setStatus("error"), []);

  const wrapperStyle: React.CSSProperties = aspectRatio
    ? { aspectRatio, position: "relative", overflow: "hidden", ...style }
    : { position: "relative", overflow: "hidden", ...style };

  const imgStyle: React.CSSProperties = aspectRatio
    ? {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        opacity: status === "loaded" ? 1 : 0,
        transition: "opacity 0.3s ease",
      }
    : {
        opacity: status === "loaded" ? 1 : 0,
        transition: "opacity 0.3s ease",
      };

  if (status === "error" || !src) {
    return (
      <FallbackIcon
        className={cn("h-full w-full", wrapperClassName, className)}
        style={aspectRatio ? { aspectRatio, ...style } : style}
      />
    );
  }

  return (
    <div className={wrapperClassName} style={wrapperStyle}>
      {/* Placeholder skeleton shown while the image loads */}
      {status === "loading" && (
        <div
          className="absolute inset-0 animate-pulse bg-slate-800"
          aria-hidden="true"
        />
      )}
      <img
        src={src}
        alt={alt}
        loading={loading}
        onLoad={handleLoad}
        onError={handleError}
        className={className}
        style={imgStyle}
        {...rest}
      />
    </div>
  );
});
