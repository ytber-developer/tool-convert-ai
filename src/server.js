require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const { readInputExcel } = require('./excel-reader');
const { ChatGPTAutomator } = require('./chatgpt-automator');
const { GeminiAutomator } = require('./gemini-automator');
const { downloadImageToTemp, saveOutputImage, sanitizeFilename } = require('./downloader');

const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3100;
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || './output');
const DELAY = parseInt(process.env.DELAY_BETWEEN_ROWS || '5000', 10);
const HEADLESS = process.env.HEADLESS === 'true';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

// Upload vào thư mục tạm
const upload = multer({ dest: path.resolve('./tmp_uploads') });

app.use(express.static(path.join(__dirname, '../public')));

// ── SSE clients đang lắng nghe ──────────────────────────────────────────────
let sseClients = [];

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
}

// ── State ────────────────────────────────────────────────────────────────────
let jobState = { running: false, rows: [], results: [], currentFiles: [], runDir: null };

function makeRunDir() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const name = `${now.getFullYear()}_${pad(now.getMonth()+1)}_${pad(now.getDate())}_${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`;
  const dir = path.join(OUTPUT_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Realtime log stream
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  sseClients.push(res);
  // Gửi state hiện tại ngay khi connect
  res.write(`data: ${JSON.stringify({ type: 'state', ...jobState })}\n\n`);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Upload Excel + đọc preview
app.post('/api/upload', upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file' });
    const rows = await readInputExcel(req.file.path);
    fs.unlinkSync(req.file.path);
    // Lưu vào input/data.xlsx để dùng lại
    const destPath = path.resolve('./input/data.xlsx');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    // copy file gốc trước khi xóa
    fs.copyFileSync(req.file.path.replace(/\\/g, '/').split('/').slice(0,-1).join('/') + '/' + req.file.filename,
                    destPath);
    jobState.rows = rows;
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload Excel
app.post('/api/upload-excel', upload.single('excel'), async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    if (!tmpPath) return res.status(400).json({ error: 'Chưa chọn file' });

    // Đọc thẳng từ file temp — tránh bị lock khi file đang mở bằng Excel
    const rows = await readInputExcel(tmpPath);

    // Lưu lại để dùng lần sau (best-effort, không crash nếu file đang bị lock)
    try {
      const destPath = path.resolve('./input/data.xlsx');
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(tmpPath, destPath);
    } catch (_) {}

    jobState.rows = rows;
    jobState.results = [];
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
});

// Bắt đầu xử lý
app.post('/api/start', express.json(), async (req, res) => {
  if (jobState.running) {
    return res.status(409).json({ error: 'Đang có job chạy, vui lòng đợi' });
  }

  const rows = req.body.rows || jobState.rows;
  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: 'Chưa có dữ liệu. Hãy upload file Excel trước.' });
  }

  jobState.running = true;
  jobState.rows = rows;
  jobState.results = rows.map(r => ({ ...r, status: 'pending' }));
  jobState.currentFiles = [];
  jobState.runDir = makeRunDir();

  res.json({ ok: true, total: rows.length });

  // Chạy async
  runJob(rows, jobState.runDir).catch(err => {
    broadcast({ type: 'error', message: err.message });
    jobState.running = false;
  });
});

// Stop job (đóng browser)
app.post('/api/stop', (req, res) => {
  jobState.running = false;
  broadcast({ type: 'stopped' });
  res.json({ ok: true });
});

// ── Cookie management ─────────────────────────────────────────────────────────
const COOKIE_FILES = {
  chatgpt: path.resolve('./cookies/session.json'),
  gemini:  path.resolve('./cookies/gemini-session.json'),
};

app.get('/api/cookies/:type', (req, res) => {
  const file = COOKIE_FILES[req.params.type];
  if (!file) return res.status(404).json({ error: 'Unknown type' });
  if (!fs.existsSync(file)) return res.json({ cookies: '' });
  res.json({ cookies: fs.readFileSync(file, 'utf8') });
});

app.post('/api/cookies/:type', express.json({ limit: '2mb' }), (req, res) => {
  const file = COOKIE_FILES[req.params.type];
  if (!file) return res.status(404).json({ error: 'Unknown type' });
  try {
    const raw = req.body.cookies || '';
    JSON.parse(raw); // validate JSON
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'JSON không hợp lệ: ' + err.message });
  }
});

// Lấy danh sách file output của job hiện tại
app.get('/api/outputs', (req, res) => {
  const runDir = jobState.runDir;
  if (!runDir) return res.json([]);
  const files = jobState.currentFiles
    .filter(name => fs.existsSync(path.join(runDir, name)))
    .map(name => ({
      name,
      size: fs.statSync(path.join(runDir, name)).size,
      url: `/output-files/${path.basename(runDir)}/${name}`,
    }));
  res.json(files);
});

// Serve output files (bao gồm subfolder theo run)
app.use('/output-files', express.static(OUTPUT_DIR));

