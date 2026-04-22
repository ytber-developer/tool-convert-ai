const ExcelJS = require('exceljs');

async function readInputExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[0];
  const rows = [];

  const headerRow = worksheet.getRow(1);
  const headers = {};
  headerRow.eachCell((cell, colNumber) => {
    const val = String(cell.value || '').trim().toLowerCase();
    if (val.includes('tên mẫu') || val.includes('ten mau') || val === 'name') {
      headers.name = colNumber;
    } else if (val.includes('link ảnh') || val.includes('link anh') || val.includes('image') || val === 'url') {
      headers.imageUrl = colNumber;
    } else if (val.includes('mô tả') || val.includes('mo ta') || val.includes('description') || val.includes('prompt')) {
      headers.description = colNumber;
    } else if (val.includes('tool') || val.includes('công cụ') || val.includes('cong cu')) {
      headers.tool = colNumber;
    }
  });

  if (!headers.name || !headers.imageUrl || !headers.description) {
    throw new Error(
      `Excel thiếu cột bắt buộc.\nCần có: "Tên mẫu", "Link ảnh", "Mô tả"\nĐã tìm thấy: ${JSON.stringify(headers)}`
    );
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const name = row.getCell(headers.name).value;
    const imageUrl = row.getCell(headers.imageUrl).value;
    const description = row.getCell(headers.description).value;
    const toolRaw = headers.tool ? row.getCell(headers.tool).value : null;

    if (!name && !imageUrl) return;

    const toolVal = extractCellText(toolRaw).toLowerCase();
    const tool = toolVal.includes('gemini') ? 'gemini' : 'chatgpt';

    rows.push({
      rowNumber,
      name: String(name || '').trim(),
      imageUrl: extractCellText(imageUrl),
      description: extractCellText(description),
      tool,
    });
  });

  return rows;
}

function extractCellText(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    return (value.hyperlink || value.text || value.result || '').toString().trim();
  }
  return String(value).trim();
}

module.exports = { readInputExcel };
