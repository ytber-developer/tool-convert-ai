const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CHATGPT_URL = 'https://chatgpt.com/';
const COOKIES_FILE = path.resolve('./cookies/session.json');

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
  // Cookie-Editor dùng expirationDate, Puppeteer dùng expires
  const exp = c.expirationDate || c.expires;
  if (exp && exp !== -1) cookie.expires = exp;
  // Chuẩn hóa sameSite
  if (c.sameSite && c.sameSite.toLowerCase() !== 'unspecified') {
    cookie.sameSite = SAME_SITE_MAP[c.sameSite.toLowerCase()] || c.sameSite;
  }
  return cookie;
}

class ChatGPTAutomator {
  constructor(options = {}) {
    this.headless = options.headless ?? false;
    this.browser = null;
    this.page = null;
    this._ownsBrowser = false;
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

    // Giả lập user agent thật để tránh bot detection
    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Load cookies nếu đã có session
    if (fs.existsSync(COOKIES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      const cookies = raw.map(parseCookie);
      await this.page.setCookie(...cookies);
      console.log('  [Session] Đã load cookies từ file');
    }
  }

  async saveCookies() {
    const cookies = await this.page.cookies();
    fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log('  [Session] Đã lưu cookies');
  }

  async ensureLoggedIn() {
    await this.page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Kiểm tra đã login chưa
    const isLoggedIn = await this.page.evaluate(() => {
      return !document.querySelector('[data-testid="login-button"]') &&
             !document.querySelector('button[class*="login"]');
    });

    if (!isLoggedIn) {
      console.log('\n  [Auth] Chưa đăng nhập. Vui lòng đăng nhập thủ công trong cửa sổ browser.');
      console.log('  [Auth] Sau khi đăng nhập xong, nhấn Enter để tiếp tục...');

      await new Promise(resolve => {
        process.stdin.once('data', resolve);
      });

      await this.saveCookies();
    }

    // Đợi trang load xong
    await this._waitForChatReady();
    console.log('  [Auth] Đã đăng nhập thành công');
  }

  async newConversation() {
    // Mở conversation mới để tránh context cũ ảnh hưởng
    await this.page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await this._waitForChatReady();
    await this._sleep(1500);
  }

  /**
   * Gửi ảnh + prompt, đợi response, trả về URL ảnh output (nếu có) hoặc text
   */
  async sendImageAndPrompt(imagePath, prompt) {
    console.log('  [Step] Chờ chat sẵn sàng...');
    await this._waitForChatReady();
    await this._sleep(1000);

    console.log('  [Step] Bắt đầu upload ảnh...');
    await this._uploadImage(imagePath);
    await this._sleep(2000);

    console.log('  [Step] Nhập prompt...');
    await this._typePrompt(prompt);
    await this._sleep(1000);

    console.log('  [Step] Gửi tin nhắn...');
    await this._submitMessage();
    await this._sleep(1000);

    console.log('  [Step] Đang chờ ChatGPT phản hồi...');
    const result = await this._waitForResponse();

    console.log(`  [Step] Response nhận được — imageUrl: ${result.imageUrl ? 'CÓ' : 'KHÔNG'}, text length: ${result.text?.length}`);
    return result;
  }

  async _uploadImage(imagePath) {
    // Fallback nhanh: nếu có input[type="file"] trực tiếp thì dùng luôn
    const directInput = await this.page.$('input[type="file"]');
    if (directInput) {
      console.log('  [Upload 1/1] Tìm thấy input file trực tiếp, upload...');
      await directInput.uploadFile(imagePath);
      await this._sleep(3000);
      console.log('  [Upload] Xong (direct input)');
      return;
    }

    // Bước 1: tìm và click nút attach
    console.log('  [Upload 1/3] Tìm nút attach...');
    const attachSelectors = [
      'button[aria-label*="Attach"]',
      'button[aria-label*="attach"]',
      'button[aria-label*="Add photos"]',
      '[data-testid="attach-button"]',
      'button[aria-label*="file"]',
    ];

    let attachBtn = null;
    for (const sel of attachSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          attachBtn = el;
          console.log(`  [Upload 1/3] Tìm thấy attach button với selector: ${sel}`);
          break;
        }
      } catch (_) {}
    }

