import { Migration } from "./types";
import * as migration001 from "./001_user_profile_fields";
import * as migration002 from "./002_prompt_offchain_metadata";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_user_profile_fields",
    up: migration001.up,
    down: migration001.down,
  },
  {
    version: 2,
    name: "002_prompt_offchain_metadata",
    up: migration002.up,
    down: migration002.down,
  },
];
