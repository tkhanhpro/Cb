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

// Hàm generate token cho Twitter undocumented API
function getToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, '');
}

// Route API upload
app.get('/upload', async (req, res) => {
  let { url } = req.query;

  // Kiểm tra xem url có được cung cấp không
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let filePath;
  try {
    // Xử lý đặc biệt cho Twitter/X
    if ((url.includes('twitter.com') || url.includes('x.com')) && url.includes('/status/')) {
      const parts = new URL(url).pathname.split('/');
      const tweetId = parts[parts.length - 1];
      const token = getToken(tweetId);
      const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=en`;
      const apiResponse = await axios.get(apiUrl, {
        headers: {
          'User-Agent': getRandomUserAgent(),
        }
      });
      const tweetData = apiResponse.data;

      let mediaUrl;
      if (tweetData.mediaDetails && tweetData.mediaDetails.length > 0) {
        const media = tweetData.mediaDetails[0];
        if (media.type === 'video' || media.type === 'animated_gif') {
          const variants = media.videoVariants || [];
          const bestVariant = variants.reduce((prev, curr) => (curr.bitrate > prev.bitrate ? curr : prev), {bitrate: 0, url: ''});
          mediaUrl = bestVariant.url;
        } else if (media.type === 'photo') {
          mediaUrl = media.expandedUrl;
        }
      }

      if (mediaUrl) {
        url = mediaUrl; // Chuyển sang tải media trực tiếp
      } else {
        throw new Error('No media found in tweet');
      }
    }

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

      // Extract media URLs
      const mediaUrls = [];
      $('video source').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('video').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('img').each((i, el) => mediaUrls.push($(el).attr('src')));
      $('meta[property="og:video"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      $('meta[property="og:video:secure_url"]').each((i, el) => mediaUrls.push($(el).attr('content')));
      $('meta[property="og:image"]').each((i, el) => mediaUrls.push($(el).attr('content')));

      // Lọc và chọn URL đầu tiên hợp lệ
      let extractedUrl = mediaUrls.find(u => u && (u.startsWith('http') || u.startsWith('/')));
      if (extractedUrl) {
        extractedUrl = new URL(extractedUrl, url).href;
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
    }

    // Lưu file tạm thời
    const ext = path.extname(new URL(url).pathname) || '.tmp';
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