    if (!attachBtn) {
      // Dump tất cả buttons để debug
      const btns = await this.page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => ({
          aria: b.getAttribute('aria-label'),
          text: b.innerText?.substring(0, 30),
          testid: b.getAttribute('data-testid'),
        }))
      );
      console.log('  [Upload] Không tìm thấy attach. Danh sách buttons:', JSON.stringify(btns));
      throw new Error('Không tìm thấy nút attach trong ChatGPT');
    }

    await attachBtn.click();
    await this._sleep(1000);

    // Bước 2: click "Add photos & files" trong menu
    console.log('  [Upload 2/3] Tìm menu item "Add photos & files"...');
    const menuItems = await this.page.evaluate(() =>
      [...document.querySelectorAll('div[role="menuitem"]')].map(el => el.textContent.trim())
    );
    console.log('  [Upload 2/3] Menu items hiện tại:', menuItems);

    const menuItem = await this.page.evaluateHandle(() => {
      for (const item of document.querySelectorAll('div[role="menuitem"]')) {
        if (item.textContent.includes('Add photos') || item.textContent.includes('photos & files')) {
          return item;
        }
      }
      return null;
    });

    const el = menuItem.asElement();
    if (el) {
      await el.click();
      console.log('  [Upload 2/3] Đã click "Add photos & files"');
      await this._sleep(800);
    } else {
      console.log('  [Upload 2/3] KHÔNG tìm thấy "Add photos & files" trong menu, thử tiếp...');
    }

    // Bước 3: file chooser
    console.log('  [Upload 3/3] Chờ file chooser...');
    const [fileChooser] = await Promise.all([
      this.page.waitForFileChooser({ timeout: 8000 }),
    ]);
    await fileChooser.accept([imagePath]);
    console.log(`  [Upload 3/3] Đã chọn file: ${path.basename(imagePath)}`);

    await this._sleep(3000);
    console.log('  [Upload] Hoàn tất upload');
  }

  async _typePrompt(text) {
    const promptSelectors = [
      '#prompt-textarea',
      'div[contenteditable="true"][data-id="prompt-textarea"]',
      'textarea[placeholder*="Message"]',
      'div[contenteditable="true"]',
    ];

    let promptBox = null;
    for (const sel of promptSelectors) {
      try {
        promptBox = await this.page.$(sel);
        if (promptBox) break;
      } catch (_) {}
    }

    if (!promptBox) throw new Error('Không tìm thấy ô nhập prompt');

    await promptBox.click();
    await this._sleep(200);

    // Xóa nội dung cũ nếu có
    await this.page.keyboard.down('Meta');
    await this.page.keyboard.press('a');
    await this.page.keyboard.up('Meta');
    await this.page.keyboard.press('Backspace');

    // Nhập text
    await promptBox.type(text, { delay: 20 });
    console.log(`  [Prompt] Đã nhập: "${text.substring(0, 60)}..."`);
  }

  async _submitMessage() {
    const sendSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
      'button:has(svg[data-icon="send"])',
    ];

    let sendBtn = null;
    for (const sel of sendSelectors) {
      try {
        sendBtn = await this.page.$(sel);
        if (sendBtn) break;
      } catch (_) {}
    }

    if (sendBtn) {
      await sendBtn.click();
    } else {
      await this.page.keyboard.press('Enter');
    }

    console.log('  [Send] Đã gửi tin nhắn');
  }

  /**
   * Đợi ChatGPT respond xong, trả về { imageUrl, text }
   */
  async _waitForResponse() {
    const STOP_BTN = 'button[aria-label="Stop generating"], button[data-testid="stop-button"]';

    // Bước 1: chờ stop button XUẤT HIỆN (ChatGPT bắt đầu generate)
    console.log('  [Wait 1/2] Chờ ChatGPT bắt đầu generate...');
    const appeared = await this._waitForCondition(
      () => this.page.evaluate(sel => !!document.querySelector(sel), STOP_BTN),
      30000 // 30s timeout để xuất hiện
    );
    if (!appeared) {
      console.log('  [Wait 1/2] Stop button không xuất hiện — ChatGPT có thể đã xử lý rất nhanh, tiếp tục...');
    } else {
      console.log('  [Wait 1/2] ChatGPT đang generate...');
    }

    // Bước 2: chờ stop button BIẾN MẤT (ChatGPT xong)
    console.log('  [Wait 2/2] Chờ ChatGPT hoàn tất...');
    const timeout = 300000; // 5 phút (generate ảnh lâu)
    const start = Date.now();
    let tick = 0;

    while (Date.now() - start < timeout) {
      const isLoading = await this.page.evaluate(sel => !!document.querySelector(sel), STOP_BTN);
      tick++;
      if (tick % 5 === 0) {
        console.log(`  [Wait 2/2] Vẫn đang generate... (${Math.round((Date.now() - start) / 1000)}s)`);
      }

      if (!isLoading) {
        await this._sleep(3000); // đợi thêm để ảnh render xong hoàn toàn
        console.log('  [Wait 2/2] Hoàn tất!');

        const outputImageUrl = await this._extractOutputImage();
        const responseText = await this._extractResponseText();

        console.log(`  [Response] imageUrl = ${outputImageUrl || 'null'}`);
        console.log(`  [Response] text = "${(responseText || '').substring(0, 100)}"`);

        return { imageUrl: outputImageUrl, text: responseText };
      }

      await this._sleep(2000);
    }

    throw new Error('Timeout: ChatGPT không phản hồi trong 5 phút');
  }

  async _waitForCondition(fn, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await fn()) return true;
      } catch (_) {}
      await this._sleep(500);
    }
    return false;
  }

  async _extractOutputImage() {
    return await this.page.evaluate(() => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-message-role="assistant"]',
        '.agent-turn',
      ];
      let lastMsg = null;
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) { lastMsg = els[els.length - 1]; break; }
      }
      if (!lastMsg) return null;

      const imgs = lastMsg.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.src || img.getAttribute('src');
        if (src && (src.includes('oaidalleapiprodscus') || src.includes('blob:') || src.includes('oaiusercontent'))) {
          return src;
        }
      }
      if (imgs.length > 0) return imgs[0].src;
      return null;
    });
  }

  async _extractResponseText() {
    return await this.page.evaluate(() => {
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (!messages.length) return '';
      const lastMsg = messages[messages.length - 1];
      return lastMsg.innerText || lastMsg.textContent || '';
    });
  }

  /**
   * Download ảnh output bằng cách click nút download trong ChatGPT (nếu có)
   * Trả về đường dẫn file đã tải hoặc null
   */
  async downloadOutputImage(outputDir, sampleName) {
    const { sanitizeFilename } = require('./downloader');
    const safeName = sanitizeFilename(sampleName);
    const savePath = path.resolve(outputDir, `${safeName}.png`);

    const client = await this.page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(outputDir),
    });

    // Bước 1: chờ overlay actions xuất hiện — tối đa 15 phút (chỉ chờ 1 lần)
    const OVERLAY_SEL = '[data-testid="image-gen-overlay-right-actions"]';
    console.log('  [Download] Cho anh generate xong (toi da 15 phut)...');
    const appeared = await this._waitForCondition(
      () => this.page.evaluate(sel => !!document.querySelector(sel), OVERLAY_SEL),
      900000
    );
    if (!appeared) {
      console.log('  [Download] Timeout 15 phut — ChatGPT khong tra anh');
      return null;
    }
    await this._sleep(800);

    // Lưu URL chat để reload khi retry
    const chatUrl = this.page.url();
    const MAX_RETRY = 3;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      console.log(`  [Download] Thu lan ${attempt}/${MAX_RETRY}...`);

      if (attempt > 1) {
        console.log(`  [Download] Reload chat de retry (lan ${attempt})...`);
        await this.page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await this._sleep(2000);
        const reappeared = await this._waitForCondition(
          () => this.page.evaluate(sel => !!document.querySelector(sel), OVERLAY_SEL),
          30000
        );
        if (!reappeared) {
          console.log(`  [Download] Khong thay overlay sau reload (lan ${attempt})`);
          continue;
        }
        await this._sleep(800);
      }

      try {
        // Đóng modal cũ nếu có
        await this.page.keyboard.press('Escape');
        await this._sleep(500);

        // Hover vào ảnh để overlay hiện
        const imgEl = await this.page.$('img[src*="estuary/content"], img[id^="_r_"]');
        if (imgEl) {
          await imgEl.hover();
          await this._sleep(800);
        }

        // Click "Share this image"
        const shareBtn = await this.page.$('button[aria-label="Share this image"]');
        if (!shareBtn) throw new Error('Khong thay nut Share');
        await shareBtn.click();
        await this._sleep(1500);

        // Chờ nút Download trong modal
        const dlAppeared = await this._waitForCondition(
          () => this.page.evaluate(() => {
            for (const div of document.querySelectorAll('div.text-token-text-primary')) {
              if (div.textContent?.trim() === 'Download') return true;
            }
            return false;
          }),
          10000
        );
        if (!dlAppeared) throw new Error('Modal khong co nut Download');

        const clickedAt = Date.now();
        await this.page.evaluate(() => {
          for (const div of document.querySelectorAll('div.text-token-text-primary')) {
            if (div.textContent?.trim() === 'Download') {
              div.closest('button')?.click();
              return;
            }
          }
        });

        // Poll cho đến khi file mới xuất hiện — tối đa 60s
        const found = await this._waitForCondition(() => {
          const files = fs.readdirSync(outputDir)
            .filter(f => !f.endsWith('.txt') && !f.endsWith('.crdownload'))
            .map(f => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtimeMs }))
            .filter(f => f.time >= clickedAt - 1000);
          return files.length > 0;
        }, 60000);

        if (!found) throw new Error('Khong thay file moi sau 60s');

        const files = fs.readdirSync(outputDir)
          .filter(f => !f.endsWith('.txt') && !f.endsWith('.crdownload'))
          .map(f => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtimeMs }))
          .filter(f => f.time >= clickedAt - 1000)
          .sort((a, b) => b.time - a.time);

        const latest = path.join(outputDir, files[0].name);
        if (latest !== savePath) fs.renameSync(latest, savePath);
        console.log(`  [Download] Da luu: ${savePath}`);
        return savePath;

      } catch (err) {
        console.log(`  [Download] Lan ${attempt} that bai: ${err.message}`);
      }
    }

    console.log('  [Download] Het retry — khong download duoc anh');
    return null;
  }

  async _waitForChatReady() {
    await this.page.waitForSelector(
      '#prompt-textarea, div[contenteditable="true"], textarea[placeholder*="Message"]',
      { timeout: 30000 }
    );
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async close() {
    if (this.browser && this._ownsBrowser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = { ChatGPTAutomator };
