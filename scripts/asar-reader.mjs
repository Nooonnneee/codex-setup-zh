import { constants as bufferConstants } from "node:buffer";
import fs from "node:fs";

function readExactly(handle, size, position) {
  const bytes = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(
      handle,
      bytes,
      read,
      size - read,
      position + read,
    );
    if (count === 0) throw new Error("Truncated app.asar entry");
    read += count;
  }
  return bytes;
}

function* packedEntries(node, prefix = "") {
  if (!node || typeof node !== "object") return;
  if (node.files && typeof node.files === "object") {
    for (const [name, child] of Object.entries(node.files)) {
      yield* packedEntries(child, prefix ? `${prefix}/${name}` : name);
    }
  } else if (!node.unpacked && "offset" in node && "size" in node) {
    yield [prefix, node];
  }
}

/**
 * Read only selected packed files. Status checks must not decode an entire
 * app.asar: recent releases exceed Node's maximum string length.
 * The iterator owns its file handle, including when a caller returns early.
 */
export function* readAsarEntries(asarPath, select) {
  const handle = fs.openSync(asarPath, "r");
  try {
    const fileSize = fs.fstatSync(handle).size;
    if (fileSize < 16) throw new Error("Unsupported app.asar header");
    const prefix = readExactly(handle, 8, 0);
    const headerSize = prefix.readUInt32LE(4);
    if (
      prefix.readUInt32LE(0) !== 4 ||
      headerSize < 8 ||
      headerSize > bufferConstants.MAX_STRING_LENGTH ||
      headerSize > fileSize - 8
    ) {
      throw new Error("Unsupported app.asar size pickle");
    }
    const pickle = readExactly(handle, headerSize, 8);
    const payloadSize = pickle.readUInt32LE(0);
    const stringSize = pickle.readInt32LE(4);
    const expectedPayloadSize = Math.ceil((4 + stringSize) / 4) * 4;
    if (
      stringSize < 0 ||
      stringSize > headerSize - 8 ||
      payloadSize !== expectedPayloadSize ||
      headerSize !== 4 + payloadSize
    ) {
      throw new Error("Unsupported app.asar header pickle");
    }
    const header = JSON.parse(
      pickle.subarray(8, 8 + stringSize).toString("utf8"),
    );
    const contentOffset = 8 + headerSize;
    for (const [filePath, entry] of packedEntries(header)) {
      if (!select(filePath)) continue;
      const offset = Number(entry.offset);
      const size = entry.size;
      if (
        !/^(0|[1-9]\d*)$/.test(String(entry.offset)) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > bufferConstants.MAX_STRING_LENGTH ||
        offset > fileSize - contentOffset ||
        size > fileSize - contentOffset - offset
      ) {
        throw new Error(`Invalid app.asar entry: ${filePath}`);
      }
      yield {
        filePath,
        content: readExactly(handle, size, contentOffset + offset),
      };
    }
  } finally {
    fs.closeSync(handle);
  }
}
