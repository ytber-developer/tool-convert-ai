const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const GEMINI_URL = 'https://gemini.google.com/';
const COOKIES_FILE = path.resolve('./cookies/gemini-session.json');

// Chuẩn hóa cookie từ Cookie-Editor hoặc Puppeteer saveCookies
function parseCookie(c) {
  const SAME_SITE_MAP = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
  const cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
  };
  const exp = c.expirationDate || c.expires;
  if (exp && exp !== -1) cookie.expires = exp;
  // bỏ qua "unspecified" — Puppeteer chỉ chấp nhận Strict/Lax/None
  if (c.sameSite && c.sameSite.toLowerCase() !== 'unspecified') {
    cookie.sameSite = SAME_SITE_MAP[c.sameSite.toLowerCase()] || c.sameSite;
  }
  return cookie;
}

class GeminiAutomator {
  constructor(options = {}) {
    this.headless = options.headless ?? false;
    this.model = options.model || 'Pro'; // 'Fast' | 'Thinking' | 'Pro'
    this.browser = null;
    this.page = null;
    this._ownsBrowser = false;
    this._pendingImageBase64 = null;
  }

  async launch() {
    this.browser = await puppeteer.launch({
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--start-maximized',
      ],
      defaultViewport: null,
    });
    this._ownsBrowser = true;
    await this._initPage();
  }

  // Dùng chung browser đã có (chế độ parallel)
  async launchWithBrowser(browser) {
    this.browser = browser;
    this._ownsBrowser = false;
    await this._initPage();
  }

  async _initPage() {
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    if (fs.existsSync(COOKIES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      const cookies = raw.map(parseCookie);
      await this.page.setCookie(...cookies);
      console.log('  [Gemini Session] Đã load cookies');
    }
  }

  async saveCookies() {
    const cookies = await this.page.cookies();
    fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log('  [Gemini Session] Đã lưu cookies');
  }

  async ensureLoggedIn() {
    await this.page.goto(GEMINI_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // race: nếu rich-textarea xuất hiện → đã login; nếu timeout → chưa login
    const isLoggedIn = await this.page.waitForSelector('rich-textarea', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!isLoggedIn) {
      console.log('\n  [Gemini Auth] Chưa đăng nhập. Vui lòng đăng nhập Google trong cửa sổ browser.');
      console.log('  [Gemini Auth] Sau khi đăng nhập xong, nhấn Enter để tiếp tục...');
      await new Promise(resolve => process.stdin.once('data', resolve));
      await this.page.waitForSelector('rich-textarea', { timeout: 60000 });
      await this.saveCookies();
    }

    console.log('  [Gemini Auth] Đã đăng nhập thành công');
  }

  async newConversation() {
    await this.page.goto(GEMINI_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await this._waitForChatReady();
    await this._sleep(1000);
    await this._selectModel(this.model);
    await this._sleep(500);
  }

  async _selectModel(modelName) {
    if (!modelName) return;
    try {
      // Click nút selector model (hiện text "Fast", "Pro", "Thinking"...)
      const selectorBtn = await this.page.$('button[data-test-id="model-selector-button"], .model-selector button, [aria-label*="model" i]');
      if (!selectorBtn) {
        // Tìm theo text trong nút ở vùng input
        const btn = await this.page.evaluateHandle(() => {
          const buttons = [...document.querySelectorAll('button')];
          return buttons.find(b => ['Fast', 'Thinking', 'Pro'].includes(b.textContent?.trim()));
        });
        if (!btn || !(await btn.asElement())) {
          console.log(`  [Gemini Model] Không tìm thấy nút model selector`);
          return;
        }
        await btn.click();
      } else {
        await selectorBtn.click();
      }
      await this._sleep(600);

      // Chọn option đúng trong dropdown
      const chosen = await this.page.evaluateHandle((name) => {
        const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], li')];
        return items.find(el => el.textContent?.trim().toLowerCase().startsWith(name.toLowerCase()));
      }, modelName);

      if (chosen && (await chosen.asElement())) {
        await chosen.click();
        console.log(`  [Gemini Model] Đã chọn model: ${modelName}`);
      } else {
        console.log(`  [Gemini Model] Không tìm thấy option "${modelName}" trong dropdown`);
        await this.page.keyboard.press('Escape');
      }
    } catch (err) {
      console.log(`  [Gemini Model] Lỗi chọn model: ${err.message}`);
    }
  }

  async sendImageAndPrompt(imagePath, prompt) {
    console.log('  [Gemini Step] Chờ chat sẵn sàng...');
    await this._waitForChatReady();
    await this._sleep(1000);

    console.log('  [Gemini Step] Upload ảnh...');
    await this._uploadImage(imagePath);
    await this._sleep(2000);

    console.log('  [Gemini Step] Nhập prompt...');
    await this._typePrompt(prompt);
    await this._sleep(800);

    console.log('  [Gemini Step] Gửi...');
    await this._submitMessage();
    await this._sleep(1000);

    console.log('  [Gemini Step] Chờ phản hồi...');
    const result = await this._waitForResponse();
    console.log(`  [Gemini Step] Xong — imageUrl: ${result.imageUrl ? 'CÓ' : 'KHÔNG'}`);
    return result;
  }

  async _uploadImage(imagePath) {
    // Bước 1: click nút "+" để mở menu
    console.log('  [Gemini Upload 1/3] Click menu button...');
    const plusBtn = await this.page.$('button[aria-label="Open upload file menu"], button[aria-controls="upload-file-menu"]');
    if (!plusBtn) throw new Error('Gemini: Không tìm thấy nút "Open upload file menu"');
    await plusBtn.click();
    await this._sleep(800);

    // Bước 2: click "Upload files"
    console.log('  [Gemini Upload 2/3] Click "Upload files"...');
    const uploadBtn = await this.page.waitForSelector(
      '[data-test-id="local-images-files-uploader-button"]',
      { timeout: 5000 }
    );
    if (!uploadBtn) throw new Error('Gemini: Không tìm thấy nút "Upload files"');

    const [fileChooser] = await Promise.all([
      this.page.waitForFileChooser({ timeout: 8000 }),
      uploadBtn.click(),
    ]);

    // Bước 3: chọn file
    await fileChooser.accept([imagePath]);
    console.log(`  [Gemini Upload 3/3] Chon file: ${path.basename(imagePath)}`);
    await this._sleep(3000);
  }

  async _typePrompt(text) {
    const selectors = [
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor',
      'textarea[placeholder*="Enter"]',
      'div[contenteditable="true"]',
    ];

    let promptBox = null;
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el) { promptBox = el; break; }
      } catch (_) {}
    }

    if (!promptBox) throw new Error('Không tìm thấy ô nhập prompt trong Gemini');

    await promptBox.click();
    await this._sleep(200);
    await this.page.keyboard.down('Meta');
    await this.page.keyboard.press('a');
    await this.page.keyboard.up('Meta');
    await this.page.keyboard.press('Backspace');
    await promptBox.type(text, { delay: 20 });
    console.log(`  [Gemini Prompt] "${text.substring(0, 60)}..."`);
  }

  async _submitMessage() {
    const selectors = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button.send-button',
      'mat-icon[data-mat-icon-name="send"]',
    ];

    let sendBtn = null;
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el) { sendBtn = el; break; }
      } catch (_) {}
    }

    if (sendBtn) {
      await sendBtn.click();
    } else {
      await this.page.keyboard.press('Enter');
    }
    console.log('  [Gemini Send] Đã gửi');
  }

  async _waitForResponse() {
    // Chỉ cần đợi Gemini bắt đầu xử lý — phần chờ ảnh do downloadOutputImage lo
    await this._sleep(2000);
    return { imageUrl: null, text: '' };
  }

  async downloadOutputImage(outputDir, sampleName) {
    const { sanitizeFilename } = require('./downloader');
    const safeName = sanitizeFilename(sampleName);
    const savePath = path.resolve(outputDir, `${safeName}.png`);

    const client = await this.page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(outputDir),
    });

    const IMG_SEL = 'button.image-button img.loaded';
    const DL_BTN = '[data-test-id="download-generated-image-button"]';
    const SNACKBAR = 'div[data-test-id="label"]';

    // Bước 1: chờ img.loaded xuất hiện — tối đa 5 phút
    console.log('  [Gemini 1/4] Cho anh generate xong...');
    const appeared = await this._waitForCondition(
      () => this.page.evaluate(s => !!document.querySelector(s), IMG_SEL),
      300000
    );
    if (!appeared) {
      console.log('  [Gemini] Timeout 5 phut — khong thay anh');
      return null;
    }
    await this._sleep(500);

    // Bước 2: click vào image-button để mở popup overlay
    console.log('  [Gemini 2/4] Click anh de mo overlay...');
    await this.page.evaluate(s => {
      const imgs = document.querySelectorAll(s);
      const last = imgs[imgs.length - 1];
      if (last) {
        const btn = last.closest('button.image-button');
        (btn || last).click();
      }
    }, IMG_SEL);
    await this._sleep(1000);

    // Bước 3: click nút download (đã visible trong overlay, không cần hover)
    console.log('  [Gemini 3/4] Click download...');
    const clicked = await this.page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.click();
      return true;
    }, DL_BTN);
    if (!clicked) {
      console.log('  [Gemini] Khong thay nut download trong overlay');
      return null;
    }

    // Bước 4: chờ snackbar "Downloading full size..." xuất hiện rồi biến mất
    console.log('  [Gemini 4/4] Cho download hoan tat...');
    await this._waitForCondition(
      () => this.page.evaluate(s => {
        const el = document.querySelector(s);
        return el && el.textContent.includes('Downloading');
      }, SNACKBAR),
      10000
    );
    await this._waitForCondition(
      () => this.page.evaluate(s => !document.querySelector(s), SNACKBAR),
      60000
    );
    await this._sleep(1000);

    // Lấy file mới nhất trong outputDir
    fs.mkdirSync(outputDir, { recursive: true });
    const files = fs.readdirSync(outputDir)
      .filter(f => !f.endsWith('.txt') && !f.endsWith('.crdownload'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(outputDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      const latest = path.join(outputDir, files[0].name);
      if (latest !== savePath) fs.renameSync(latest, savePath);
      console.log(`  [Gemini] Da luu: ${savePath}`);
      return savePath;
    }

    return null;
  }

  async _waitForChatReady() {
    await this.page.waitForSelector(
      'rich-textarea, div.ql-editor, textarea, div[contenteditable="true"]',
      { timeout: 30000 }
    );
  }

  async _waitForCondition(fn, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await fn()) return true; } catch (_) {}
      await this._sleep(500);
    }
    return false;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async close() {
    if (this.browser && this._ownsBrowser) { await this.browser.close(); this.browser = null; }
  }
}

module.exports = { GeminiAutomator };
