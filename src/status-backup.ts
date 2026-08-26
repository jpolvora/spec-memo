import * as zlib from 'node:zlib';

/**
 * Creates a standard PKZip archive containing a single entry named `vault-backup.json`.
 */
export function packVaultZip(jsonPayload: string, entryName = 'vault-backup.json'): Buffer {
  const uncompressedBuffer = Buffer.from(jsonPayload, 'utf8');
  const compressedData = zlib.deflateRawSync(uncompressedBuffer);
  const crc = zlib.crc32(uncompressedBuffer);

  const filenameBuffer = Buffer.from(entryName, 'utf8');
  const filenameLength = filenameBuffer.length;

  // DOS time and date (2026-08-26 12:00:00)
  const dosTime = (12 << 11) | (0 << 5) | (0 >> 1);
  const dosDate = ((2026 - 1980) << 9) | (8 << 5) | 26;

  // 1. Local file header (30 bytes + filename)
  const localHeader = Buffer.alloc(30 + filenameLength);
  localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
  localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
  localHeader.writeUInt16LE(0x0800, 6);     // General purpose bit flag (UTF-8)
  localHeader.writeUInt16LE(8, 8);          // Compression method (Deflate)
  localHeader.writeUInt16LE(dosTime, 10);   // Last mod file time
  localHeader.writeUInt16LE(dosDate, 12);   // Last mod file date
  localHeader.writeUInt32LE(crc, 14);       // CRC-32
  localHeader.writeUInt32LE(compressedData.length, 18);   // Compressed size
  localHeader.writeUInt32LE(uncompressedBuffer.length, 22); // Uncompressed size
  localHeader.writeUInt16LE(filenameLength, 26);          // Filename length
  localHeader.writeUInt16LE(0, 28);                       // Extra field length
  filenameBuffer.copy(localHeader, 30);

  // 2. Central directory header (46 bytes + filename)
  const cdHeader = Buffer.alloc(46 + filenameLength);
  cdHeader.writeUInt32LE(0x02014b50, 0);   // Central directory signature
  cdHeader.writeUInt16LE(20, 4);           // Version made by
  cdHeader.writeUInt16LE(20, 6);           // Version needed to extract (2.0)
  cdHeader.writeUInt16LE(0x0800, 8);       // General purpose bit flag (UTF-8)
  cdHeader.writeUInt16LE(8, 10);           // Compression method (Deflate)
  cdHeader.writeUInt16LE(dosTime, 12);     // Last mod file time
  cdHeader.writeUInt16LE(dosDate, 14);     // Last mod file date
  cdHeader.writeUInt32LE(crc, 16);         // CRC-32
  cdHeader.writeUInt32LE(compressedData.length, 20);      // Compressed size
  cdHeader.writeUInt32LE(uncompressedBuffer.length, 24);    // Uncompressed size
  cdHeader.writeUInt16LE(filenameLength, 28);             // Filename length
  cdHeader.writeUInt16LE(0, 30);                          // Extra field length
  cdHeader.writeUInt16LE(0, 32);                          // Comment length
  cdHeader.writeUInt16LE(0, 34);                          // Disk number start
  cdHeader.writeUInt16LE(0, 36);                          // Internal file attributes
  cdHeader.writeUInt32LE(0x81a40000, 38);                 // External file attributes (0644 mode)
  cdHeader.writeUInt32LE(0, 42);                          // Relative offset of local header
  filenameBuffer.copy(cdHeader, 46);

  const cdOffset = localHeader.length + compressedData.length;
  const cdSize = cdHeader.length;

  // 3. End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk where central directory starts
  eocd.writeUInt16LE(1, 8);          // Number of central directory records on this disk
  eocd.writeUInt16LE(1, 10);         // Total number of central directory records
  eocd.writeUInt32LE(cdSize, 12);    // Size of central directory
  eocd.writeUInt32LE(cdOffset, 16);  // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);         // Comment length

  return Buffer.concat([localHeader, compressedData, cdHeader, eocd]);
}

interface ZipEntry {
  filename: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Extracts the backup JSON string from a zip archive buffer.
 * Extracts `vault-backup.json` (or the single `.json` entry if exactly one exists).
 */
export function unpackVaultZip(zipBuffer: Buffer): string {
  if (!zipBuffer || zipBuffer.length < 22) {
    throw new Error('Invalid zip archive: Buffer too short.');
  }

  // Check for ZIP magic signature at beginning
  if (
    zipBuffer[0] !== 0x50 ||
    zipBuffer[1] !== 0x4b ||
    zipBuffer[2] !== 0x03 ||
    zipBuffer[3] !== 0x04
  ) {
    throw new Error('Invalid archive format: expected ZIP file.');
  }

  // Locate End of Central Directory record (EOCD)
  let eocdOffset = -1;
  const maxSearch = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= maxSearch; i--) {
    if (
      zipBuffer[i] === 0x50 &&
      zipBuffer[i + 1] === 0x4b &&
      zipBuffer[i + 2] === 0x05 &&
      zipBuffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid zip archive: End of central directory record not found.');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  if (totalEntries === 0) {
    throw new Error('Invalid zip archive: Archive is empty.');
  }

  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > zipBuffer.length) {
    throw new Error('Invalid zip archive: Corrupted central directory offset.');
  }

  const entries: ZipEntry[] = [];
  let curr = cdOffset;

