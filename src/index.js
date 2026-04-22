require('dotenv').config();
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const { readInputExcel } = require('./excel-reader');
const { ChatGPTAutomator } = require('./chatgpt-automator');
const { downloadImageToTemp, saveOutputImage } = require('./downloader');

const INPUT_FILE = process.env.INPUT_FILE || './input/data.xlsx';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const DELAY = parseInt(process.env.DELAY_BETWEEN_ROWS || '5000', 10);
const HEADLESS = process.env.HEADLESS === 'true';

async function main() {
  console.log(chalk.cyan('\n=== Convert AI - ChatGPT Image Processor ===\n'));

  // 1. Đọc Excel
  const inputPath = path.resolve(INPUT_FILE);
  if (!fs.existsSync(inputPath)) {
    console.error(chalk.red(`Không tìm thấy file Excel: ${inputPath}`));
    console.log(chalk.yellow('Chạy "npm run create-sample" để tạo file mẫu'));
    process.exit(1);
  }

  console.log(chalk.blue(`Đọc file: ${inputPath}`));
  const rows = await readInputExcel(inputPath);
  console.log(chalk.green(`Tìm thấy ${rows.length} dòng dữ liệu\n`));

  if (rows.length === 0) {
    console.log(chalk.yellow('Không có dữ liệu để xử lý'));
    process.exit(0);
  }

  // 2. Tạo thư mục output
  fs.mkdirSync(path.resolve(OUTPUT_DIR), { recursive: true });

  // 3. Khởi động browser
  const bot = new ChatGPTAutomator({ headless: HEADLESS });
  await bot.launch();

  try {
    // 4. Đảm bảo đã login
    await bot.ensureLoggedIn();

    // 5. Xử lý từng dòng
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(chalk.cyan(`\n[${i + 1}/${rows.length}] Xử lý: "${row.name}"`));

      try {
        // Kiểm tra output đã tồn tại chưa (skip nếu rồi)
        const { sanitizeFilename } = require('./downloader');
        const expectedOutput = path.resolve(OUTPUT_DIR, `${sanitizeFilename(row.name)}.png`);
        if (fs.existsSync(expectedOutput)) {
          console.log(chalk.yellow(`  [Skip] Output đã tồn tại: ${expectedOutput}`));
          results.push({ ...row, status: 'skipped', outputPath: expectedOutput });
          continue;
        }

        // Download ảnh input về local để upload
        console.log(`  [Step 1] Tải ảnh từ: ${row.imageUrl}`);
        const tempImagePath = await downloadImageToTemp(row.imageUrl);

        // Mở conversation mới
        await bot.newConversation();

        // Gửi ảnh + prompt
        console.log(`  [Step 2] Gửi lên ChatGPT với prompt: "${row.description.substring(0, 80)}..."`);
        const response = await bot.sendImageAndPrompt(tempImagePath, row.description);

        // Xóa file tạm
        fs.unlinkSync(tempImagePath);

        // Lưu output
        let outputPath = null;

        // Ưu tiên: thử click nút download trong ChatGPT
        outputPath = await bot.downloadOutputImage(path.resolve(OUTPUT_DIR), row.name);

        // Fallback: nếu không download được bằng button, lấy URL ảnh
        if (!outputPath && response.imageUrl) {
          console.log(`  [Step 3] Lưu ảnh từ URL response...`);
          outputPath = await saveOutputImage(response.imageUrl, path.resolve(OUTPUT_DIR), row.name);
        }

        if (!outputPath) {
          // Nếu không có ảnh, lưu text response
          const { sanitizeFilename } = require('./downloader');
          const textPath = path.resolve(OUTPUT_DIR, `${sanitizeFilename(row.name)}.txt`);
          fs.writeFileSync(textPath, response.text || '(no response)');
          outputPath = textPath;
          console.log(chalk.yellow(`  [Step 3] Không có ảnh output, đã lưu text: ${textPath}`));
        }

        console.log(chalk.green(`  [Done] Đã lưu: ${outputPath}`));
        results.push({ ...row, status: 'success', outputPath });

      } catch (err) {
        console.error(chalk.red(`  [Error] ${row.name}: ${err.message}`));
        results.push({ ...row, status: 'error', error: err.message });
      }

      // Delay giữa các request
      if (i < rows.length - 1) {
        console.log(chalk.gray(`  Đợi ${DELAY / 1000}s trước khi xử lý tiếp...`));
        await new Promise(r => setTimeout(r, DELAY));
      }
    }

    // 6. Báo cáo kết quả
    printSummary(results);
    await bot.saveCookies();

  } finally {
    await bot.close();
  }
}

function printSummary(results) {
  const success = results.filter(r => r.status === 'success').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error');

  console.log(chalk.cyan('\n=== Kết quả ==='));
  console.log(chalk.green(`Thành công : ${success}`));
  console.log(chalk.yellow(`Đã bỏ qua  : ${skipped} (file đã tồn tại)`));
  console.log(chalk.red  (`Lỗi        : ${errors.length}`));

  if (errors.length > 0) {
    console.log(chalk.red('\nCác lỗi:'));
    errors.forEach(r => console.log(chalk.red(`  - ${r.name}: ${r.error}`)));
  }
}

main().catch(err => {
  console.error(chalk.red('\nLỗi nghiêm trọng:'), err);
  process.exit(1);
});
