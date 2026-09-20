import express from "express";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";

const app = express();

// ==================================================
// CORS
// ==================================================

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Range, Content-Type"
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 10000;

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const CHANNEL_ID = "-1004305906553";

// POC library scan range
const SCAN_FROM = 1;
const SCAN_TO = 200;

const stringSession = new StringSession("");

let tgClient = null;
let cachedChannel = null;


// ==================================================
// TELEGRAM CLIENT
// ==================================================

async function getClient() {
  if (tgClient && tgClient.connected) {
    return tgClient;
  }

  if (!API_ID || !API_HASH || !BOT_TOKEN) {
    throw new Error(
      "Telegram environment variables are missing."
    );
  }

  tgClient = new TelegramClient(
    stringSession,
    API_ID,
    API_HASH,
    {
      connectionRetries: 5
    }
  );

  await tgClient.start({
    botAuthToken: BOT_TOKEN
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

  cachedChannel = channel;

  console.log(
    `Channel resolved: ${channel.title || channel.id}`
  );

  return channel;
}


// ==================================================
// PARSE VIDEO METADATA
// ==================================================

function parseVideoMetadata(message) {
  const text = message?.message || "";

  const course =
    text.match(/^COURSE:\s*(.+)$/im)?.[1]?.trim() ||
    null;

  const module =
    text.match(/^MODULE:\s*(.+)$/im)?.[1]?.trim() ||
    null;

  const video =
    text.match(/^VIDEO:\s*(.+)$/im)?.[1]?.trim() ||
    null;

  const title =
    text.match(/^TITLE:\s*(.+)$/im)?.[1]?.trim() ||
    null;

  return {
    course,
    module,
    video,
    title
  };
}


// ==================================================
// GET DOCUMENT FILE NAME
// ==================================================

function getDocumentFileName(document) {
  const attribute =
    document.attributes?.find(
      (item) =>
        item.className ===
        "DocumentAttributeFilename"
    );

  return attribute?.fileName || null;
}


// ==================================================
// GET VIDEO MESSAGE BY MESSAGE ID
// ==================================================

async function getVideoMessage(messageId) {
  const tg = await getClient();
  const channel = await getChannel();

  const numericMessageId = Number(messageId);

  if (
    !Number.isInteger(numericMessageId) ||
    numericMessageId <= 0
  ) {
    throw new Error(
      "Invalid Telegram message ID."
    );
  }

  const result = await tg.invoke(
    new Api.channels.GetMessages({
      channel: new Api.InputChannel({
        channelId: channel.id,
        accessHash: channel.accessHash
      }),

      id: [
        new Api.InputMessageID({
          id: numericMessageId
        })
      ]
    })
  );

  const message = result.messages?.[0];

  if (!message) {
    throw new Error(
      `Telegram message ${numericMessageId} not found.`
    );
  }

  if (
    !message.media ||
    !message.media.document
  ) {
    throw new Error(
      `Message ${numericMessageId} does not contain a video document.`
    );
  }

  const mimeType =
    message.media.document.mimeType || "";

  if (!mimeType.startsWith("video/")) {
    throw new Error(
      `Message ${numericMessageId} is not a video.`
    );
  }

  return message;
}


// ==================================================
// FIND LATEST VIDEO MESSAGE
// ==================================================

async function findLatestVideoMessage() {
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
        id
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
        accessHash: channel.accessHash
      }),

      id: messageIds
    })
  );

  const messages =
    result.messages || [];

  const videos =
    messages.filter((message) => {
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

  const latestVideo =
    videos[0];

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
      bot: true
    });

  } catch (error) {
    console.error(
      "HEALTH ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message
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

    const metadata =
      parseVideoMetadata(message);

    res.json({
      success: true,

      messageId:
        Number(message.id),

      metadata,

      file: {
        fileSize:
          Number(document.size),

        fileSizeMB:
          Number(document.size) /
          (1024 * 1024),

        mimeType:
          document.mimeType || null,

        fileName:
          getDocumentFileName(
            document
          )
      }
    });

  } catch (error) {
    console.error(
      "LATEST ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ==================================================
// VIDEO LIBRARY
// ==================================================

app.get("/library", async (req, res) => {
  try {
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
          id
        })
      );
    }

    console.log(
      `Scanning messages ${SCAN_FROM}-${SCAN_TO} for video library...`
    );

    const result = await tg.invoke(
      new Api.channels.GetMessages({
        channel: new Api.InputChannel({
          channelId: channel.id,
          accessHash: channel.accessHash
        }),

        id: messageIds
      })
    );

    const messages =
      result.messages || [];

    const videos =
      messages
        .filter((message) => {
          return (
            message &&
            message.media &&
            message.media.document &&
            message.media.document.mimeType &&
            message.media.document.mimeType.startsWith(
              "video/"
            )
          );
        })
        .map((message) => {
          const document =
            message.media.document;

          const metadata =
            parseVideoMetadata(
              message
            );

          return {
            messageId:
              Number(message.id),

            metadata: {
              course:
                metadata.course,

              module:
                metadata.module,

              videoId:
                metadata.video,

              title:
                metadata.title
            },

            file: {
              size:
                Number(document.size),

              sizeMB:
                Number(document.size) /
                (1024 * 1024),

              mimeType:
                document.mimeType ||
                null,

              fileName:
                getDocumentFileName(
                  document
                )
            }
          };
        })
        .filter((video) => {
          return (
            video.metadata.course &&
            video.metadata.module &&
            video.metadata.videoId &&
            video.metadata.title
          );
        })
        .sort(
          (a, b) =>
            a.messageId -
            b.messageId
        );

    res.json({
      success: true,

      count:
        videos.length,

      videos
    });

  } catch (error) {
    console.error(
      "LIBRARY ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ==================================================
// VIDEO STREAM
//
// Examples:
//
// /video?messageId=19
// /video?messageId=20
//
// Without messageId:
// /video
// -> latest video
// ==================================================

app.get("/video", async (req, res) => {
  try {
    const tg =
      await getClient();

    const requestedMessageId =
      req.query.messageId;

    let message;

    if (
      requestedMessageId !==
      undefined
    ) {
      message =
        await getVideoMessage(
          requestedMessageId
        );
    } else {
      message =
        await findLatestVideoMessage();
    }

    const document =
      message.media.document;

    const fileSize =
      Number(document.size);

    if (
      !fileSize ||
      fileSize <= 0
    ) {
      throw new Error(
        "Invalid Telegram video file size."
      );
    }

    // ----------------------------------------------
    // RANGE REQUEST
    // ----------------------------------------------

    const range =
      req.headers.range;

    let start = 0;
    let end =
      fileSize - 1;

    let statusCode = 200;

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

        // Suffix range:
        // bytes=-500000
        if (
          !match[1] &&
          match[2]
        ) {
          const suffixLength =
            Number(match[2]);

          start = Math.max(
            fileSize -
              suffixLength,
            0
          );

          end =
            fileSize - 1;
        }

        if (
          start < 0 ||
          start >= fileSize ||
          start > end
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
    // RESPONSE HEADERS
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

    if (
      statusCode === 206
    ) {
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
        file:
          message.media,

        offset,

        requestSize:
          CHUNK_SIZE,

        chunkSize:
          CHUNK_SIZE,

        limit:
          chunkCount,

        fileSize:
          bigInt(fileSize)
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

      if (
        remaining <= 0
      ) {
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
        error:
          error.message
      });
    } else {
      res.destroy();
    }
  }
});


// ==================================================
// START SERVER
// ==================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Sayeed Video Lab server running on port ${PORT}`
    );
  }
);
