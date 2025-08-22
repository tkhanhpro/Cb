const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const cheerio = require('cheerio');
const app = express();
const port = 3000;

// Middleware để parse JSON
app.use(express.json());

// Thư mục tạm để lưu file
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
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
  let { url } = req.query;

  // Kiểm tra xem url có được cung cấp không
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let filePath;
  try {
    // Tải nội dung từ URL
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': '*/*',
        'Referer': new URL(url).origin,
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      },
      timeout: 10000
    });

    const contentType = response.headers['content-type'];
    let isHtml = contentType.includes('text/html');
    let stream = response.data;

    if (isHtml) {
      // Đọc stream thành string nếu là HTML
      let html = '';
      stream.on('data', chunk => html += chunk.toString());
      await new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      // Parse HTML với cheerio
      const $ = cheerio.load(html);

      // Extract media URLs - Mở rộng để hỗ trợ nhiều loại tag hơn cho các mạng xã hội khác nhau
      const mediaUrls = [];
      // Video tags
      $('video source').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('video').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('meta[property="og:video"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      $('meta[property="og:video:secure_url"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      $('meta[name="twitter:player:stream"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      // Image tags
      $('img').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('meta[property="og:image"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      $('meta[name="twitter:image"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      // Audio or other media
      $('audio source').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('audio').each((i, el) => mediaUrls.push($(el).attr('src')));
      // Additional for TikTok, Instagram, etc.
      $('meta[name="twitter:player"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      $('link[rel="canonical"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('.mp4') || href.includes('.jpg') || href.includes('.png'))) mediaUrls.push(href);
      });

      // Lọc và chọn URL đầu tiên hợp lệ (ưu tiên video nếu có)
      let extractedUrl = mediaUrls.find(u => u && (u.includes('.mp4') || u.includes('.webm') || u.includes('.mov'))) ||
                         mediaUrls.find(u => u && (u.includes('.jpg') || u.includes('.png') || u.includes('.gif') || u.includes('.jpeg'))) ||
                         mediaUrls.find(u => u && (u.startsWith('http') || u.startsWith('/')));
      if (extractedUrl) {
        if (!extractedUrl.startsWith('http')) {
          extractedUrl = new URL(extractedUrl, url).href;
        }
      } else {
        throw new Error('No media found in page');
      }

      // Tải stream từ extractedUrl
      const mediaResponse = await axios({
        method: 'get',
        url: extractedUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': '*/*',
          'Referer': new URL(extractedUrl).origin,
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'keep-alive'
        },
        timeout: 10000
      });
      stream = mediaResponse.data;
      url = extractedUrl; // Cập nhật url để lấy ext
    }

    // Xác định định dạng file từ content-type hoặc URL
    let ext = path.extname(new URL(url).pathname) || '.tmp';
    if (contentType.includes('image')) ext = contentType.includes('png') ? '.png' : contentType.includes('jpeg') ? '.jpg' : '.jpg';
    else if (contentType.includes('video')) ext = '.mp4';
    else if (contentType.includes('audio')) ext = '.mp3';

    // Lưu file tạm thời
    const fileName = `temp-${Date.now()}${ext}`;
    filePath = path.join(TEMP_DIR, fileName);
    const fileStream = fs.createWriteStream(filePath);
    stream.pipe(fileStream);

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
