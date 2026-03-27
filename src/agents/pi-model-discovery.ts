import fs from "node:fs";
import path from "node:path";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { PROVIDER_ENV_API_KEY_CANDIDATES } from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";

const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;

export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

function createInMemoryAuthStorageBackend(
  initialData: PiCredentialMap,
): InMemoryAuthStorageBackendLike {
  let snapshot = JSON.stringify(initialData, null, 2);
  return {
    withLock<T>(
      update: (current: string) => {
        result: T;
        next?: string;
      },
    ): T {
      const { result, next } = update(snapshot);
      if (typeof next === "string") {
        snapshot = next;
      }
      return result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubLegacyStaticAuthJsonEntries(pathname: string): void {
  if (process.env.OPENCLAW_AUTH_STORE_READONLY === "1") {
    return;
  }
  if (!fs.existsSync(pathname)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  let changed = false;
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type !== "api_key") {
      continue;
    }
    delete parsed[provider];
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (Object.keys(parsed).length === 0) {
    fs.rmSync(pathname, { force: true });
    return;
  }

  fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = (
      PiCodingAgent as { InMemoryAuthStorageBackend?: new () => InMemoryAuthStorageBackendLike }
    ).InMemoryAuthStorageBackend;
    const backend =
      typeof backendCtor === "function"
        ? new backendCtor()
        : createInMemoryAuthStorageBackend(creds);
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as PiAuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as PiAuthStorage & {
    setRuntimeApiKey?: (provider: string, apiKey: string) => void; // pragma: allowlist secret
  };
  const hasRuntimeApiKeyOverride = typeof withRuntimeOverride.setRuntimeApiKey === "function"; // pragma: allowlist secret
  if (hasRuntimeApiKeyOverride) {
    for (const [provider, credential] of Object.entries(creds)) {
      if (credential.type === "api_key") {
        withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
        continue;
      }
      withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
    }
  }
  return withRuntimeOverride;
}

function resolveModelsJsonProviderApiKeys(modelsJsonPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    if (!fs.existsSync(modelsJsonPath)) {
      return result;
    }
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) {
      return result;
    }
    for (const [provider, config] of Object.entries(parsed.providers)) {
      if (!isRecord(config)) {
        continue;
      }
      const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
      if (apiKey && isNonSecretApiKeyMarker(apiKey)) {
        result[provider.trim()] = apiKey;
      }
    }
  } catch {
    // Ignore parse errors; models.json may not exist yet.
  }
  return result;
}

function resolvePiCredentials(agentDir: string): PiCredentialMap {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const credentials = resolvePiCredentialMapFromStore(store);
  // pi-coding-agent hides providers from its registry when auth storage lacks
  // a matching credential entry. Mirror env-backed provider auth here so
  // live/model discovery sees the same providers runtime auth can use.
  for (const provider of Object.keys(PROVIDER_ENV_API_KEY_CANDIDATES)) {
    if (credentials[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider);
    if (!resolved?.apiKey) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }

  // models.json may contain providers with non-secret API key markers (e.g.
  // "ollama-local", "custom-local") that were written during setup or plugin
  // discovery. The PiModelRegistry hides providers without a matching auth
  // storage entry, so inject these synthetic keys so the provider is visible
  // even when the matching env var (e.g. OLLAMA_API_KEY) is not set.
  const modelsJsonPath = path.join(agentDir, "models.json");
  const modelsJsonKeys = resolveModelsJsonProviderApiKeys(modelsJsonPath);
  for (const [provider, apiKey] of Object.entries(modelsJsonKeys)) {
    if (credentials[provider]) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: apiKey,
    };
  }

  return credentials;
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): PiAuthStorage {
  const credentials = resolvePiCredentials(agentDir);
  const authPath = path.join(agentDir, "auth.json");
  scrubLegacyStaticAuthJsonEntries(authPath);
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

export function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry {
  return new PiModelRegistryClass(authStorage, path.join(agentDir, "models.json"));
}
