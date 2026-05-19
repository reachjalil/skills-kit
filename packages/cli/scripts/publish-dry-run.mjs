#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { npmEnv } from "./npm-env.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

execFileSync("npm", ["publish", "--dry-run", "--access", "public"], {
  cwd: packageDir,
  stdio: "inherit",
  env: npmEnv(),
});