// Download chỉ files của job hiện tại
app.get('/api/download-zip', (req, res) => {
  const runDir = jobState.runDir;
  const files = runDir
    ? jobState.currentFiles.filter(name => fs.existsSync(path.join(runDir, name)))
    : [];

  if (files.length === 0) {
    return res.status(404).json({ error: 'Chưa có file nào trong lần chạy này' });
  }

  const folderName = path.basename(runDir);
  res.set('Content-Disposition', `attachment; filename="${folderName}.zip"`);
  res.set('Content-Type', 'application/zip');

  const archive = archiver('zip');
  archive.on('error', err => res.status(500).send(err.message));
  archive.pipe(res);

  for (const name of files) {
    archive.file(path.join(runDir, name), { name });
  }

  archive.finalize();
});

// ── Job runner ────────────────────────────────────────────────────────────────
async function runJob(rows, runDir) {
  const log = (type, msg, extra = {}) => {
    console.log(`[${type}] ${msg}`);
    broadcast({ type, message: msg, ...extra });
  };

  log('info', `Thư mục output: ${path.basename(runDir)}`);
  const tools = [...new Set(rows.map(r => r.tool || 'chatgpt'))];
  log('info', `Các tool sử dụng: ${tools.join(', ')} — concurrency: ${CONCURRENCY}`);

  // Pool của bots đã login, mỗi bot có browser riêng
  // Map: tool → Bot[]
  const workerPools = {};
  const allBots = [];

  try {
    for (const tool of tools) {
      const Bot = tool === 'gemini' ? GeminiAutomator : ChatGPTAutomator;
      const count = Math.min(CONCURRENCY, rows.filter(r => (r.tool || 'chatgpt') === tool).length);
      log('info', `Khởi động ${count} browser [${tool}]...`);

      const pool = [];
      for (let w = 0; w < count; w++) {
        const bot = new Bot({ headless: HEADLESS });
        await bot.launch();
        log('info', `  [${tool} #${w + 1}] Kiểm tra đăng nhập...`);
        await bot.ensureLoggedIn();
        log('success', `  [${tool} #${w + 1}] Đã đăng nhập`);
        pool.push(bot);
        allBots.push(bot);
      }
      workerPools[tool] = pool;
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Hàng đợi index cho từng tool
    const queues = {};
    for (const tool of tools) {
      queues[tool] = rows.map((r, i) => i).filter(i => (rows[i].tool || 'chatgpt') === tool);
    }

    // Chạy song song tất cả workers
    const workerPromises = [];
    for (const tool of tools) {
      for (const bot of workerPools[tool]) {
        workerPromises.push(runWorker(bot, tool, queues[tool], runDir));
      }
    }
    await Promise.all(workerPromises);

    for (const bot of allBots) {
      try { await bot.saveCookies(); } catch (_) {}
    }

    log('done', `Hoàn tất! ${jobState.results.filter(r => r.status === 'success').length}/${rows.length} thành công`);

  } catch (err) {
    log('error', `Lỗi nghiêm trọng: ${err.message}`);
  } finally {
    jobState.running = false;
    for (const bot of allBots) {
      try { await bot.close(); } catch (_) {}
    }
    broadcast({ type: 'finished', results: jobState.results });
  }

  // Worker loop: lấy index từ queue dùng chung (mảng shared, splice từ đầu)
  async function runWorker(bot, tool, sharedQueue, runDir) {
    while (jobState.running) {
      const i = sharedQueue.shift();
      if (i === undefined) break;

      const row = rows[i];
      log('progress', `[${i + 1}/${rows.length}] [${tool.toUpperCase()}] "${row.name}"`, { index: i });

      try {
        log('info', `  Tải ảnh: ${row.imageUrl}`, { index: i });
        const tempImg = await downloadImageToTemp(row.imageUrl);

        await bot.newConversation();

        log('info', `  Gửi: "${row.description.substring(0, 60)}..."`, { index: i });
        const response = await bot.sendImageAndPrompt(tempImg, row.description);

        if (fs.existsSync(tempImg)) fs.unlinkSync(tempImg);

        let outputPath = await bot.downloadOutputImage(runDir, row.name);

        if (!outputPath && response.imageUrl) {
          outputPath = await saveOutputImage(response.imageUrl, runDir, row.name);
        }

        if (!outputPath) {
          const textPath = path.join(runDir, `${sanitizeFilename(row.name)}.txt`);
          fs.writeFileSync(textPath, response.text || '');
          outputPath = textPath;
          log('warn', `  Không có ảnh, lưu text: ${path.basename(textPath)}`, { index: i });
        }

        const fileName = path.basename(outputPath);
        jobState.currentFiles.push(fileName);
        jobState.results[i] = { ...row, status: 'success', outputPath };
        log('success', `  Xong: ${fileName}`, { index: i });
        broadcast({ type: 'rowDone', index: i, status: 'success', name: row.name, file: fileName });

      } catch (err) {
        jobState.results[i] = { ...row, status: 'error', error: err.message };
        log('error', `  Lỗi [${row.name}]: ${err.message}`, { index: i });
        broadcast({ type: 'rowDone', index: i, status: 'error', name: row.name, error: err.message });
      }

      if (sharedQueue.length > 0 && jobState.running) {
        await new Promise(r => setTimeout(r, DELAY));
      }
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(path.resolve('./tmp_uploads'), { recursive: true });

app.listen(PORT, () => {
  console.log(`\n  Convert AI UI đang chạy tại: http://localhost:${PORT}\n`);
});
