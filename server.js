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
const MESSAGE_ID = 6;

const stringSession = new StringSession("");

let tgClient = null;
let videoMessage = null;

// --------------------------------------------------
// TELEGRAM CLIENT
// --------------------------------------------------

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

// --------------------------------------------------
// GET VIDEO MESSAGE
// --------------------------------------------------

async function getVideoMessage() {
  if (videoMessage) {
    return videoMessage;
  }

  const tg = await getClient();

  const mtprotoChannelId =
    BigInt(-CHANNEL_ID) - 1000000000000n;

  const channelResult = await tg.invoke(
    new Api.channels.GetChannels({
      id: [
        new Api.InputChannel({
          channelId: mtprotoChannelId,
          accessHash: 0n,
        }),
      ],
    })
  );

  const channel = channelResult.chats?.[0];

  if (!channel) {
    throw new Error(
      "Telegram channel could not be resolved."
    );
  }

  const messagesResult = await tg.invoke(
    new Api.channels.GetMessages({
      channel: new Api.InputChannel({
        channelId: channel.id,
        accessHash: channel.accessHash,
      }),
      id: [
        new Api.InputMessageID({
          id: MESSAGE_ID,
        }),
      ],
    })
  );

  const message = messagesResult.messages?.[0];

  if (!message) {
    throw new Error(
      "Telegram video message not found."
    );
  }

  if (!message.media) {
    throw new Error(
      "Telegram message does not contain media."
    );
  }

  videoMessage = message;

  return message;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

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
    console.error("HEALTH ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// --------------------------------------------------
// VIDEO STREAM
// --------------------------------------------------

app.get("/video", async (req, res) => {
  try {
    const tg = await getClient();
    const message = await getVideoMessage();

    const document =
      message.media?.document;

    if (!document) {
      throw new Error(
        "Telegram message does not contain a video document."
      );
    }

    const fileSize = Number(document.size);

    if (!fileSize || fileSize <= 0) {
      throw new Error(
        "Invalid Telegram video file size."
      );
    }

    // ------------------------------------------------
    // RANGE REQUEST
    // ------------------------------------------------

    const range = req.headers.range;

    let start = 0;
    let end = fileSize - 1;
    let statusCode = 200;

    if (range) {
      const match = range.match(
        /bytes=(\d*)-(\d*)/
      );

      if (match) {
        if (match[1]) {
          start = Number(match[1]);
        }

        if (match[2]) {
          end = Number(match[2]);
        } else {
          end = fileSize - 1;
        }

        // Handle suffix range: bytes=-500000
        if (!match[1] && match[2]) {
          const suffixLength = Number(match[2]);

          start = Math.max(
            fileSize - suffixLength,
            0
          );

          end = fileSize - 1;
        }

        if (start > end || start >= fileSize) {
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

    // ------------------------------------------------
    // HEADERS
    // ------------------------------------------------

    res.status(statusCode);

    res.setHeader(
      "Content-Type",
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

    // ------------------------------------------------
    // TELEGRAM DOWNLOAD
    // ------------------------------------------------

    const CHUNK_SIZE = 512 * 1024;

    const offset = bigInt(start);

    const requestedBytes =
      contentLength;

    const chunkCount = Math.ceil(
      requestedBytes / CHUNK_SIZE
    );

    console.log(
      `Streaming video: ${start}-${end} / ${fileSize}`
    );

    console.log(
      `Chunks required: ${chunkCount}`
    );

    let bytesSent = 0;

    const iterator =
      tg.iterDownload({
        file: message.media,
        offset: offset,
        requestSize: CHUNK_SIZE,
        chunkSize: CHUNK_SIZE,
        limit: chunkCount,
        fileSize: bigInt(fileSize),
      });

    for await (const chunk of iterator) {
      if (res.destroyed) {
        break;
      }

      const remaining =
        requestedBytes - bytesSent;

      if (remaining <= 0) {
        break;
      }

      let outputChunk = chunk;

      if (chunk.length > remaining) {
        outputChunk =
          chunk.subarray(
            0,
            remaining
          );
      }

      res.write(outputChunk);

      bytesSent +=
        outputChunk.length;

      if (
        bytesSent >= requestedBytes
      ) {
        break;
      }
    }

    console.log(
      `Video stream finished: ${bytesSent} bytes sent`
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

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Sayeed Video Lab server running on port ${PORT}`
  );
});
