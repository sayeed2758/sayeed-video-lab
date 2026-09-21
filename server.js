import express from "express";
import crypto from "node:crypto";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const app = express();

// ==================================================
// BASIC CONFIG
// ==================================================

const PORT = Number(process.env.PORT || 10000);
const WEBSITE_ORIGIN = String(
  process.env.WEBSITE_ORIGIN || "*"
).trim();
const VIDEO_SECURITY_MODE = String(
  process.env.VIDEO_SECURITY_MODE || "test"
).trim().toLowerCase();
const PLAYBACK_SIGNING_SECRET = String(
  process.env.PLAYBACK_SIGNING_SECRET || ""
).trim();
const PLAYBACK_TOKEN_TTL_SECONDS = Math.min(
  Math.max(Number(process.env.PLAYBACK_TOKEN_TTL_SECONDS || 600), 60),
  1800
);

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const CHANNEL_ID = "-1004305906553";

// Current POC scan range. We will replace this with a production index/cache later.
const SCAN_FROM = 1;
const SCAN_TO = 200;
const COURSE_CACHE_TTL_MS = 30_000;

const stringSession = new StringSession("");

let tgClient = null;
let cachedChannel = null;
let firebaseReady = false;
let courseCache = {
  data: null,
  expiresAt: 0,
  promise: null
};

// ==================================================
// CORS
// ==================================================

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    WEBSITE_ORIGIN
  );

  res.setHeader(
    "Vary",
    "Origin"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Range, Content-Type"
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

app.disable("x-powered-by");

// ==================================================
// HELPERS
// ==================================================

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requirePlaybackSigningSecret() {
  if (PLAYBACK_SIGNING_SECRET.length < 32) {
    throw new Error(
      "PLAYBACK_SIGNING_SECRET is not configured or is too short. Use a random secret of at least 32 characters."
    );
  }
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPlaybackPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", PLAYBACK_SIGNING_SECRET)
    .update(encodedPayload)
    .digest("base64url");
}

function createPlaybackToken({ courseId, messageId, uid }) {
  requirePlaybackSigningSecret();
  const payload = {
    courseId: String(courseId),
    messageId: Number(messageId),
    uid: String(uid),
    exp: Math.floor(Date.now() / 1000) + PLAYBACK_TOKEN_TTL_SECONDS
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPlaybackPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyPlaybackToken(token) {
  requirePlaybackSigningSecret();
  if (!token || typeof token !== "string") {
    throw httpError("Playback token is required.", 401);
  }
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    throw httpError("Invalid playback token.", 401);
  }
  const expected = signPlaybackPayload(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw httpError("Invalid playback token.", 401);
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw httpError("Invalid playback token.", 401);
  }
  if (!payload?.courseId || !payload?.uid || !Number.isInteger(Number(payload.messageId)) || Number(payload.messageId) <= 0) {
    throw httpError("Invalid playback token.", 401);
  }
  if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
    throw httpError("Playback token has expired. Start playback again.", 401);
  }
  return payload;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function requireTelegramConfig() {
  if (!API_ID || !API_HASH || !BOT_TOKEN) {
    throw new Error(
      "Telegram environment variables are missing."
    );
  }
}

function getFirebaseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not configured."
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON."
    );
  }
}

function getFirebaseAdmin() {
  if (firebaseReady) return;

  if (getApps().length === 0) {
    initializeApp({
      credential: cert(getFirebaseServiceAccount())
    });
  }

  firebaseReady = true;
}

async function verifyFirebaseUser(req) {
  getFirebaseAdmin();

  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    throw httpError(
      "Authentication required.",
      401
    );
  }

  const idToken = authorization
    .slice("Bearer ".length)
    .trim();

  if (!idToken) {
    throw httpError(
      "Authentication token is missing.",
      401
    );
  }

  try {
    return await getAuth().verifyIdToken(idToken);
  } catch {
    throw httpError(
      "Invalid or expired Firebase authentication token.",
      401
    );
  }
}

