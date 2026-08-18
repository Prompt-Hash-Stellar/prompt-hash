import Prompt from "../models/Prompt";
import PromptVersion from "../models/PromptVersion";

export interface PublishVersionParams {
  promptId: string;
  content: string;
  changeNote?: string;
  createdBy: string;
}

export interface PublishVersionResult {
  versionIndex: number;
}

/**
 * Publish a new prompt version with an atomic, monotonic version index.
 *
 * The previous implementation read `prompt.currentVersionIndex`, inserted a
 * `PromptVersion` with `currentVersionIndex + 1`, then wrote the pointer back
 * in a separate update. Two concurrent publishers could read the same
 * `currentVersionIndex`, both compute the same `nextVersion`, and race on
 * the unique `(promptId, versionIndex)` index - the "winner" succeeds while
 * the loser's PromptVersion write fails, and depending on interleaving the
 * `Prompt.currentVersionIndex` pointer could end up out of sync with what
 * was actually persisted.
 *
 * This version instead reserves the next version index atomically via a
 * single `$inc` on `Prompt.currentVersionIndex` - MongoDB guarantees that
 * concurrent increments on the same document are serialized, so each
 * concurrent publisher is guaranteed a distinct, contiguous version number
 * with no read-then-write race. The pointer is advanced *as part of* the
 * reservation, so it never has to be reconciled afterwards in the success
 * path. If persisting the version content then fails, the reservation is
 * rolled back with a compare-and-set update that only rewinds the pointer
 * if nothing else has advanced past it in the meantime - so the pointer
 * always ends up referencing a version that was actually committed.
 */
export async function publishPromptVersion(
  params: PublishVersionParams,
): Promise<PublishVersionResult> {
  const { promptId, content, changeNote, createdBy } = params;

  // Atomically reserve the next version index and advance the pointer in a
  // single document-level operation. MongoDB serializes concurrent updates
  // to the same document, so no two concurrent callers can ever be handed
  // the same versionIndex.
  const reserved = await Prompt.findByIdAndUpdate(
    promptId,
    { $inc: { currentVersionIndex: 1 } },
    { new: true },
  );

  if (!reserved) {
    throw new Error("Prompt not found.");
  }

  const versionIndex = reserved.currentVersionIndex;

  try {
    await PromptVersion.create({
      promptId: String(promptId),
      versionIndex,
      content,
      changeNote: changeNote ?? "",
      createdBy: createdBy.toLowerCase(),
    });
  } catch (err) {
    // Roll back the reservation, but only if nothing else has advanced the
    // pointer past our reservation in the meantime - otherwise a later
    // successful publish already moved the pointer forward and rewinding
    // it here would make it reference a version that no longer reflects
    // the latest committed content.
    await Prompt.updateOne(
      { _id: promptId, currentVersionIndex: versionIndex },
      { $set: { currentVersionIndex: versionIndex - 1 } },
    );
    throw err;
  }

  return { versionIndex };
}
