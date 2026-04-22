# Convert AI — ChatGPT Image Processor

Tool tự động đọc Excel (tên mẫu, link ảnh, mô tả), upload từng ảnh lên ChatGPT kèm prompt, tải về kết quả đặt tên theo tên mẫu.

## Cài đặt

```bash
npm install
cp .env.example .env
```

## Sử dụng

### Bước 1 — Tạo file Excel mẫu

```bash
npm run create-sample
# → tạo input/data.xlsx với 3 dòng ví dụ
```

Hoặc tự tạo file `input/data.xlsx` với 3 cột bắt buộc:

| Tên mẫu | Link ảnh | Mô tả |
|---------|----------|-------|
| ao-do-mau-1 | https://example.com/image.jpg | Remove background... |
| tui-xach-do | https://example.com/bag.png | Change color to red... |

### Bước 2 — Login ChatGPT (chỉ cần làm 1 lần)

```bash
npm run login
```

Browser sẽ mở ra, bạn đăng nhập thủ công, sau đó Enter. Session được lưu vào `cookies/session.json`.

### Bước 3 — Chạy tool

```bash
npm start
```

Kết quả lưu vào `output/` với tên file = cột "Tên mẫu" + `.png`.

## Cấu hình `.env`

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `INPUT_FILE` | `./input/data.xlsx` | Đường dẫn file Excel |
| `OUTPUT_DIR` | `./output` | Thư mục lưu kết quả |
| `DELAY_BETWEEN_ROWS` | `5000` | Delay (ms) giữa các request |
| `HEADLESS` | `false` | `true` để ẩn browser |

## Cấu trúc project

```
convert-ai/
├── src/
│   ├── index.js              # Entry point
│   ├── excel-reader.js       # Đọc file Excel
│   ├── chatgpt-automator.js  # Tự động hóa ChatGPT bằng Puppeteer
│   ├── downloader.js         # Download & lưu ảnh
│   ├── login.js              # Script login 1 lần
│   └── create-sample-excel.js
├── input/                    # Để file data.xlsx vào đây
├── output/                   # Kết quả tải về
├── cookies/                  # Session cookies (gitignored)
├── .env                      # Config (gitignored)
└── package.json
```

## Lưu ý

- ChatGPT yêu cầu tài khoản **ChatGPT Plus** để dùng tính năng tạo/chỉnh sửa ảnh (GPT-4o)
- Nếu ChatGPT thay đổi UI, cần cập nhật selectors trong `chatgpt-automator.js`
- Tool tự bỏ qua (skip) các dòng đã có output file