async function checkCourseEnrollment(uid, courseId) {
  if (!uid) {
    throw httpError("User ID is required.", 400);
  }

  if (!courseId) {
    throw httpError("courseId is required.", 400);
  }

  getFirebaseAdmin();

  const snapshot = await getFirestore()
    .collection("enrollments")
    .where("userId", "==", String(uid))
    .where("courseId", "==", String(courseId))
    .limit(1)
    .get();

  return !snapshot.empty;
}

async function requireCourseEnrollment(req, courseId) {
  const decoded = await verifyFirebaseUser(req);
  const enrolled = await checkCourseEnrollment(
    decoded.uid,
    courseId
  );

  if (!enrolled) {
    throw httpError(
      "You are not enrolled in this course.",
      403
    );
  }

  return decoded;
}

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

function getDocumentFileName(document) {
  const attribute = document.attributes?.find(
    (item) =>
      item.className ===
      "DocumentAttributeFilename"
  );

  return attribute?.fileName || null;
}

function isVideoMessage(message) {
  return Boolean(
    message?.media?.document?.mimeType?.startsWith("video/")
  );
}

function toVideoRecord(message) {
  const document = message.media.document;
  const metadata = parseVideoMetadata(message);

  return {
    messageId: Number(message.id),

    metadata: {
      course: metadata.course,
      module: metadata.module,
      videoId: metadata.video,
      title: metadata.title
    },

    file: {
      size: Number(document.size),
      sizeMB:
        Number(document.size) / (1024 * 1024),
      mimeType: document.mimeType || null,
      fileName: getDocumentFileName(document)
    }
  };
}

function hasCompleteMetadata(video) {
  return Boolean(
    video.metadata.course &&
    video.metadata.module &&
    video.metadata.videoId &&
    video.metadata.title
  );
}

// ==================================================
// TELEGRAM CLIENT
// ==================================================

