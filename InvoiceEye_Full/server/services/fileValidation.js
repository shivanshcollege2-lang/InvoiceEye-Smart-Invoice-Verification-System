import path from 'path';

const signatures = {
  '.pdf': buffer => buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')),
  '.png': buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  '.jpeg': buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  '.webp': buffer => buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP',
  '.tif': buffer => buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])),
  '.tiff': buffer => buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
};

export function validateDocumentBuffer(originalName, buffer) {
  const extension = path.extname(originalName || '').toLowerCase();
  if (extension === '.txt') {
    if (!buffer.length || buffer.includes(0)) {
      throw Object.assign(new Error('The text invoice is empty or contains binary data.'), { status: 415 });
    }
    return;
  }

  const hasValidSignature = signatures[extension]?.(buffer);
  if (!hasValidSignature) {
    throw Object.assign(new Error('The file contents do not match the selected invoice file type.'), { status: 415 });
  }
}
