import express from "express";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const app = express();

const PORT = process.env.PORT || 3000;

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Test channel/message
const CHANNEL_ID = "-1004305906553";
const MESSAGE_ID = 6;

const MAX_CHUNK = 1024 * 1024; // 1 MB

let client = null;
let videoMessage = null;
let starting = null;

async function getClient() {
  if (client && client.connected) {
    return client;
  }

  if (starting) {
    return starting;
  }

  starting = (async () => {
    if (!API_ID || !API_HASH || !BOT_TOKEN) {
      throw new Error("Telegram environment variables are missing");
    }

    client = new TelegramClient(
      new StringSession(""),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5
      }
    );

    await client.start({
      botAuthToken: BOT_TOKEN
    });

    return client;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function getVideoMessage() {
  if (videoMessage) {
    return videoMessage;
  }

  const tg = await getClient();

  // Convert Bot API channel ID to MTProto channel ID.
  const mtprotoChannelId =
    BigInt(-CHANNEL_ID) - 1000000000000n;

  const result = await tg.invoke(
    new Api.channels.GetChannels({
      id: [
        new Api.InputChannel({
          channelId: mtprotoChannelId,
          accessHash: 0n
        })
      ]
    })
  );

  const channel = result.chats?.[0];

  if (!channel) {
    throw new Error(
      "Telegram channel could not be resolved."
    );
  }

  const messages = await tg.invoke(
    new Api.channels.GetMessages({
      channel: new Api.InputChannel({
        channelId: channel.id,
        accessHash: channel.accessHash
      }),
      id: [
        new Api.InputMessageID({
          id: MESSAGE_ID
        })
      ]
    })
  );

  const message = messages.messages?.[0];

  if (!message || !message.media) {
    throw new Error(
      "Test video message not found."
    );
  }

  videoMessage = message;

  return message;
}

app.get("/health", async (req, res) => {
  try {
    const tg = await getClient();

    res.json({
      success: true,
      server: "Sayeed Video Lab",
      telegram: "connected",
      bot: await tg.isBot()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


app.get("/video", async (req, res) => {

  try {

    const message = await getVideoMessage();

    const media = message.media;

    const document = media.document;

    if (!document) {
      return res.status(400).json({
        error: "Telegram message does not contain a document/video."
      });
    }

    const fileSize = Number(document.size);

    const mimeType =
      document.mimeType || "video/mp4";

    const range = req.headers.range;

    let start = 0;
    let requestedEnd = fileSize - 1;

    if (range) {

      const match = range.match(/bytes=(\d+)-(\d*)/);

      if (!match) {
        return res.status(416).end();
      }

      start = Number(match[1]);

      if (match[2]) {
        requestedEnd = Number(match[2]);
      }

      if (start >= fileSize) {
        return res.status(416).end();
      }
    }

    // Only serve up to 1 MB per request.
    const end = Math.min(
      requestedEnd,
      start + MAX_CHUNK - 1,
      fileSize - 1
    );

    const requestedLength = end - start + 1;

    /*
     * Telegram precise download requires
     * offsets/limits aligned to 1 KB.
     */

    const alignedStart =
      Math.floor(start / 1024) * 1024;

    const extraBefore =
      start - alignedStart;

    const telegramLength = Math.min(
      MAX_CHUNK,
      Math.ceil(
        (extraBefore + requestedLength) / 1024
      ) * 1024
    );

    const tg = await getClient();

    res.status(range ? 206 : 200);

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", requestedLength);
    res.setHeader(
      "Content-Range",
      `bytes ${start}-${end}/${fileSize}`
    );

    res.setHeader(
      "Cache-Control",
      "private, no-store"
    );

    let sent = 0;

    for await (
      const chunk of tg.iterDownload({
        file: media,
        offset: alignedStart,
        limit: telegramLength,
        requestSize: 1024 * 1024
      })
    ) {

      const buffer = Buffer.from(chunk);

      const from = sent === 0
        ? extraBefore
        : 0;

      const available =
        buffer.length - from;

      const remaining =
        requestedLength - sent;

      const take =
        Math.min(available, remaining);

      if (take > 0) {
        res.write(buffer.subarray(from, from + take));
        sent += take;
      }

      if (sent >= requestedLength) {
        break;
      }
    }

    res.end();

  } catch (error) {

    console.error("VIDEO ERROR:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message
      });
    } else {
      res.destroy(error);
    }
  }
});


app.listen(PORT, () => {
  console.log(
    `Sayeed Video Lab server running on port ${PORT}`
  );
});