async function getClient() {
  if (tgClient && tgClient.connected) {
    return tgClient;
  }

  requireTelegramConfig();

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
// GET VIDEO MESSAGE
// ==================================================

async function getVideoMessage(messageId) {
  const tg = await getClient();
  const channel = await getChannel();

  const numericMessageId = Number(messageId);

  if (
    !Number.isInteger(numericMessageId) ||
    numericMessageId <= 0
  ) {
    throw httpError(
      "Invalid Telegram message ID.",
      400
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
    throw httpError(
      `Telegram message ${numericMessageId} not found.`,
      404
    );
  }

  if (!isVideoMessage(message)) {
    throw httpError(
      `Message ${numericMessageId} is not a video.`,
      400
    );
  }

  return message;
}

// ==================================================
// SCAN TELEGRAM VIDEO MESSAGES
// ==================================================

async function scanVideoMessages() {
  const tg = await getClient();
  const channel = await getChannel();

  const messageIds = [];

  for (let id = SCAN_FROM; id <= SCAN_TO; id++) {
    messageIds.push(
      new Api.InputMessageID({ id })
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

  return (result.messages || [])
    .filter(isVideoMessage)
    .map(toVideoRecord);
}

async function getCachedVideoLibrary(force = false) {
  const now = Date.now();

  if (
    !force &&
    courseCache.data &&
    now < courseCache.expiresAt
  ) {
    return courseCache.data;
  }

  if (!force && courseCache.promise) {
    return courseCache.promise;
  }

  courseCache.promise = scanVideoMessages()
    .then((videos) => {
      courseCache = {
        data: videos,
        expiresAt: Date.now() + COURSE_CACHE_TTL_MS,
        promise: null
      };

      return videos;
    })
    .catch((error) => {
      courseCache.promise = null;
      throw error;
    });

  return courseCache.promise;
}

async function findLatestVideoMessage() {
  const videos = await getCachedVideoLibrary();

  if (videos.length === 0) {
    throw httpError(
      "No video found in scanned Telegram messages.",
      404
    );
  }

  videos.sort(
    (a, b) => b.messageId - a.messageId
  );

  return getVideoMessage(videos[0].messageId);
}

function buildCourseCatalogue(videos) {
  const validVideos = videos.filter(hasCompleteMetadata);
  const courseMap = new Map();

  for (const video of validVideos) {
    const courseName = video.metadata.course;
    const moduleName = video.metadata.module;

    if (!courseMap.has(courseName)) {
      courseMap.set(courseName, {
        course: courseName,
        modules: new Map()
      });
    }

    const course = courseMap.get(courseName);

    if (!course.modules.has(moduleName)) {
      course.modules.set(moduleName, {
        module: moduleName,
        videos: []
      });
    }

    const module = course.modules.get(moduleName);

    module.videos.push({
      messageId: video.messageId,
      videoId: video.metadata.videoId,
      title: video.metadata.title,
      file: {
        size: video.file.size,
        sizeMB: video.file.sizeMB,
        mimeType: video.file.mimeType,
        fileName: video.file.fileName
      }
    });
  }

  const courses = Array.from(courseMap.values())
    .map((course) => {
      const modules = Array.from(course.modules.values())
        .map((module) => ({
          ...module,
          videos: module.videos.sort(
            (a, b) => a.messageId - b.messageId
          )
        }))
        .sort((a, b) =>
          String(a.module).localeCompare(String(b.module), undefined, {
            numeric: true,
            sensitivity: "base"
          })
        );

      return {
        course: course.course,
        moduleCount: modules.length,
        videoCount: modules.reduce(
          (total, module) => total + module.videos.length,
          0
        ),
        modules
      };
    })
    .sort((a, b) =>
      String(a.course).localeCompare(String(b.course), undefined, {
        sensitivity: "base"
      })
    );

  return {
    courseCount: courses.length,
    videoCount: validVideos.length,
    courses
  };
}

async function streamTelegramVideo(req, res, message) {
  const tg = await getClient();
  const document = message.media.document;
  const fileSize = Number(document.size);

  if (!fileSize || fileSize <= 0) {
    throw new Error(
      "Invalid Telegram video file size."
    );
  }

  const range = req.headers.range;
  let start = 0;
  let end = fileSize - 1;
  let statusCode = 200;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);

    if (!match) {
      throw httpError("Invalid Range header.", 416);
    }

    if (match[1]) {
      start = Number(match[1]);
    }

    if (match[2]) {
      end = Number(match[2]);
    }

    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2]);

      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        throw httpError("Invalid Range header.", 416);
      }

      start = Math.max(fileSize - suffixLength, 0);
      end = fileSize - 1;
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

    end = Math.min(end, fileSize - 1);
    statusCode = 206;
  }

  const contentLength = end - start + 1;

  res.status(statusCode);
  res.setHeader(
    "Content-Type",
    document.mimeType || "video/mp4"
  );
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", contentLength);

  if (statusCode === 206) {
    res.setHeader(
      "Content-Range",
      `bytes ${start}-${end}/${fileSize}`
    );
  }

  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate"
  );

  const CHUNK_SIZE = 512 * 1024;
  const offset = bigInt(start);
  const requestedBytes = contentLength;
  const chunkCount = Math.ceil(
    requestedBytes / CHUNK_SIZE
  );

  console.log(
    `Streaming message ${message.id}: ${start}-${end}/${fileSize}`
  );
  console.log(`Chunks required: ${chunkCount}`);

  let bytesSent = 0;

  const iterator = tg.iterDownload({
    file: message.media,
    offset,
    requestSize: CHUNK_SIZE,
    chunkSize: CHUNK_SIZE,
    limit: chunkCount,
    fileSize: bigInt(fileSize)
  });

  try {
    for await (const chunk of iterator) {
      if (res.destroyed) break;

      const remaining = requestedBytes - bytesSent;

      if (remaining <= 0) break;

      let outputChunk = chunk;

      if (chunk.length > remaining) {
        outputChunk = chunk.subarray(0, remaining);
      }

      res.write(outputChunk);
      bytesSent += outputChunk.length;

      if (bytesSent >= requestedBytes) break;
    }
  } finally {
    console.log(
      `Stream finished: ${bytesSent} bytes`
    );
  }

  if (!res.destroyed) {
    res.end();
  }
}

