const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Download ảnh từ URL, lưu vào thư mục tạm để upload lên ChatGPT
 */
const CONTENT_TYPE_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

async function downloadImageToTemp(imageUrl, tempDir = os.tmpdir()) {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });

  const contentType = (response.headers['content-type'] || '').split(';')[0].trim();
  const ext = CONTENT_TYPE_EXT[contentType] || getExtFromUrl(imageUrl) || 'jpg';

  const tempFile = path.join(tempDir, `upload_${Date.now()}.${ext}`);
  fs.writeFileSync(tempFile, Buffer.from(response.data));

  return tempFile;
}

/**
 * Lưu ảnh output (buffer hoặc URL) theo tên mẫu
 */
async function saveOutputImage(source, outputDir, sampleName) {
  fs.mkdirSync(outputDir, { recursive: true });

  const safeName = sanitizeFilename(sampleName);
  const outputPath = path.join(outputDir, `${safeName}.png`);

  if (Buffer.isBuffer(source)) {
    fs.writeFileSync(outputPath, source);
  } else if (typeof source === 'string' && source.startsWith('http')) {
    const response = await axios.get(source, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(outputPath, Buffer.from(response.data));
  } else {
    throw new Error('saveOutputImage: source phải là Buffer hoặc URL string');
  }

  return outputPath;
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
}

function getExtFromUrl(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\.(\w+)$/);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = { downloadImageToTemp, saveOutputImage, sanitizeFilename };
