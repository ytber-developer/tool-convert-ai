require('dotenv').config();
const { ChatGPTAutomator } = require('./chatgpt-automator');

async function browse() {
  const bot = new ChatGPTAutomator({ headless: false });
  await bot.launch();
  await bot.page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('\nBrowser da mo voi cookies. Nhan Ctrl+C de dong.\n');
  await new Promise(() => {}); // giu browser mo mai mai
}

browse().catch(console.error);
