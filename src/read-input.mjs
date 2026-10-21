import { open } from "node:fs/promises";

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;

// File-handle reads prevent both preallocation and time-of-check/time-of-use growth
// from bypassing the byte limit. Decoding happens only after the limit is enforced.
export async function readBoundedText(path, maxBytes = MAX_INPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_INPUT_BYTES) {
    throw new Error("Invalid byte limit");
  }
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Not a regular file");
    if (stats.size > maxBytes) throw new Error("File too large");
    const blocks = [];
    const scratch = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(scratch, 0, Math.min(scratch.length, maxBytes + 1 - total), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("File too large");
      blocks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    return Buffer.concat(blocks, total).toString("utf8");
  } finally {
    await file.close();
  }
}
