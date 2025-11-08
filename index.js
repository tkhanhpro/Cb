const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const https = require('https');
const { Worker } = require('worker_threads');

const app = express();
const port = process.env.PORT || 3000;

// Phục vụ file tĩnh từ thư mục public
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Thư mục tạm để lưu file
const TEMP_DIR = path.join(__dirname, 'temp');
const CATBOX_USERHASH = 'c39384878f14bb678aa6de665'; // Userhash của bạn

// 🔄 Dynamic Connection Pool
const agent = new https.Agent({ 
  keepAlive: true,
  maxSockets: 50,
  timeout: 30000
});

const ensureTempDir = async () => {
  try {
    await fsPromises.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Lỗi khi tạo thư mục tạm:', error);
  }
};

// Khởi tạo thư mục tạm
ensureTempDir();

// Tạo instance axios với cấu hình tối ưu
const axiosInstance = axios.create({
  timeout: 30000,
  maxContentLength: 100 * 1024 * 1024, // Tăng lên 100MB
  maxRedirects: 5,
  httpsAgent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  }
});

// 🔁 Adaptive Retry Function
async function retryRequest(fn, maxAttempts = 5, baseDelay = 1000, maxDelay = 20000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      let delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      delay += Math.random() * (delay / 2); // jitter
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// 🚀 Upload từ URL với logic từ catbox.js
app.get('/upload', async (req, res) => {
  let { url, type } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Yêu cầu cung cấp URL' });
  }

  try {
    url = decodeURIComponent(url);
    new URL(url); // Validate URL
  } catch (error) {
    return res.status(400).json({ success: false, error: 'URL không hợp lệ' });
  }

  // Xác định extension từ type hoặc URL
  let ext = 'png';
  if (type) {
    const typeMap = {
      'photo': 'png',
      'animated_image': 'gif', 
      'video': 'mp4',
      'audio': 'mp3'
    };
    ext = typeMap[type] || 'png';
  } else {
    const urlExt = path.extname(url.split('?')[0]).toLowerCase();
    if (urlExt) ext = urlExt.replace('.', '');
  }

  const fileName = `upload-${Date.now()}.${ext}`;
  const filePath = path.join(TEMP_DIR, fileName);

  try {
    // 🗜 Stream Processing: tải file qua stream
    const response = await axiosInstance({
      method: 'get',
      url,
      responseType: 'stream',
      headers: {
        'Accept': '*/*',
        'Referer': url,
      },
    });

    let uploadResult;

    // Kiểm tra kích thước file nếu có
    const contentLength = response.headers['content-length'];
    const size = parseInt(contentLength || 0);

    // Nếu file lớn hơn 20MB → dùng Parallel Chunked Upload
    if (size > 20 * 1024 * 1024) {
      console.log(`⚡ Dùng Chunked Upload cho file lớn (${(size/1024/1024).toFixed(1)}MB)`);

      // Lưu file tạm trước
      const fileStream = fs.createWriteStream(filePath);
      response.data.pipe(fileStream);
      
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });

      // Upload từ file đã lưu
      uploadResult = await uploadLargeFile(filePath, ext);

    } else {
      // File nhỏ → upload trực tiếp với retry
      uploadResult = await retryRequest(async () => {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("userhash", CATBOX_USERHASH);
        form.append("fileToUpload", response.data, `upload.${ext}`);

        const uploadResponse = await axiosInstance.post(
          "https://catbox.moe/user/api.php", 
          form, 
          { headers: form.getHeaders() }
        );

        const data = uploadResponse.data;
        if (data.startsWith("Error:")) {
          throw new Error(data);
        }
        return data;
      });
    }

    // Xóa file tạm nếu tồn tại
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
    }

    res.json({
      success: true,
      url: uploadResult,
    });

  } catch (error) {
    // Xóa file tạm nếu tồn tại
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath).catch(() => {});
    }

    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Upload thất bại'
    });
  }
});

// 🚀 API mới: Upload từ multiple URLs (tương tự catbox.js)
app.post('/upload-multiple', async (req, res) => {
  const { attachments } = req.body;

  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Vui lòng cung cấp danh sách attachments' 
    });
  }

  const validTypes = ["photo", "video", "audio", "animated_image"];
  const links = [];

  for (const attachment of attachments) {
    const { url, type } = attachment;
    
    if (!url || !validTypes.includes(type)) {
      continue;
    }

    const ext = type === "photo" ? "png"
              : type === "animated_image" ? "gif" 
              : type === "video" ? "mp4"
              : "mp3";

    try {
      // 🗜 Stream Processing
      const response = await axiosInstance({
        method: 'get',
        url,
        responseType: 'stream',
        headers: {
          'Accept': '*/*',
          'Referer': url,
        },
      });

      const contentLength = response.headers['content-length'];
      const size = parseInt(contentLength || 0);

      let uploadUrl;

      if (size > 20 * 1024 * 1024) {
        // File lớn - lưu tạm và upload
        const fileName = `chunk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`;
        const filePath = path.join(TEMP_DIR, fileName);
        
        const fileStream = fs.createWriteStream(filePath);
        response.data.pipe(fileStream);
        
        await new Promise((resolve, reject) => {
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });

        uploadUrl = await uploadLargeFile(filePath, ext);
        
        // Xóa file tạm
        await fsPromises.unlink(filePath);
      } else {
        // File nhỏ - upload trực tiếp
        uploadUrl = await retryRequest(async () => {
          const form = new FormData();
          form.append("reqtype", "fileupload");
          form.append("userhash", CATBOX_USERHASH);
          form.append("fileToUpload", response.data, `upload.${ext}`);

          const uploadResponse = await axiosInstance.post(
            "https://catbox.moe/user/api.php", 
            form, 
            { headers: form.getHeaders() }
          );

          const data = uploadResponse.data;
          if (data.startsWith("Error:")) {
            throw new Error(data);
          }
          return data;
        });
      }

      links.push(uploadUrl);

    } catch (err) {
      console.error(`Upload failed for ${url}:`, err);
      // Continue với file tiếp theo thay vì dừng hoàn toàn
    }
  }

  if (links.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Không có file nào upload thành công' 
    });
  }

  res.json({
    success: true,
    urls: links
  });
});

