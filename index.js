const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const FormData = require('form-data');

const app = express();
const port = process.env.PORT || 3000;
// Phục vụ file tĩnh từ thư mục public
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Thư mục tạm để lưu file
const TEMP_DIR = path.join(__dirname, 'temp');
const CATBOX_USERHASH = '4abd140f8e936cdb0b2cc2dd4'; // Userhash của bạn

const ensureTempDir = async () => {
  try {
    await fsPromises.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Lỗi khi tạo thư mục tạm:', error);
  }
};

// Khởi tạo thư mục tạm
ensureTempDir();

// Tạo instance axios với cấu hình mặc định
const axiosInstance = axios.create({
  timeout: 30000,
  maxContentLength: 50 * 1024 * 1024, // Giới hạn 50MB
  maxRedirects: 5,
});

// Route API upload
app.get('/upload', async (req, res) => {
  let { url } = req.query;

  // Kiểm tra URL
  if (!url) {
    return res.status(400).json({ success: false, error: 'Yêu cầu cung cấp URL' });
  }

  // Giải mã URL nếu được encode
  try {
    url = decodeURIComponent(url);
  } catch (error) {
    return res.status(400).json({ success: false, error: 'URL không hợp lệ (lỗi giải mã)' });
  }

  // Kiểm tra định dạng URL
  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ success: false, error: 'Định dạng URL không hợp lệ' });
  }

  const fileName = `temp-${Date.now()}${path.extname(url.split('?')[0]) || '.tmp'}`;
  const filePath = path.join(TEMP_DIR, fileName);

  try {
    // Hàm tải file với cơ chế thử lại
    const downloadFile = async (retryCount = 3) => {
      for (let i = 0; i < retryCount; i++) {
        try {
          const response = await axiosInstance({
            method: 'get',
            url,
            responseType: 'stream',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
              'Accept': '*/*',
              'Referer': url,
              'Accept-Encoding': 'gzip, deflate, br',
              'Connection': 'keep-alive',
            },
          });

          // Kiểm tra content type
          const contentType = response.headers['content-type'];
          if (!contentType || contentType.includes('text/html')) {
            throw new Error('Nhận được loại nội dung không hợp lệ');
          }

          // Lưu file bằng fs.createWriteStream
          const fileStream = fs.createWriteStream(filePath);
          response.data.pipe(fileStream);

          await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
          });

          return;
        } catch (error) {
          if (i === retryCount - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    };

    await downloadFile();

    // Hàm upload lên Catbox với cơ chế thử lại
    const uploadToCatbox = async (retryCount = 3) => {
      for (let i = 0; i < retryCount; i++) {
        try {
          const form = new FormData();
          form.append('reqtype', 'fileupload');
          form.append('userhash', CATBOX_USERHASH); // Thêm userhash của bạn
          form.append('fileToUpload', fs.createReadStream(filePath));

          const uploadResponse = await axiosInstance.post(
            'https://catbox.moe/user/api.php',
            form,
            {
              headers: {
                ...form.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
              },
            }
          );

          // Kiểm tra phản hồi từ Catbox
          if (!uploadResponse.data || uploadResponse.data.includes('error')) {
            throw new Error(`Tải lên Catbox thất bại: ${uploadResponse.data}`);
          }

          return uploadResponse.data;
        } catch (error) {
          if (i === retryCount - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    };

    const result = await uploadToCatbox();

    // Xóa file tạm
    await fsPromises.unlink(filePath).catch(() => {});

    res.json({
      success: true,
      url: result, // Trả về URL từ Catbox
    });
  } catch (error) {
    // Xử lý lỗi và xóa file tạm
    await fsPromises.unlink(filePath).catch(() => {});

    let statusCode = 500;
    let errorMessage = 'Lỗi server nội bộ';

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = error.response.status === 412
        ? 'Lỗi 412: URL không hợp lệ hoặc bị chặn'
        : error.response.data?.message || error.message;
    } else if (error.request) {
      errorMessage = 'Không nhận được phản hồi từ server';
    } else {
      errorMessage = error.message;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Dọn dẹp thư mục tạm định kỳ
setInterval(async () => {
  try {
    const files = await fsPromises.readdir(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fsPromises.stat(filePath);
      // Xóa file cũ hơn 1 giờ
      if (now - stats.mtimeMs > 3600000) {
        await fsPromises.unlink(filePath);
      }
    }
  } catch (error) {
    console.error('Lỗi khi dọn dẹp thư mục tạm:', error);
  }
}, 3600000); // Chạy mỗi giờ

// Middleware xử lý lỗi
app.use((err, req, res, next) => {
  console.error('Lỗi không mong muốn:', err);
  res.status(500).json({
    success: false,
    error: 'Lỗi server không mong muốn',
  });
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
