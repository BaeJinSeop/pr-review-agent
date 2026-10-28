import { invoke } from "@tauri-apps/api/core";

export type SecretKey = "github_token" | "anthropic_api_key";

/** Secrets live in macOS Keychain / Windows Credential Manager, never in the config file. */
export const secrets = {
  get: (key: SecretKey) => invoke<string | null>("secret_get", { key }),
  set: (key: SecretKey, value: string) => invoke<void>("secret_set", { key, value }),
  delete: (key: SecretKey) => invoke<void>("secret_delete", { key }),
};