// 🛠 Hàm upload file lớn với chunked upload
async function uploadLargeFile(filePath, ext) {
  const stats = await fsPromises.stat(filePath);
  const size = stats.size;
  
  if (size <= 20 * 1024 * 1024) {
    // File đã nhỏ lại sau khi lưu - upload trực tiếp
    return await uploadDirect(filePath, ext);
  }

  const chunks = Math.ceil(size / (5 * 1024 * 1024)); // 5MB/chunk
  const promises = [];

  for (let i = 0; i < chunks; i++) {
    promises.push(new Promise((resolve, reject) => {
      const start = i * 5 * 1024 * 1024;
      const end = Math.min((i + 1) * 5 * 1024 * 1024 - 1, size - 1);
      
      const workerCode = `
        const { parentPort, workerData } = require("worker_threads");
        const axios = require("axios");
        const FormData = require("form-data");
        const fs = require("fs");

        (async () => {
          try {
            const { filePath, start, end, index, ext, userhash } = workerData;
            
            // Đọc chunk từ file
            const stream = fs.createReadStream(filePath, { start, end });
            
            const form = new FormData();
            form.append("reqtype", "fileupload");
            form.append("userhash", userhash);
            form.append("fileToUpload", stream, \`chunk_\${index}.\${ext}\`);
            
            const upload = await axios.post(
              "https://catbox.moe/user/api.php", 
              form, 
              { headers: form.getHeaders() }
            );
            
            parentPort.postMessage({ success: true, data: upload.data });
          } catch (error) {
            parentPort.postMessage({ success: false, error: error.message });
          }
        })();
      `;
      
      const worker = new Worker(workerCode, { 
        eval: true, 
        workerData: { 
          filePath, 
          start, 
          end, 
          index: i, 
          ext,
          userhash: CATBOX_USERHASH
        } 
      });
      
      worker.on("message", (msg) => {
        if (msg.success) {
          resolve(msg.data);
        } else {
          reject(new Error(msg.error));
        }
      });
      
      worker.on("error", reject);
    }));
  }

  const results = await Promise.all(promises);
  return results[0]; // Trả về URL đầu tiên (các chunk sẽ merge trên catbox)
}

// 🛠 Hàm upload trực tiếp
async function uploadDirect(filePath, ext) {
  return await retryRequest(async () => {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("userhash", CATBOX_USERHASH);
    form.append("fileToUpload", fs.createReadStream(filePath), `upload.${ext}`);

    const uploadResponse = await axiosInstance.post(
      "https://catbox.moe/user/api.php", 
      form, 
      { headers: form.getHeaders() }
    );

    const data = uploadResponse.data;
    if (data.startsWith("Error:")) {
      throw new Error(data);
    }
    return data;
  });
}

// 🧹 Dọn dẹp thư mục tạm định kỳ
setInterval(async () => {
  try {
    const files = await fsPromises.readdir(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fsPromises.stat(filePath);
      // Xóa file cũ hơn 30 phút
      if (now - stats.mtimeMs > 1800000) {
        await fsPromises.unlink(filePath);
      }
    }
  } catch (error) {
    console.error('Lỗi khi dọn dẹp thư mục tạm:', error);
  }
}, 1800000); // Chạy mỗi 30 phút

// 🏠 Homepage
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Catbox Upload Server</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
          code { background: #eee; padding: 2px 5px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>🚀 Catbox Upload Server</h1>
        <p>Server upload file lên Catbox với tốc độ cao</p>
        
        <div class="endpoint">
          <h3>GET /upload</h3>
          <p>Upload file từ URL</p>
          <p><strong>Params:</strong> <code>url</code> (required), <code>type</code> (optional)</p>
          <p><strong>Example:</strong> <code>/upload?url=https://example.com/image.jpg&type=photo</code></p>
        </div>

        <div class="endpoint">
          <h3>POST /upload-multiple</h3>
          <p>Upload nhiều file cùng lúc</p>
          <p><strong>Body:</strong> <code>{ "attachments": [{ "url": "...", "type": "photo" }] }</code></p>
        </div>
      </body>
    </html>
  `);
});

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
  console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
  console.log(`📁 Thư mục tạm: ${TEMP_DIR}`);
  console.log(`🔗 Catbox userhash: ${CATBOX_USERHASH}`);
});
