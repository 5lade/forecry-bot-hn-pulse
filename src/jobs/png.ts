import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Encode raw RGBA pixel data (row-major, 4 bytes per pixel) as a PNG buffer.
 * Pure-Node implementation backed by zlib; no native deps.
 */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodePng: rgba length ${rgba.length} != ${width * height * 4}`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: truecolor + alpha
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter type "None"
    const src = Buffer.from(
      rgba.buffer,
      rgba.byteOffset + y * stride,
      stride,
    );
    src.copy(filtered, y * (stride + 1) + 1);
  }
  const idat = deflateSync(filtered);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface DecodedPngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

/**
 * Minimal PNG header decoder used by tests to verify that the produced bytes
 * are a valid PNG. Only inspects the signature + IHDR chunk; does not decode
 * pixel data.
 */
export function decodePngHeader(buf: Buffer): DecodedPngHeader {
  if (buf.length < 8 + 8 + 13 + 4) {
    throw new Error("decodePngHeader: buffer too small");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new Error("decodePngHeader: bad PNG signature");
    }
  }
  const ihdrType = buf.subarray(12, 16).toString("ascii");
  if (ihdrType !== "IHDR") {
    throw new Error(`decodePngHeader: expected IHDR, got ${ihdrType}`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25),
  };
}
