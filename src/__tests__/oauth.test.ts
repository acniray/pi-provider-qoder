import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoLoginQoderFromEnvironment,
  clearQoderAuthMemCache,
  getCachedCredentials,
  getQoderPatForMode,
} from "../auth/oauth.js";
import { credentialsFromPat } from "../auth/pat.js";
import { updateQoderModelsCache } from "../catalog.js";
import { loadLiveFixture } from "./live-fixture.js";

const AUTH_FILE = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent", "auth.json");

const PAT_ENV_NAMES = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;

function clearPatEnv(): void {
  for (const name of PAT_ENV_NAMES) {
    delete process.env[name];
  }
}

vi.mock("../auth/pat.js", () => ({
  credentialsFromPat: vi.fn().mockResolvedValue({
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3600000,
    userID: "mock-user-123",
    email: "test@example.com",
    name: "Test User",
    machineID: "mock-machine-id",
    type: "oauth",
  }),
  isPatRefresh: vi.fn((refresh: string) => refresh.startsWith("pat|")),
  decodePatRefresh: vi.fn((refresh: string) => {
    const parts = refresh.split("|");
    return {
      pat: parts[1] || "",
      jobRefreshToken: parts[2] || "",
      userID: parts[3] || "",
      machineID: parts[4] || "",
    };
  }),
}));

vi.mock("../catalog.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  getCachedModels: vi.fn().mockReturnValue([]),
  isCacheStale: vi.fn().mockReturnValue(true),
  staticModels: [],
  staticCnModels: [],
}));

describe("oauth autoLoginQoderFromEnvironment", () => {
  const originalEnv = process.env;
  let originalAuth: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    clearPatEnv();
    clearQoderAuthMemCache();
    originalAuth = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, "utf8") : undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalAuth === undefined) rmSync(AUTH_FILE, { force: true });
    else writeFileSync(AUTH_FILE, originalAuth, "utf8");
    clearQoderAuthMemCache();
  });

  it("extracts PAT correctly from env for global and CN mode", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    expect(getQoderPatForMode("global")).toBe("pt-global-123");

    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-456";
    expect(getQoderPatForMode("cn")).toBe("pt-cn-456");
  });

  it("does nothing if no PAT in environment", async () => {
    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");
    expect(getCachedCredentials("mock-token", "qoder-test-provider")).toBeNull();
  });

  it("re-exchanges when cached credentials are not PAT-backed", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-new-account";
    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth["qoder-test-provider"] = {
      type: "oauth",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 3600000,
      userID: "old-user",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).toHaveBeenCalledWith("pt-global-new-account", "global");
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "mock-access-token",
      "mock-user-123",
      "Test User",
      "test@example.com",
      "global",
    );
  });

  it("does zero network auth/catalog work for same PAT + valid job token + fresh model cache", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-same";
    vi.mocked(updateQoderModelsCache).mockClear();
    const { isCacheStale } = await import("../catalog.js");
    vi.mocked(isCacheStale).mockReturnValueOnce(false);

    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth["qoder-test-provider"] = {
      type: "oauth",
      access: "cached-job-token",
      refresh: "pat|pt-global-same|cached-jrt|cached-user|cached-machine",
      expires: Date.now() + 3600000,
      userID: "cached-user",
      email: "cached@example.com",
      name: "Cached User",
      machineID: "cached-machine",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");
    clearQoderAuthMemCache();

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).not.toHaveBeenCalled();
    expect(updateQoderModelsCache).not.toHaveBeenCalled();
    expect(getCachedCredentials("", "qoder-test-provider")?.access).toBe("cached-job-token");
  });

  it("reuses the job token but refreshes a stale model cache with one network call", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-same";
    const { isCacheStale } = await import("../catalog.js");
    vi.mocked(isCacheStale).mockReturnValueOnce(true);

    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth["qoder-test-provider"] = {
      type: "oauth",
      access: "cached-job-token",
      refresh: "pat|pt-global-same|cached-jrt|cached-user|cached-machine",
      expires: Date.now() + 3600000,
      userID: "cached-user",
      email: "cached@example.com",
      name: "Cached User",
      machineID: "cached-machine",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");
    clearQoderAuthMemCache();

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).not.toHaveBeenCalled();
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "cached-job-token",
      "cached-user",
      "Cached User",
      "cached@example.com",
      "global",
    );
  });

  it("re-exchanges when the cached PAT differs or the job token is expired", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-current";
    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};

    auth["qoder-test-provider"] = {
      type: "oauth",
      access: "old-job-token",
      refresh: "pat|pt-global-other|old-jrt|old-user|old-machine",
      expires: Date.now() + 3600000,
      userID: "old-user",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");
    clearQoderAuthMemCache();

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");
    expect(credentialsFromPat).toHaveBeenCalledTimes(1);

    vi.mocked(credentialsFromPat).mockClear();
    const nextAuth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    nextAuth["qoder-test-provider"] = {
      type: "oauth",
      access: "expired-job-token",
      refresh: "pat|pt-global-current|old-jrt|old-user|old-machine",
      expires: Date.now() - 1,
      userID: "old-user",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(nextAuth), "utf8");
    clearQoderAuthMemCache();

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");
    expect(credentialsFromPat).toHaveBeenCalledTimes(1);
  });

  it("passes a recorded-format identity into the model catalog refresh", async () => {
    const identity = loadLiveFixture("global").interactions.userinfo.response.body as {
      id: string;
      email: string;
      name: string;
    };
    vi.mocked(credentialsFromPat).mockResolvedValueOnce({
      access: "<redacted:job-token>",
      refresh: "<redacted:refresh-token>",
      expires: Date.now() + 3600000,
      userID: identity.id,
      email: identity.email,
      name: identity.name,
      machineID: "<redacted:machine-id>",
      type: "oauth",
    } as never);
    clearPatEnv();
    process.env.QODER_PAT = "test-only-pat";

    await autoLoginQoderFromEnvironment("qoder-fixture-provider", "global");

    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "<redacted:job-token>",
      identity.id,
      identity.name,
      identity.email,
      "global",
    );
  });
});
