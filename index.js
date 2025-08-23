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

// Route API upload
app.get('/upload', async (req, res) => {
  const { url } = req.query;

  // Kiểm tra xem url có được cung cấp không
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Tải file từ URL về server
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': '*/*',
        'Referer': url // Giả lập referer để tránh chặn từ CDN
      }
    });

    // Lưu file tạm thời
    const fileName = `temp-${Date.now()}${path.extname(url) || '.tmp'}`;
    const filePath = path.join(TEMP_DIR, fileName);
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

    // Xóa file tạm sau khi upload
    fs.unlinkSync(filePath);

    // Trả về kết quả
    res.json({
      success: true,
      data: uploadResponse.data
    });
  } catch (error) {
    // Xử lý lỗi
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