  for (let i = 0; i < totalEntries && curr < cdOffset + cdSize; i++) {
    const sig = zipBuffer.readUInt32LE(curr);
    if (sig !== 0x02014b50) {
      throw new Error('Invalid zip archive: Central directory signature mismatch.');
    }

    const method = zipBuffer.readUInt16LE(curr + 10);
    const crc = zipBuffer.readUInt32LE(curr + 16);
    const compressedSize = zipBuffer.readUInt32LE(curr + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(curr + 24);
    const filenameLength = zipBuffer.readUInt16LE(curr + 28);
    const extraLength = zipBuffer.readUInt16LE(curr + 30);
    const commentLength = zipBuffer.readUInt16LE(curr + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(curr + 42);

    const fnStart = curr + 46;
    const filename = zipBuffer.toString('utf8', fnStart, fnStart + filenameLength);

    entries.push({
      filename,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });

    curr += 46 + filenameLength + extraLength + commentLength;
  }

  // Find candidate entry: prefer 'vault-backup.json', else find sole .json file
  let targetEntry = entries.find(
    (e) => e.filename === 'vault-backup.json' || e.filename.endsWith('/vault-backup.json')
  );

  if (!targetEntry) {
    const jsonEntries = entries.filter((e) => e.filename.toLowerCase().endsWith('.json'));
    if (jsonEntries.length === 1) {
      targetEntry = jsonEntries[0];
    }
  }

  if (!targetEntry) {
    throw new Error(
      'Archive does not contain vault-backup.json or a single JSON backup entry.'
    );
  }

  // Read data from local file header
  const localOffset = targetEntry.localHeaderOffset;
  if (localOffset + 30 > zipBuffer.length) {
    throw new Error('Invalid zip archive: Local header offset out of bounds.');
  }

  const localSig = zipBuffer.readUInt32LE(localOffset);
  if (localSig !== 0x04034b50) {
    throw new Error('Invalid zip archive: Local file header signature mismatch.');
  }

  const localFnLen = zipBuffer.readUInt16LE(localOffset + 26);
  const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localFnLen + localExtraLen;
  const dataEnd = dataStart + targetEntry.compressedSize;

  if (dataEnd > zipBuffer.length) {
    throw new Error('Invalid zip archive: Compressed data out of bounds.');
  }

  const rawCompressed = zipBuffer.subarray(dataStart, dataEnd);
  let uncompressed: Buffer;

  if (targetEntry.method === 0) {
    // Stored (no compression)
    uncompressed = Buffer.from(rawCompressed);
  } else if (targetEntry.method === 8) {
    // Deflate
    try {
      uncompressed = zlib.inflateRawSync(rawCompressed);
    } catch {
      throw new Error('Failed to decompress zip entry.');
    }
  } else {
    throw new Error(`Unsupported zip compression method: ${targetEntry.method}`);
  }

  const computedCrc = zlib.crc32(uncompressed);
  if (computedCrc !== targetEntry.crc) {
    throw new Error('Zip CRC-32 checksum mismatch.');
  }

  return uncompressed.toString('utf8');
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, { filename?: string; contentType?: string; data: Buffer }>;
}

/**
 * Parses multipart/form-data body buffer without external dependencies.
 */
export function parseMultipartFormData(body: Buffer, boundary: string): ParsedMultipart {
  const result: ParsedMultipart = {
    fields: {},
    files: {}
  };

  const cleanBoundary = boundary.trim().replace(/^"/, '').replace(/"$/, '');
  const delimiter = Buffer.from(`--${cleanBoundary}`);
  const crlf = Buffer.from('\r\n');
  const doubleCrlf = Buffer.from('\r\n\r\n');

  let pos = 0;

  while (pos < body.length) {
    const boundaryIdx = body.indexOf(delimiter, pos);
    if (boundaryIdx === -1) break;

    const startOfPart = boundaryIdx + delimiter.length;
    // Check if end of multipart (starts with --)
    if (
      startOfPart + 2 <= body.length &&
      body[startOfPart] === 0x2d && // '-'
      body[startOfPart + 1] === 0x2d
    ) {
      break;
    }

    // Skip past CRLF after boundary
    let headerStart = startOfPart;
    if (
      headerStart + 2 <= body.length &&
      body[headerStart] === 0x0d &&
      body[headerStart + 1] === 0x0a
    ) {
      headerStart += 2;
    }

    const headerEnd = body.indexOf(doubleCrlf, headerStart);
    if (headerEnd === -1) break;

    const headerText = body.toString('utf8', headerStart, headerEnd);
    const bodyStart = headerEnd + 4;

    const nextBoundary = body.indexOf(delimiter, bodyStart);
    if (nextBoundary === -1) break;

    let bodyEnd = nextBoundary;
    // Trim trailing CRLF before boundary if present
    if (
      bodyEnd >= bodyStart + 2 &&
      body[bodyEnd - 2] === 0x0d &&
      body[bodyEnd - 1] === 0x0a
    ) {
      bodyEnd -= 2;
    }

    const partData = body.subarray(bodyStart, bodyEnd);

    // Parse Content-Disposition header
    let fieldName: string | undefined;
    let filename: string | undefined;
    let contentType: string | undefined;

    const headerLines = headerText.split('\r\n');
    for (const line of headerLines) {
      const lower = line.toLowerCase();
      if (lower.startsWith('content-disposition:')) {
        const nameMatch = line.match(/name="([^"]+)"/i) || line.match(/name=([^;]+)/i);
        if (nameMatch) {
          fieldName = nameMatch[1].trim();
        }
        const fnMatch = line.match(/filename="([^"]+)"/i) || line.match(/filename=([^;]+)/i);
        if (fnMatch) {
          filename = fnMatch[1].trim();
        }
      } else if (lower.startsWith('content-type:')) {
        contentType = line.split(':')[1]?.trim();
      }
    }

    if (fieldName) {
      if (filename !== undefined) {
        result.files[fieldName] = {
          filename,
          contentType,
          data: Buffer.from(partData)
        };
      } else {
        result.fields[fieldName] = partData.toString('utf8');
      }
    }

    pos = nextBoundary;
  }

  return result;
}
