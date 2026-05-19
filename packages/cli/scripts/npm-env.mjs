const NPM_ENV_BLOCKLIST = [
  "npm_config__jsr_registry",
  "npm_config_catalogs",
  "npm_config_dry-run",
  "npm_config_dry_run",
  "npm_config_npm_globalconfig",
  "npm_config_recursive",
  "npm_config_verify_deps_before_run",
  "NPM_CONFIG_DRY_RUN",
];

export function npmEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of NPM_ENV_BLOCKLIST) {
    delete env[key];
  }
  return env;
}
