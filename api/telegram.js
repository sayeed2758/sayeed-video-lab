export default async function handler(req, res) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      return res.status(500).json({
        error: "TELEGRAM_BOT_TOKEN is not configured"
      });
    }

    const url =
      `https://api.telegram.org/bot${token}/getUpdates?limit=20`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.ok) {
      return res.status(500).json({
        error: data.description || "Telegram API error"
      });
    }

    const updates = data.result || [];

    // Search newest channel post containing a video
    for (let i = updates.length - 1; i >= 0; i--) {
      const post = updates[i].channel_post;

      if (post && post.video) {
        return res.status(200).json({
          success: true,
          video: {
            file_id: post.video.file_id,
            file_size: post.video.file_size || 0,
            duration: post.video.duration || 0,
            width: post.video.width || 0,
            height: post.video.height || 0,
            file_name: post.video.file_name || "test-video"
          }
        });
      }
    }

    return res.status(200).json({
      success: true,
      video: null,
      message: "No video channel post found yet."
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
}
