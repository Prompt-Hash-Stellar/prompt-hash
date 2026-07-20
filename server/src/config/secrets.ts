import { z } from "zod";

// Server-only module. Never import this file from src/ (the browser bundle).
const schema = z.object({
  MONGODB_URI: z.string().min(1),
  CHALLENGE_TOKEN_SECRET: z.string().min(32),
  UNLOCK_PRIVATE_KEY: z.string().min(32),
});

export function loadServerSecrets(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new Error("Missing or invalid server-only configuration");
  return Object.freeze(parsed.data);
}
