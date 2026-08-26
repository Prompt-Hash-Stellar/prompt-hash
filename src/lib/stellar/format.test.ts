import { describe, expect, it } from "vitest";
import { stroopsToXlmString, xlmToStroops } from "./format";

describe("stellar format helpers", () => {
  it("converts XLM to stroops", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
    expect(xlmToStroops("2.3456789")).toBe(23_456_789n);
  });

  it("converts stroops back to XLM strings", () => {
    expect(stroopsToXlmString(10_000_000n)).toBe("1");
    expect(stroopsToXlmString(23_456_789n)).toBe("2.3456789");
  });
});

describe("round-trip and edge cases", () => {
  it("round-trips various stroop values exactly", () => {
    const cases: bigint[] = [
      0n,
      1n, // smallest stroop -> 0.0000001
      10_000_000n,
      23_456_789n,
      -23_456_789n,
      1234567890123456789012345n, // large value beyond Number.MAX_SAFE_INTEGER
    ];

    for (const v of cases) {
      const s = stroopsToXlmString(v);
      const parsed = xlmToStroops(s);
      expect(parsed).toBe(v);
    }
  });

  it("formats 1-7 decimal places correctly", () => {
    expect(stroopsToXlmString(1n)).toBe("0.0000001");
    expect(stroopsToXlmString(10n)).toBe("0.000001");
    expect(stroopsToXlmString(100n)).toBe("0.00001");
    expect(stroopsToXlmString(1_000n)).toBe("0.0001");
    expect(stroopsToXlmString(10_000n)).toBe("0.001");
    expect(stroopsToXlmString(100_000n)).toBe("0.01");
    expect(stroopsToXlmString(1_000_000n)).toBe("0.1");
  });
});
