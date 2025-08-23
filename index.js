const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const app = express();
const port = 3000;

// Middleware
app.use(express.json());

// Temp directory setup
const TEMP_DIR = path.join(__dirname, 'temp');
const ensureTempDir = async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating temp directory:', error);
  }
};

// Initialize temp directory
ensureTempDir();

// Enhanced error handling for axios
const axiosInstance = axios.create({
  timeout: 30000,
  maxContentLength: 50 * 1024 * 1024, // 50MB limit
  maxRedirects: 5,
});

// Route API upload
app.get('/upload', async (req, res) => {
  let { url } = req.query;

  // Validate and decode URL
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Decode URL if encoded
  try {
    url = decodeURIComponent(url);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL encoding' });
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const fileName = `temp-${Date.now()}${path.extname(url.split('?')[0]) || '.tmp'}`;
  const filePath = path.join(TEMP_DIR, fileName);

  try {
    // Download file with retry mechanism
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

          // Check content type
          const contentType = response.headers['content-type'];
          if (!contentType || contentType.includes('text/html')) {
            throw new Error('Invalid content type received');
          }

          // Save file
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

    // Upload to Catbox with retry
    const uploadToCatbox = async (retryCount = 3) => {
      for (let i = 0; i < retryCount; i++) {
        try {
          const form = new FormData();
          form.append('reqtype', 'fileupload');
          form.append('fileToUpload', await fs.readFile(filePath));

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

          // Validate Catbox response
          if (!uploadResponse.data || uploadResponse.data.includes('error')) {
            throw new Error('Catbox upload failed');
          }

          return uploadResponse.data;
        } catch (error) {
          if (i === retryCount - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    };

    const result = await uploadToCatbox();

    // Cleanup
    await fs.unlink(filePath).catch(() => {});

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    // Enhanced error handling
    await fs.unlink(filePath).catch(() => {});

    let statusCode = 500;
    let errorMessage = 'Internal server error';

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = error.response.status === 412 
        ? 'Precondition Failed: Invalid or blocked URL'
        : error.response.data?.message || error.message;
    } else if (error.request) {
      errorMessage = 'No response received from the server';
    } else {
      errorMessage = error.message;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Periodic cleanup of temp directory
setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      // Delete files older than 1 hour
      if (now - stats.mtimeMs > 3600000) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    console.error('Error cleaning temp directory:', error);
  }
}, 3600000); // Run every hour

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({
    success: false,
    error: 'Unexpected server error',
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
