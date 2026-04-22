/**
 * Debug script: vào thẳng 1 conversation URL và thử download ảnh
 * Usage: node src/debug-download.js <chat-url> <sample-name>
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { ChatGPTAutomator } = require('./chatgpt-automator');

const CHAT_URL = process.argv[2] || 'https://chatgpt.com/c/69e72b0b-545c-8323-a0eb-d9aa78e62759';
const SAMPLE_NAME = process.argv[3] || 'debug-output';
const OUTPUT_DIR = path.resolve('./output');

async function main() {
  console.log('URL:', CHAT_URL);
  console.log('Sample:', SAMPLE_NAME);

  const bot = new ChatGPTAutomator({ headless: false });
  await bot.launch();

  try {
    console.log('\n[1] Mở conversation...');
    await bot.page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    console.log('\n[2] Bắt đầu download flow...');
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const result = await bot.downloadOutputImage(OUTPUT_DIR, SAMPLE_NAME);
    console.log('\n[Result]', result || 'KHÔNG tải được');

  } finally {
    console.log('\nGiữ browser mở 30s để quan sát...');
    await new Promise(r => setTimeout(r, 30000));
    await bot.close();
  }
}

main().catch(console.error);
