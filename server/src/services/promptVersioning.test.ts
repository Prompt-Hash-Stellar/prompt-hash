/**
 * Tests for publishPromptVersion (Issue #165).
 *
 * New version numbers must be reserved atomically so concurrent publishers
 * cannot be handed the same index, and the Prompt pointer must never end
 * up referencing a version that failed to persist.
 */

jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: {
    findByIdAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../models/PromptVersion", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));

import Prompt from "../models/Prompt";
import PromptVersion from "../models/PromptVersion";
import { publishPromptVersion } from "./promptVersioning";

const mockFindByIdAndUpdate = Prompt.findByIdAndUpdate as jest.Mock;
const mockUpdateOne = Prompt.updateOne as jest.Mock;
const mockCreate = PromptVersion.create as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("publishPromptVersion", () => {
  it("reserves the version atomically via $inc before persisting content", async () => {
    mockFindByIdAndUpdate.mockResolvedValueOnce({ currentVersionIndex: 4 });
    mockCreate.mockResolvedValueOnce({});

    const result = await publishPromptVersion({
      promptId: "p1",
      content: "hello",
      changeNote: "note",
      createdBy: "GWALLET",
    });

    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "p1",
      { $inc: { currentVersionIndex: 1 } },
      { new: true },
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ promptId: "p1", versionIndex: 4, content: "hello" }),
    );
    expect(result).toEqual({ versionIndex: 4 });
  });

  it("gives concurrent publishers distinct contiguous versions (simulated race)", async () => {
    // Simulate two concurrent calls: MongoDB serializes the $inc, so the
    // mock returns two distinct incremented values in sequence.
    mockFindByIdAndUpdate
      .mockResolvedValueOnce({ currentVersionIndex: 5 })
      .mockResolvedValueOnce({ currentVersionIndex: 6 });
    mockCreate.mockResolvedValue({});

    const [a, b] = await Promise.all([
      publishPromptVersion({ promptId: "p1", content: "a", createdBy: "GA" }),
      publishPromptVersion({ promptId: "p1", content: "b", createdBy: "GB" }),
    ]);

    expect(new Set([a.versionIndex, b.versionIndex]).size).toBe(2);
    expect([a.versionIndex, b.versionIndex].sort()).toEqual([5, 6]);
  });

  it("rolls back the reservation via compare-and-set when content persistence fails", async () => {
    mockFindByIdAndUpdate.mockResolvedValueOnce({ currentVersionIndex: 7 });
    mockCreate.mockRejectedValueOnce(new Error("write failed"));

    await expect(
      publishPromptVersion({ promptId: "p1", content: "x", createdBy: "GA" }),
    ).rejects.toThrow("write failed");

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "p1", currentVersionIndex: 7 },
      { $set: { currentVersionIndex: 6 } },
    );
  });

  it("throws when the prompt does not exist", async () => {
    mockFindByIdAndUpdate.mockResolvedValueOnce(null);

    await expect(
      publishPromptVersion({ promptId: "missing", content: "x", createdBy: "GA" }),
    ).rejects.toThrow("Prompt not found.");

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
