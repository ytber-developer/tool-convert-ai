/**
 * Chạy script này một lần để login và lưu session cookies.
 * Sau đó dùng npm start sẽ không cần login lại.
 */
require('dotenv').config();
const { ChatGPTAutomator } = require('./chatgpt-automator');

async function login() {
  console.log('=== Login ChatGPT ===\n');
  const bot = new ChatGPTAutomator({ headless: false });
  await bot.launch();

  try {
    await bot.ensureLoggedIn();
    await bot.saveCookies();
    console.log('\nLogin thành công! Cookies đã được lưu vào ./cookies/session.json');
    console.log('Lần sau chạy "npm start" sẽ tự động dùng session này.\n');
    await new Promise(r => setTimeout(r, 2000));
  } finally {
    await bot.close();
  }
}

login().catch(console.error);
