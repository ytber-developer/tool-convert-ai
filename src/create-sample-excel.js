const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

async function createSampleExcel() {
  const outputPath = path.resolve('./input/data.xlsx');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');

  sheet.columns = [
    { header: 'Tên mẫu',  key: 'name',        width: 25 },
    { header: 'Link ảnh', key: 'imageUrl',     width: 60 },
    { header: 'Mô tả',    key: 'description',  width: 80 },
    { header: 'AI Tool',  key: 'tool',         width: 12 },
  ];

  // Style header
  const headerRow = sheet.getRow(1);
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  // Validation dropdown cho cột AI Tool (cột 4)
  sheet.getColumn(4).eachCell({ includeEmpty: true }, (cell, rowNumber) => {
    if (rowNumber === 1) return;
    cell.dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"chatgpt,gemini"'],
      showErrorMessage: true,
      errorTitle: 'Giá trị không hợp lệ',
      error: 'Chỉ được chọn: chatgpt hoặc gemini',
    };
  });

  sheet.addRows([
    {
      name: 'mau-ao-do',
      imageUrl: 'https://via.placeholder.com/800x600/FF5733/FFFFFF?text=Ao+Do',
      description: 'Remove the background and keep only the clothing. Output PNG with transparent background.',
      tool: 'chatgpt',
    },
    {
      name: 'mau-tui-xach',
      imageUrl: 'https://via.placeholder.com/800x600/3498DB/FFFFFF?text=Tui+Xach',
      description: 'Change the bag color to red with white background.',
      tool: 'gemini',
    },
    {
      name: 'san-pham-giay',
      imageUrl: 'https://via.placeholder.com/800x600/2ECC71/FFFFFF?text=Giay',
      description: 'Create a professional product photo with clean white background and soft shadow.',
      tool: 'chatgpt',
    },
  ]);

  await workbook.xlsx.writeFile(outputPath);
  console.log(`File mẫu đã được tạo: ${outputPath}`);
  console.log('\nCác cột:');
  console.log('  - Tên mẫu  : tên file output');
  console.log('  - Link ảnh : URL hoặc đường dẫn file local (vd: ./images/photo.jpg)');
  console.log('  - Mô tả    : prompt gửi lên AI');
  console.log('  - AI Tool  : "chatgpt" hoặc "gemini" (mặc định: chatgpt)\n');
}

createSampleExcel().catch(console.error);
