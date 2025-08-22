const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const cheerio = require('cheerio');
const axiosRetry = require('axios-retry').default;
const app = express();
const port = process.env.PORT || 3000;

// Middleware để parse JSON
app.use(express.json());

// Thư mục tạm để lưu file
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Cấu hình retry cho axios
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000, // Delay: 1s, 2s, 3s
  retryCondition: (error) => error.response?.status === 403 || error.code === 'ECONNABORTED'
});

// ZenRows API Key
const ZENROWS_API_KEY = 'e879dc413ddc8a6e42e13633481d7a58d0716e69';

// Route API upload
app.get('/upload', async (req, res) => {
  let { url } = req.query;

  // Kiểm tra xem url có được cung cấp không
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let filePath;
  try {
    // Tải nội dung từ URL qua ZenRows Universal Scraper API
    const zenrowsResponse = await axios.get(`https://api.zenrows.com/v1/`, {
      params: {
        url: encodeURIComponent(url),
        apikey: ZENROWS_API_KEY,
        js_render: 'true',
        premium_proxy: 'true',
        antibot: 'true', // Thêm để bypass anti-bot mạnh như Cloudflare
        wait: '3000' // Chờ 3s để render JS đầy đủ
      },
      headers: {
        'User-Agent': 'axios' // Giữ đơn giản như lệnh MiraiV2
      },
      timeout: 30000
    });
    const html = zenrowsResponse.data;

    // Parse HTML với cheerio
    const $ = cheerio.load(html);

    // Extract media URLs - Mở rộng để hỗ trợ nhiều loại tag
    const mediaUrls = [];
    $('video source').each((i, el) => mediaUrls.push($(el).attr('src')));
    $('video').each((i, el) => mediaUrls.push($(el).attr('src')));
    $('meta[property="og:video"]').each((i, el) => mediaUrls.push($(el).attr('content')));
    $('meta[property="og:video:secure_url"]').each((i, el) => mediaUrls.push($(el).attr('content')));
    $('meta[name="twitter:player:stream"]').each((i, el) => mediaUrls.push($(el).attr('content')));
    $('img').each((i, el) => mediaUrls.push($(el).attr('src')));
    $('meta[property="og:image"]').each((i, el) => mediaUrls.push($(el).attr('content')));
    $('meta[name="twitter:image"]').each((i, el) => mediaUrls.push($(el).attr('content')));
    $('audio source').each((i, el) => mediaUrls.push($(el).attr('src')));
    $('audio').each((i, el) => mediaUrls.push($(el).attr('src')));
    $('meta[name="twitter:player"]').each((i, el) => mediaUrls.push($(el).attr('content')));
    $('link[rel="canonical"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && (href.includes('.mp4') || href.includes('.jpg') || href.includes('.png') || href.includes('.mp3'))) mediaUrls.push(href);
    });

    // Lọc và chọn URL đầu tiên hợp lệ
    let extractedUrl = mediaUrls.find(u => u && (u.includes('.mp4') || u.includes('.webm') || u.includes('.mov'))) ||
                       mediaUrls.find(u => u && (u.includes('.jpg') || u.includes('.png') || u.includes('.gif') || u.includes('.jpeg'))) ||
                       mediaUrls.find(u => u && (u.includes('.mp3'))) ||
                       mediaUrls.find(u => u && (u.startsWith('http') || u.startsWith('/')));
    if (extractedUrl) {
      if (!extractedUrl.startsWith('http')) {
        extractedUrl = new URL(extractedUrl, url).href;
      }
    } else {
      throw new Error('No media found in page');
    }

    // Tải media từ extractedUrl bằng Axios (giống lệnh stream MiraiV2)
    const mediaResponse = await axios({
      method: 'get',
      url: extractedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'axios' // Giữ đơn giản để tránh 403
      },
      timeout: 10000
    });
    const stream = mediaResponse.data;
    const contentType = mediaResponse.headers['content-type'];
    url = extractedUrl; // Cập nhật url để lấy ext

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
