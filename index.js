const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

// Middleware để parse JSON
app.use(express.json());

// Route API upload
app.get('/upload', async (req, res) => {
  const { url } = req.query;

  // Kiểm tra xem url có được cung cấp không
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Gửi yêu cầu tới Catbox API
    const response = await axios.post('https://catbox.moe/user/api.php', {
      reqtype: 'urlupload',
      url: url
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // Trả về kết quả từ Catbox
    res.json({
      success: true,
      data: response.data
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
