export default async function handler(req, res) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      return res.status(500).json({
        success: false,
        error: "TELEGRAM_BOT_TOKEN is not configured"
      });
    }

    // Get the latest updates from Telegram.
    // Negative offset starts from the end of the update queue.
    const url =
      `https://api.telegram.org/bot${token}/getUpdates` +
      `?offset=-100` +
      `&limit=100` +
      `&allowed_updates=%5B%22channel_post%22%5D`;

    const response = await fetch(url, {
      cache: "no-store"
    });

    const data = await response.json();

    if (!data.ok) {
      return res.status(500).json({
        success: false,
        error: data.description || "Telegram API error"
      });
    }

    const updates = data.result || [];

    // Search from newest update to oldest.
    for (let i = updates.length - 1; i >= 0; i--) {
      const post = updates[i]?.channel_post;

      if (!post) continue;

      // Normal Telegram video
      if (post.video) {
        return res.status(200).json({
          success: true,

          channel: {
            id: post.chat?.id || null,
            title: post.chat?.title || null,
            username: post.chat?.username || null
          },

          message: {
            id: post.message_id || null,
            date: post.date || null
          },

          video: {
            file_id: post.video.file_id || null,
            file_unique_id:
              post.video.file_unique_id || null,
            file_size:
              post.video.file_size || 0,
            duration:
              post.video.duration || 0,
            width:
              post.video.width || 0,
            height:
              post.video.height || 0,
            file_name:
              post.video.file_name || "telegram-video"
          }
        });
      }
    }

    return res.status(200).json({
      success: true,
      video: null,
      message: "No video channel post found.",
      updates_received: updates.length
    });

  } catch (error) {
    console.error("Telegram API error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Server error"
    });
  }
}
