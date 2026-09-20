import express from "express";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";

const app = express();

const PORT = process.env.PORT || 10000;

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const CHANNEL_ID = "-1004305906553";

// Scan first 200 message IDs for this POC.
// Telegram channels can return up to 200 message IDs per request.
const SCAN_FROM = 1;
const SCAN_TO = 200;

const stringSession = new StringSession("");

let tgClient = null;
let cachedChannel = null;
let cachedVideoMessage = null;


// ==================================================
// TELEGRAM CLIENT
// ==================================================

async function getClient() {
  if (tgClient && tgClient.connected) {
    return tgClient;
  }

  tgClient = new TelegramClient(
    stringSession,
    API_ID,
    API_HASH,
    {
      connectionRetries: 5,
    }
  );

  await tgClient.start({
    botAuthToken: BOT_TOKEN,
  });

  console.log("Telegram MTProto connected.");

  return tgClient;
}


// ==================================================
// GET CHANNEL
// ==================================================

async function getChannel() {
  if (cachedChannel) {
    return cachedChannel;
  }

  const tg = await getClient();

  const mtprotoChannelId =
    BigInt(-CHANNEL_ID) - 1000000000000n;

  const result = await tg.invoke(
    new Api.channels.GetChannels({
      id: [
        new Api.InputChannel({
          channelId: mtprotoChannelId,
          accessHash: 0n,
        }),
      ],
    })
  );

  const channel = result.chats?.[0];

  if (!channel) {
    throw new Error(
      "Telegram channel could not be resolved."
    );
  }

  cachedChannel = channel;

  console.log(
    `Channel resolved: ${channel.title || channel.id}`
  );

  return channel;
}


// ==================================================
// FIND LATEST VIDEO
// ==================================================

async function findLatestVideoMessage() {
  if (cachedVideoMessage) {
    return cachedVideoMessage;
  }

  const tg = await getClient();
  const channel = await getChannel();

  const messageIds = [];

  for (
    let id = SCAN_FROM;
    id <= SCAN_TO;
    id++
  ) {
    messageIds.push(
      new Api.InputMessageID({
        id,
      })
    );
  }

  console.log(
    `Scanning Telegram messages ${SCAN_FROM}-${SCAN_TO}...`
  );

  const result = await tg.invoke(
    new Api.channels.GetMessages({
      channel: new Api.InputChannel({
        channelId: channel.id,
        accessHash: channel.accessHash,
      }),
      id: messageIds,
    })
  );

  const messages = result.messages || [];

  const videos = messages.filter((message) => {
    return (
      message &&
      message.media &&
      message.media.document &&
      message.media.document.mimeType &&
      message.media.document.mimeType.startsWith(
        "video/"
      )
    );
  });

  if (videos.length === 0) {
    throw new Error(
      "No video found in scanned Telegram messages."
    );
  }

  videos.sort(
    (a, b) =>
      Number(b.id) - Number(a.id)
  );

  const latestVideo = videos[0];

  cachedVideoMessage = latestVideo;

  const document =
    latestVideo.media.document;

  console.log(
    `Latest video found: message=${latestVideo.id}, size=${document.size}`
  );

  return latestVideo;
}


// ==================================================
// HEALTH
// ==================================================

app.get("/health", async (req, res) => {
  try {
    await getClient();

    res.json({
      success: true,
      server: "Sayeed Video Lab",
      telegram: "connected",
      bot: true,
    });

  } catch (error) {
    console.error(
      "HEALTH ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


// ==================================================
// LATEST VIDEO INFO
// ==================================================

app.get("/latest", async (req, res) => {
  try {
    const message =
      await findLatestVideoMessage();

    const document =
      message.media.document;

    res.json({
      success: true,

      messageId: Number(message.id),

      fileSize: Number(document.size),

      fileSizeMB:
        Number(document.size) /
        (1024 * 1024),

      mimeType:
        document.mimeType || null,

      fileName:
        document.attributes
          ?.find(
            (attribute) =>
              attribute.className ===
              "DocumentAttributeFilename"
          )
          ?.fileName || null,
    });

  } catch (error) {
    console.error(
      "LATEST ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


// ==================================================
// VIDEO STREAM
// ==================================================

app.get("/video", async (req, res) => {
  try {
    const tg = await getClient();

    const message =
      await findLatestVideoMessage();

    const document =
      message.media.document;

    const fileSize =
      Number(document.size);

    if (!fileSize || fileSize <= 0) {
      throw new Error(
        "Invalid Telegram video file size."
      );
    }

    const range =
      req.headers.range;

    let start = 0;
    let end = fileSize - 1;
    let statusCode = 200;

    // ----------------------------------------------
    // RANGE
    // ----------------------------------------------

    if (range) {
      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (match) {
        if (match[1]) {
          start =
            Number(match[1]);
        }

        if (match[2]) {
          end =
            Number(match[2]);
        }

        // bytes=-500000
        if (
          !match[1] &&
          match[2]
        ) {
          const suffix =
            Number(match[2]);

          start = Math.max(
            fileSize - suffix,
            0
          );

          end =
            fileSize - 1;
        }

        if (
          start > end ||
          start >= fileSize
        ) {
          res.status(416);

          res.setHeader(
            "Content-Range",
            `bytes */${fileSize}`
          );

          return res.end();
        }

        end = Math.min(
          end,
          fileSize - 1
        );

        statusCode = 206;
      }
    }

    const contentLength =
      end - start + 1;

    // ----------------------------------------------
    // HEADERS
    // ----------------------------------------------

    res.status(statusCode);

    res.setHeader(
      "Content-Type",
      document.mimeType ||
        "video/mp4"
    );

    res.setHeader(
      "Accept-Ranges",
      "bytes"
    );

    res.setHeader(
      "Content-Length",
      contentLength
    );

    if (statusCode === 206) {
      res.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${fileSize}`
      );
    }

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    // ----------------------------------------------
    // TELEGRAM STREAM
    // ----------------------------------------------

    const CHUNK_SIZE =
      512 * 1024;

    const offset =
      bigInt(start);

    const requestedBytes =
      contentLength;

    const chunkCount =
      Math.ceil(
        requestedBytes /
          CHUNK_SIZE
      );

    console.log(
      `Streaming message ${message.id}: ${start}-${end}/${fileSize}`
    );

    console.log(
      `Chunks required: ${chunkCount}`
    );

    let bytesSent = 0;

    const iterator =
      tg.iterDownload({
        file: message.media,
        offset,
        requestSize:
          CHUNK_SIZE,
        chunkSize:
          CHUNK_SIZE,
        limit:
          chunkCount,
        fileSize:
          bigInt(fileSize),
      });

    for await (
      const chunk of iterator
    ) {
      if (res.destroyed) {
        break;
      }

      const remaining =
        requestedBytes -
        bytesSent;

      if (remaining <= 0) {
        break;
      }

      let outputChunk =
        chunk;

      if (
        chunk.length >
        remaining
      ) {
        outputChunk =
          chunk.subarray(
            0,
            remaining
          );
      }

      res.write(
        outputChunk
      );

      bytesSent +=
        outputChunk.length;

      if (
        bytesSent >=
        requestedBytes
      ) {
        break;
      }
    }

    console.log(
      `Stream finished: ${bytesSent} bytes`
    );

    res.end();

  } catch (error) {
    console.error(
      "VIDEO ERROR:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    } else {
      res.destroy();
    }
  }
});


// ==================================================
// START
// ==================================================

app.listen(PORT, () => {
  console.log(
    `Sayeed Video Lab server running on port ${PORT}`
  );
});
