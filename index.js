const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const app = express();
const port = 3000;

// Middleware để parse JSON
app.use(express.json());

// Thư mục tạm để lưu file
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

// Danh sách User-Agent để xoay vòng
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

// Hàm chọn User-Agent ngẫu nhiên
const getRandomUserAgent = () => {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
};

// Route API upload
app.get('/upload', async (req, res) => {
  const { url } = req.query;

  // Kiểm tra xem url có được cung cấp không
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  // Kiểm tra định dạng file từ URL
  const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.webm'];
  const ext = path.extname(url).toLowerCase();
  if (!validExtensions.includes(ext)) {
    return res.status(400).json({ success: false, error: `Unsupported file extension: ${ext}. Supported: ${validExtensions.join(', ')}` });
  }

  let filePath;
  try {
    // Tải file từ URL về server
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'image/*,video/*',
        'Referer': new URL(url).origin, // Sử dụng origin của URL làm Referer
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      },
      timeout: 10000 // Timeout 10 giây
    });

    // Kiểm tra Content-Type để đảm bảo file hợp lệ
    const contentType = response.headers['content-type'];
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      return res.status(400).json({ success: false, error: `Invalid content type: ${contentType}` });
    }

    // Lưu file tạm thời
    const fileName = `temp-${Date.now()}${ext}`;
    filePath = path.join(TEMP_DIR, fileName);
    const fileStream = fs.createWriteStream(filePath);
    response.data.pipe(fileStream);

    // Đợi file tải xong
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    // Upload file lên Catbox
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(filePath));

    const uploadResponse = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: {
        ...form.getHeaders()
      }
    });

    // Kiểm tra phản hồi từ Catbox
    const catboxResult = uploadResponse.data;
    if (!catboxResult.startsWith('https://files.catbox.moe/')) {
      throw new Error(`Catbox upload failed: ${catboxResult}`);
    }

    // Trả về kết quả
    res.json({
      success: true,
      data: catboxResult
    });
  } catch (error) {
    // Xử lý lỗi chi tiết
    const errorMessage = error.response
      ? `HTTP ${error.response.status}: ${error.message}`
      : error.message;
    res.status(error.response?.status || 500).json({
      success: false,
      error: errorMessage
    });
  } finally {
    // Xóa file tạm nếu tồn tại
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete temp file: ${err.message}`);
      }
    }
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
