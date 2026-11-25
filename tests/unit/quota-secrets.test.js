import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuotaSecretResolver } from "../../src/lib/quota/secrets.js";

let temp, root;
const inventedKey = "sk-admin-fixture-only";
const replacement = "sk-admin-fixture-rotated";
const allowedRefs = ["ref:fixture", "ref:missing", "ref:outside-link", "ref:../outside"];

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "quota-secrets-"));
  root = path.join(temp, "trusted");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, "fixture"), `${inventedKey}\n`, { mode: 0o400 });
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("quota file secret resolver", () => {
  it("resolves an allowed regular file and sees an atomic rotation at the next read", async () => {
    const resolve = createQuotaSecretResolver({ directory: root, allowedRefs });
    expect(await resolve("ref:fixture")).toBe(inventedKey);
    await fs.writeFile(path.join(root, "temporary"), replacement, { mode: 0o400 });
    await fs.rename(path.join(root, "temporary"), path.join(root, "fixture"));
    expect(await resolve("ref:fixture")).toBe(replacement);
  });

  it("denies missing, unauthorized and path traversal references, including allowlisted traversal", async () => {
    const resolve = createQuotaSecretResolver({ directory: root, allowedRefs });
    await fs.writeFile(path.join(root, "other"), inventedKey);
    for (const ref of ["ref:missing", "ref:other", "ref:../outside", "ref:%2e%2e%2foutside", "/tmp/fixture"]) {
      await expect(resolve(ref)).rejects.toMatchObject({ code: "configuration" });
    }
  });

  it("denies symlinks at the leaf, the root and an intermediate path component", async () => {
    await fs.writeFile(path.join(temp, "outside"), inventedKey);
    await fs.symlink(path.join(temp, "outside"), path.join(root, "outside-link"));
    const alias = path.join(temp, "root-alias");
    await fs.symlink(root, alias);
    const parentAlias = path.join(temp, "parent-alias");
    await fs.symlink(temp, parentAlias);
    const resolve = createQuotaSecretResolver({ directory: root, allowedRefs });
    await expect(resolve("ref:outside-link")).rejects.toMatchObject({ code: "configuration" });
    for (const directory of [alias, path.join(parentAlias, "trusted")]) {
      await expect(createQuotaSecretResolver({ directory, allowedRefs })("ref:fixture"))
        .rejects.toMatchObject({ code: "configuration" });
    }
  });

  it("returns a generic error for an invalid or oversized key and never logs its content", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = "invalid-credential-content";
    try {
      await fs.unlink(path.join(root, "fixture"));
      const resolve = createQuotaSecretResolver({ directory: root, allowedRefs });
      for (const input of [invalid, inventedKey + "a".repeat(5000)]) {
        await fs.writeFile(path.join(root, "fixture"), input, { mode: 0o600 });
        const error = await resolve("ref:fixture").catch(err => err);
        expect(error.code).toBe("configuration");
        expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(input.slice(0, 20));
        expect(error.stack).not.toContain(root);
      }
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