// ==================================================
// HEALTH
// ==================================================

app.get("/health", async (req, res) => {
  try {
    await getClient();

    res.json({
      success: true,
      server: "Sayeed Courses Video API",
      telegram: "connected",
      firebaseAdminConfigured: Boolean(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ),
      playbackSigningConfigured: PLAYBACK_SIGNING_SECRET.length >= 32,
      playbackTokenTtlSeconds: PLAYBACK_TOKEN_TTL_SECONDS,
      securityMode: VIDEO_SECURITY_MODE,
      websiteOrigin: WEBSITE_ORIGIN,
      bot: true
    });
  } catch (error) {
    console.error("HEALTH ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================================================
// SECURE ENROLLMENT CHECK
//
// GET /access?courseId=2
// Authorization: Bearer <Firebase ID token>
// ==================================================

app.get("/access", async (req, res) => {
  try {
    const courseId = String(req.query.courseId || "").trim();

    if (!courseId) {
      throw httpError("courseId is required.", 400);
    }

    const decoded = await verifyFirebaseUser(req);
    const enrolled = await checkCourseEnrollment(
      decoded.uid,
      courseId
    );

    res.json({
      success: true,
      authenticated: true,
      enrolled,
      courseId
    });
  } catch (error) {
    console.error("ACCESS ERROR:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Access check failed."
    });
  }
});

// ==================================================
// SHORT-LIVED PLAYBACK ACCESS
//
// The website sends Firebase Authorization here once.
// The returned signed URL can be used by a native <video> element
// without exposing a Firebase token in the media request.
// ==================================================

app.get("/playback", async (req, res) => {
  try {
    const courseId = String(req.query.courseId || "").trim();
    const messageId = Number(req.query.messageId);

    if (!courseId) {
      throw httpError("courseId is required.", 400);
    }

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw httpError("A valid messageId is required.", 400);
    }

    const decoded = await requireCourseEnrollment(req, courseId);
    requirePlaybackSigningSecret();

    const token = createPlaybackToken({
      courseId,
      messageId,
      uid: decoded.uid
    });

    const url = new URL("/video", `${req.protocol}://${req.get("host")}`);
    url.searchParams.set("messageId", String(messageId));
    url.searchParams.set("courseId", courseId);
    url.searchParams.set("token", token);

    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      success: true,
      courseId,
      messageId,
      expiresIn: PLAYBACK_TOKEN_TTL_SECONDS,
      playbackUrl: url.toString()
    });
  } catch (error) {
    console.error("PLAYBACK ERROR:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Playback access failed."
    });
  }
});

// ==================================================
// LATEST VIDEO INFO
// ==================================================

