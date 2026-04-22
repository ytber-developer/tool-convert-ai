const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif',
};

class GeminiApiClient {
  constructor(options = {}) {
    this.model = options.model || 'gemini-2.5-flash-image';
    this._ai = null;
    this._lastImageData = null;
  }

  async launch() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY chưa được set trong .env');
    this._ai = new GoogleGenAI({ apiKey });
  }

  async ensureLoggedIn() {
    // Validate API key bằng cách gọi thử
    try {
      await this._ai.models.get({ model: this.model });
    } catch (err) {
      if (err.message?.includes('API key')) {
        throw new Error(`GEMINI_API_KEY không hợp lệ: ${err.message}`);
      }
      // Các lỗi khác (model not found, etc.) bỏ qua — sẽ thấy khi generate
    }
    console.log(`  [Gemini API] Đã kết nối — model: ${this.model}`);
  }

  async newConversation() {
    this._lastImageData = null;
  }

  async sendImageAndPrompt(imagePath, prompt) {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = MIME_MAP[path.extname(imagePath).toLowerCase()] || 'image/jpeg';

    console.log(`  [Gemini API] Gửi request — model: ${this.model}`);

    const response = await this._ai.models.generateContent({
      model: this.model,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Image } },
        ],
      }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    let text = '';
    let imageBase64 = null;
    let imageMime = 'image/png';

    for (const part of (response.candidates?.[0]?.content?.parts || [])) {
      if (part.text) text += part.text;
      if (part.inlineData) {
        imageBase64 = part.inlineData.data;
        imageMime = part.inlineData.mimeType || 'image/png';
      }
    }

    if (imageBase64) {
      this._lastImageData = { base64: imageBase64, mimeType: imageMime };
      console.log('  [Gemini API] Nhận được ảnh output');
    } else {
      console.log('  [Gemini API] Không có ảnh trong response');
    }

    return { imageUrl: null, text };
  }

  async downloadOutputImage(outputDir, sampleName) {
    const { sanitizeFilename } = require('./downloader');
    if (!this._lastImageData) {
      console.log('  [Gemini API] Không có ảnh để lưu');
      return null;
    }

    const safeName = sanitizeFilename(sampleName);
    const savePath = path.resolve(outputDir, `${safeName}.png`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(savePath, Buffer.from(this._lastImageData.base64, 'base64'));
    this._lastImageData = null;
    console.log(`  [Gemini API] Đã lưu: ${savePath}`);
    return savePath;
  }

  async saveCookies() {}
  async close() {}
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { GeminiApiClient };
