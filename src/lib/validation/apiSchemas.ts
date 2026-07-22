import { z } from "zod";

export const challengeSchema = z.object({
  address: z.string().min(1, "Wallet address is required."),
  promptId: z.string().min(1, "Prompt ID is required."),
});

export const unlockSchema = z.object({
  token: z.string().min(1, "Token is required."),
  promptId: z.string().min(1, "Prompt ID is required."),
  address: z.string().min(1, "Wallet address is required."),
  signedMessage: z.string().min(1, "Signed message is required."),
});

export const reviewSubmitSchema = z.object({
  promptId: z.string().min(1, "Prompt ID is required."),
});

export const reviewListSchema = z.object({
  promptId: z.string().min(1, "Prompt ID is required."),
});

export type ChallengeInput = z.infer<typeof challengeSchema>;
export type UnlockInput = z.infer<typeof unlockSchema>;
export type ReviewSubmitInput = z.infer<typeof reviewSubmitSchema>;
export type ReviewListInput = z.infer<typeof reviewListSchema>;