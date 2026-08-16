import { describe, expect, it } from "vitest";
import {
  formatStroopsToFixedXlm,
  stroopsToXlmString,
  xlmToStroops,
} from "./format";

describe("stellar format helpers", () => {
  it("converts XLM to stroops", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
    expect(xlmToStroops("2.3456789")).toBe(23_456_789n);
    expect(xlmToStroops("-0.0000001")).toBe(-1n);
    expect(xlmToStroops("0")).toBe(0n);
  });

  it("converts stroops back to XLM strings", () => {
    expect(stroopsToXlmString(10_000_000n)).toBe("1");
    expect(stroopsToXlmString(23_456_789n)).toBe("2.3456789");
    expect(stroopsToXlmString(-1n)).toBe("-0.0000001");
    expect(stroopsToXlmString(90_071_992_547_409_931n)).toBe(
      "9007199254.7409931",
    );
  });

  it("round-trips signed stroop amounts without scientific notation", () => {
    const values = [
      0n,
      1n,
      -1n,
      10n,
      100n,
      1_000n,
      10_000n,
      100_000n,
      1_000_000n,
      10_000_000n,
      90_071_992_547_409_931n,
      -90_071_992_547_409_931n,
      123_456_789_012_345_678_901_234_567n,
    ];

    for (const stroops of values) {
      const formatted = stroopsToXlmString(stroops);
      expect(formatted).not.toMatch(/e/i);
      expect(xlmToStroops(formatted)).toBe(stroops);
    }
  });

  it("rejects inexact or partial decimal input", () => {
    for (const value of ["1.00000001", "1e2", "1.", ".1", "1 XLM", "NaN"]) {
      expect(() => xlmToStroops(value)).toThrow(
        "Enter a valid XLM amount with up to 7 decimal places.",
      );
    }
  });

  it("rounds display values without changing accounting precision", () => {
    expect(formatStroopsToFixedXlm(12_345_678n, 2)).toBe("1.23");
    expect(formatStroopsToFixedXlm(12_350_000n, 2)).toBe("1.24");
    expect(formatStroopsToFixedXlm(-12_350_000n, 2)).toBe("-1.24");
    expect(formatStroopsToFixedXlm(99_950_000n, 2)).toBe("10.00");
  });
});
