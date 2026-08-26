/**
 * Search security utilities and error handling (Issue #155)
 */

export class SearchBudgetError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string = "SEARCH_BUDGET_EXCEEDED", statusCode: number = 400) {
    super(message);
    this.name = "SearchBudgetError";
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Escapes special regex metacharacters in input string so it can be treated as a literal.
 */
export function escapeRegex(input: string): string {
  if (!input) return "";
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const MAX_QUERY_LENGTH = 100;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SUGGESTION_LIMIT = 20;
export const MAX_SEARCH_TIME_MS = 2000;
export const MAX_SUGGESTION_TIME_MS = 1000;
