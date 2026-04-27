import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetProjectScopeCacheForTests,
  getProjectDiscordGuilds,
} from "./projectScope.js";

const ENV_KEY = "PROJECT_DISCORD_GUILDS";

describe("getProjectDiscordGuilds", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    __resetProjectScopeCacheForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    __resetProjectScopeCacheForTests();
  });

  it("returns undefined when env var is unset (back-compat)", () => {
    expect(getProjectDiscordGuilds("owner/repo")).toBeUndefined();
  });

  it("returns the configured guild list for a mapped project", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "better-auth/better-auth": ["1288403910284935179"],
      "owner/other": ["g1", "g2"],
    });
    __resetProjectScopeCacheForTests();

    expect(getProjectDiscordGuilds("better-auth/better-auth")).toEqual([
      "1288403910284935179",
    ]);
    expect(getProjectDiscordGuilds("owner/other")).toEqual(["g1", "g2"]);
  });

  it("returns an empty array (suppress) for a project missing from a configured map", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "better-auth/better-auth": ["1288403910284935179"],
    });
    __resetProjectScopeCacheForTests();

    expect(getProjectDiscordGuilds("unmapped/project")).toEqual([]);
  });

  it("filters out non-string and blank guild entries", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "owner/repo": ["g1", "", "  ", 42, null, "g2"],
    });
    __resetProjectScopeCacheForTests();

    expect(getProjectDiscordGuilds("owner/repo")).toEqual(["g1", "g2"]);
  });

  it("ignores entries whose value is not an array", () => {
    process.env[ENV_KEY] = JSON.stringify({
      "owner/repo": "not-an-array",
      "owner/other": ["g1"],
    });
    __resetProjectScopeCacheForTests();

    expect(getProjectDiscordGuilds("owner/repo")).toEqual([]);
    expect(getProjectDiscordGuilds("owner/other")).toEqual(["g1"]);
  });

  it("treats malformed JSON as an empty (configured) map", () => {
    process.env[ENV_KEY] = "{not-json";
    __resetProjectScopeCacheForTests();

    expect(getProjectDiscordGuilds("owner/repo")).toEqual([]);
  });

  it("treats a JSON array (wrong shape) as an empty (configured) map", () => {
    process.env[ENV_KEY] = JSON.stringify(["owner/repo"]);
    __resetProjectScopeCacheForTests();

    expect(getProjectDiscordGuilds("owner/repo")).toEqual([]);
  });
});
