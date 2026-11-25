import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { QuotaCollectionError } from "./errors.js";

const MAX_SECRET_BYTES = 4096;
const REFERENCE = /^ref:([A-Za-z0-9_-][A-Za-z0-9_.-]{0,119})$/;

export function createQuotaSecretResolver({ directory, allowedRefs = [] }) {
  const allowed = new Set(allowedRefs);
  return async function resolveCredential(reference) {
    const filename = typeof reference === "string" && REFERENCE.exec(reference)?.[1];
    let folder, file;
    try {
      if (!filename || !allowed.has(reference) || !directory || !path.isAbsolute(directory) ||
          process.platform !== "linux") throw new QuotaCollectionError("configuration");

      const root = path.resolve(directory);
      folder = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      // Pin the verified directory through its descriptor so replacing the
      // configured path during the read cannot redirect the lookup.
      const pinned = `/proc/self/fd/${folder.fd}`;
      if (await realpath(pinned) !== root) throw new QuotaCollectionError("configuration");
      file = await open(path.join(pinned, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SECRET_BYTES) throw new QuotaCollectionError("configuration");
      const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
      const { bytesRead } = await file.read(buffer);
      const credential = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (bytesRead > MAX_SECRET_BYTES || !/^sk-admin-[A-Za-z0-9_-]{8,}$/.test(credential)) {
        throw new QuotaCollectionError("configuration");
      }
      return credential;
    } catch {
      throw new QuotaCollectionError("configuration");
    } finally {
      await file?.close().catch(() => {});
      await folder?.close().catch(() => {});
    }
  };
}
