export default async function handler(req, res) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const fileId = req.query.file_id;

    if (!token) {
      return res.status(500).json({
        error: "TELEGRAM_BOT_TOKEN is not configured"
      });
    }

    if (!fileId) {
      return res.status(400).json({
        error: "file_id is required"
      });
    }

    // Ask Telegram for the file path
    const fileInfoResponse = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
    );

    const fileInfo = await fileInfoResponse.json();

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      return res.status(500).json({
        error: fileInfo.description || "Unable to get Telegram file"
      });
    }

    const filePath = fileInfo.result.file_path;

    // Download the file from Telegram
    const telegramFileResponse = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`
    );

    if (!telegramFileResponse.ok) {
      return res.status(500).json({
        error: "Unable to download video from Telegram"
      });
    }

    const contentType =
      telegramFileResponse.headers.get("content-type") ||
      "video/mp4";

    const buffer = Buffer.from(
      await telegramFileResponse.arrayBuffer()
    );

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "private, no-store");

    return res.status(200).send(buffer);

  } catch (error) {
    return res.status(500).json({
      error: error.message || "Video proxy error"
    });
  }
}