app.get("/latest", async (req, res) => {
  try {
    const message = await findLatestVideoMessage();
    const document = message.media.document;
    const metadata = parseVideoMetadata(message);

    res.json({
      success: true,
      messageId: Number(message.id),
      metadata,
      file: {
        fileSize: Number(document.size),
        fileSizeMB: Number(document.size) / (1024 * 1024),
        mimeType: document.mimeType || null,
        fileName: getDocumentFileName(document)
      }
    });
  } catch (error) {
    console.error("LATEST ERROR:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================================================
// FLAT VIDEO LIBRARY
// ==================================================

app.get("/library", async (req, res) => {
  try {
    const force = parseBoolean(req.query.refresh, false);
    const videos = await getCachedVideoLibrary(force);

    const filteredVideos = videos
      .filter(hasCompleteMetadata)
      .sort((a, b) => a.messageId - b.messageId);

    res.json({
      success: true,
      count: filteredVideos.length,
      videos: filteredVideos
    });
  } catch (error) {
    console.error("LIBRARY ERROR:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================================================
// COURSE → MODULE → VIDEOS
// ==================================================

app.get("/courses", async (req, res) => {
  try {
    const force = parseBoolean(req.query.refresh, false);
    const videos = await getCachedVideoLibrary(force);
    const catalogue = buildCourseCatalogue(videos);

    res.json({
      success: true,
      ...catalogue,
      cachedForMs: COURSE_CACHE_TTL_MS
    });
  } catch (error) {
    console.error("COURSES ERROR:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================================================
// VIDEO STREAM
//
// Phase 1 compatibility mode:
//   VIDEO_SECURITY_MODE=test      -> current test player keeps working.
//   VIDEO_SECURITY_MODE=protected -> Firebase auth + enrollment required.
//
// Protected mode expects:
//   /video?messageId=19&courseId=2
//   Authorization: Bearer <Firebase ID token>
//
// We will switch this to short-lived playback access in the next phase.
// ==================================================

async function handleVideoRequest(req, res) {
  try {
    const courseId = String(req.query.courseId || "").trim();
    const playbackToken = String(req.query.token || "").trim();
    const requestedMessageId = req.query.messageId;
    let message;

    if (playbackToken) {
      const payload = verifyPlaybackToken(playbackToken);
      if (courseId && payload.courseId !== courseId) {
        throw httpError("Playback token does not match this course.", 403);
      }
      if (requestedMessageId !== undefined && Number(payload.messageId) !== Number(requestedMessageId)) {
        throw httpError("Playback token does not match this video.", 403);
      }
      message = await getVideoMessage(payload.messageId);
    } else if (VIDEO_SECURITY_MODE === "protected") {
      if (!courseId) {
        throw httpError(
          "courseId is required for protected video access.",
          400
        );
      }
      await requireCourseEnrollment(req, courseId);
      if (requestedMessageId !== undefined) {
        message = await getVideoMessage(requestedMessageId);
      } else {
        message = await findLatestVideoMessage();
      }
    } else {
      if (requestedMessageId !== undefined) {
        message = await getVideoMessage(requestedMessageId);
      } else {
        message = await findLatestVideoMessage();
      }
    }

    return streamTelegramVideo(req, res, message);
  } catch (error) {
    console.error("VIDEO ERROR:", error);

    if (res.headersSent) {
      return res.destroy();
    }

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Video streaming failed."
    });
  }
}

app.get("/video", handleVideoRequest);

// HEAD is useful for player/network checks. It does not download the video.
app.head("/video", async (req, res) => {
  try {
    const requestedMessageId = req.query.messageId;
    const courseId = String(req.query.courseId || "").trim();
    const playbackToken = String(req.query.token || "").trim();
    let message;

    if (playbackToken) {
      const payload = verifyPlaybackToken(playbackToken);
      if (courseId && payload.courseId !== courseId) {
        throw httpError("Playback token does not match this course.", 403);
      }
      message = await getVideoMessage(payload.messageId);
    } else if (VIDEO_SECURITY_MODE === "protected") {
      if (!courseId) {
        throw httpError(
          "courseId is required for protected video access.",
          400
        );
      }
      await requireCourseEnrollment(req, courseId);
      message = requestedMessageId !== undefined
        ? await getVideoMessage(requestedMessageId)
        : await findLatestVideoMessage();
    } else {
      message = requestedMessageId !== undefined
        ? await getVideoMessage(requestedMessageId)
        : await findLatestVideoMessage();
    }

    const document = message.media.document;
    const fileSize = Number(document.size);

    res.status(200);
    res.setHeader(
      "Content-Type",
      document.mimeType || "video/mp4"
    );
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", fileSize);
    res.setHeader(
      "Cache-Control",
      "private, no-store, no-cache, must-revalidate"
    );
    return res.end();
  } catch (error) {
    res.status(error.statusCode || 500).end();
  }
});

// ==================================================
// ERROR FALLBACK
// ==================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found."
  });
});

// ==================================================
// START SERVER
// ==================================================

app.listen(PORT, () => {
  console.log(
    `Sayeed Courses Video API running on port ${PORT}`
  );
  console.log(
    `Video security mode: ${VIDEO_SECURITY_MODE}`
  );
});
