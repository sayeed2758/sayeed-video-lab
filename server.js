import express from "express";
import crypto from "node:crypto";
import { once } from "node:events";
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
  process.env.WEBSITE_ORIGIN || "https://sayeed-courses-hubb.vercel.app"
).trim();
const VIDEO_SECURITY_MODE = String(
  process.env.VIDEO_SECURITY_MODE || "protected"
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
const TELEGRAM_USER_SESSION_STRING = String(
  process.env.TELEGRAM_USER_SESSION_STRING || ""
).trim();

const CHANNEL_ID = "-1004305906553";

// Telegram sync/index configuration. The previous implementation queried a
// fixed message-ID range (1..200), which silently missed newer uploads and
// could not surface videos that had no metadata caption. Batch 1 replaces
// that proof-of-concept scan with a paginated index + incremental refresh.
const TELEGRAM_SYNC_MAX_MESSAGES = Math.min(
  Math.max(Number(process.env.TELEGRAM_SYNC_MAX_MESSAGES || 10000), 500),
  50000
);
const TELEGRAM_RECENT_WINDOW = Math.min(
  Math.max(Number(process.env.TELEGRAM_RECENT_WINDOW || 300), 50),
  2000
);
const TELEGRAM_NEW_MESSAGE_LIMIT = Math.min(
  Math.max(Number(process.env.TELEGRAM_NEW_MESSAGE_LIMIT || 1000), 50),
  5000
);
const VIDEO_INDEX_COLLECTION = String(
  process.env.VIDEO_INDEX_COLLECTION || "telegramVideoIndex"
).trim();

// Video library metadata is relatively stable. Keep it warm for 5 minutes
// and refresh it in the background after that instead of making students wait
// for a Telegram scan on every page open.
const COURSE_CACHE_TTL_MS = 5 * 60_000;

// Streaming optimization: Telegram MTProto allows up to 1 MiB per upload.getFile
// request in the standard download path. Larger relay chunks reduce request overhead
// compared with the previous 512 KiB setting while preserving range streaming.
const STREAM_CHUNK_SIZE = 1024 * 1024;
const STREAM_CACHE_SECONDS = 60;
const STREAM_PARALLEL_REQUESTS = 2;

const botStringSession = new StringSession("");
const userStringSession = new StringSession(TELEGRAM_USER_SESSION_STRING);

let botTgClient = null;
let userTgClient = null;
let cachedChannel = null;
let firebaseReady = false;
let courseCache = {
  data: null,
  expiresAt: 0,
  promise: null
};

let videoIndexLoaded = false;
const videoIndex = new Map();

let syncState = {
  status: "idle",
  mode: "none",
  startedAt: null,
  completedAt: null,
  durationMs: 0,
  scannedMessages: 0,
  discoveredVideos: 0,
  newVideos: 0,
  updatedVideos: 0,
  totalVideos: 0,
  highestMessageId: 0,
  error: null
};

// ==================================================
// CORS + SECURITY HEADERS
// ==================================================

const ALLOWED_ORIGINS = WEBSITE_ORIGIN
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes("*")) return true;
  return ALLOWED_ORIGINS.includes(String(origin).replace(/\/$/, ""));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({
      success: false,
      error: "Origin is not allowed."
    });
  }

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

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
    typ: "sayeed-video-playback",
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
  if (payload?.typ !== "sayeed-video-playback" || !payload?.courseId || !payload?.uid || !Number.isInteger(Number(payload.messageId)) || Number(payload.messageId) <= 0) {
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

function getVideoDurationSeconds(document) {
  const attribute = document.attributes?.find(
    (item) => item.className === "DocumentAttributeVideo"
  );

  const duration = Number(attribute?.duration || 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
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
    },

    durationSeconds: getVideoDurationSeconds(document)
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

async function getBotClient() {
  if (botTgClient && botTgClient.connected) {
    return botTgClient;
  }

  requireTelegramConfig();

  botTgClient = new TelegramClient(
    botStringSession,
    API_ID,
    API_HASH,
    {
      connectionRetries: 5
    }
  );

  await botTgClient.start({
    botAuthToken: BOT_TOKEN
  });

  console.log("Telegram bot MTProto connected.");

  return botTgClient;
}

async function getSyncClient() {
  if (userTgClient && userTgClient.connected) {
    return userTgClient;
  }

  requireTelegramConfig();

  if (!TELEGRAM_USER_SESSION_STRING) {
    throw new Error(
      "TELEGRAM_USER_SESSION_STRING is not configured. Create a Telegram user session and add it to Render before running Telegram library sync."
    );
  }

  userTgClient = new TelegramClient(
    userStringSession,
    API_ID,
    API_HASH,
    {
      connectionRetries: 5
    }
  );

  await userTgClient.connect();

  if (!(await userTgClient.checkAuthorization())) {
    userTgClient = null;
    throw new Error(
      "Telegram user session is not authorized. Generate a new TELEGRAM_USER_SESSION_STRING."
    );
  }

  console.log("Telegram user MTProto sync session connected.");

  return userTgClient;
}

// ==================================================
// GET CHANNEL
// ==================================================

async function getChannel(client = null) {
  if (cachedChannel) {
    return cachedChannel;
  }

  const tg = client || await getBotClient();

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
  const tg = await getBotClient();
  const channel = await getChannel(tg);

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

async function loadVideoIndexFromFirestore() {
  if (videoIndexLoaded) return;

  videoIndexLoaded = true;

  try {
    getFirebaseAdmin();
    const snapshot = await getFirestore()
      .collection(VIDEO_INDEX_COLLECTION)
      .get();

    videoIndex.clear();

    snapshot.forEach((docSnapshot) => {
      const data = docSnapshot.data() || {};
      const messageId = Number(data.messageId || docSnapshot.id);
      if (!Number.isInteger(messageId) || messageId <= 0) return;

      videoIndex.set(messageId, {
        messageId,
        metadata: {
          course: data.metadata?.course || null,
          module: data.metadata?.module || null,
          videoId: data.metadata?.videoId || null,
          title: data.metadata?.title || null
        },
        file: {
          size: Number(data.file?.size || 0),
          sizeMB: Number(data.file?.sizeMB || 0),
          mimeType: data.file?.mimeType || null,
          fileName: data.file?.fileName || null
        },
        durationSeconds: Number(data.durationSeconds || 0),
        indexedAt: data.indexedAt || null,
        lastSeenAt: data.lastSeenAt || null
      });
    });

    console.log(
      `Telegram video index loaded from Firestore: ${videoIndex.size} videos.`
    );
  } catch (error) {
    // The video index is an optimization. If Firestore persistence is
    // temporarily unavailable, keep the in-memory index working instead of
    // taking the video library down.
    console.warn(
      "VIDEO INDEX PERSISTENCE UNAVAILABLE; using memory cache only:",
      error?.message || error
    );
  }
}

function getIndexedVideoArray() {
  return Array.from(videoIndex.values()).sort(
    (a, b) => Number(a.messageId) - Number(b.messageId)
  );
}

function getVideoRecordSignature(video) {
  return JSON.stringify({
    messageId: Number(video.messageId),
    metadata: video.metadata || {},
    file: video.file || {},
    durationSeconds: Number(video.durationSeconds || 0)
  });
}

function getMaxIndexedMessageId() {
  let max = 0;
  for (const messageId of videoIndex.keys()) {
    max = Math.max(max, Number(messageId));
  }
  return max;
}

async function persistVideoIndexUpdates(records) {
  if (!records.length) return;

  try {
    getFirebaseAdmin();
    const firestore = getFirestore();
    const now = new Date().toISOString();

    for (let start = 0; start < records.length; start += 450) {
      const chunk = records.slice(start, start + 450);
      const batch = firestore.batch();

      chunk.forEach((record) => {
        const ref = firestore
          .collection(VIDEO_INDEX_COLLECTION)
          .doc(String(record.messageId));

        batch.set(
          ref,
          {
            ...record,
            indexedAt: record.indexedAt || now,
            lastSeenAt: now
          },
          { merge: true }
        );
      });

      await batch.commit();
    }
  } catch (error) {
    console.warn(
      "VIDEO INDEX WRITE FAILED; continuing with memory index:",
      error?.message || error
    );
  }
}

async function collectTelegramMessages({ fullScan = false } = {}) {
  const tg = await getSyncClient();
  const channel = await getChannel(tg);
  const messages = new Map();

  const addMessage = (message) => {
    const id = Number(message?.id || 0);
    if (id > 0) messages.set(id, message);
  };

  if (fullScan || videoIndex.size === 0) {
    console.log(
      `Telegram full sync started. Maximum messages: ${TELEGRAM_SYNC_MAX_MESSAGES}`
    );

    for await (const message of tg.iterMessages(channel, {
      limit: TELEGRAM_SYNC_MAX_MESSAGES
    })) {
      addMessage(message);
    }
  } else {
    // Always rescan a recent window. This catches edited captions and videos
    // that were posted without complete metadata, while minId picks up the
    // genuinely new tail of the channel history.
    for await (const message of tg.iterMessages(channel, {
      limit: TELEGRAM_RECENT_WINDOW
    })) {
      addMessage(message);
    }

    const highestMessageId = getMaxIndexedMessageId();

    if (highestMessageId > 0) {
      let discoveredNewMessages = 0;

      for await (const message of tg.iterMessages(channel, {
        minId: highestMessageId,
        limit: TELEGRAM_NEW_MESSAGE_LIMIT,
        reverse: true
      })) {
        addMessage(message);
        discoveredNewMessages += 1;
        if (discoveredNewMessages >= TELEGRAM_NEW_MESSAGE_LIMIT) break;
      }
    }
  }

  return Array.from(messages.values()).sort(
    (a, b) => Number(a.id) - Number(b.id)
  );
}

function normalizeVideoRecord(video) {
  return {
    messageId: Number(video.messageId),
    metadata: {
      course: video.metadata?.course || null,
      module: video.metadata?.module || null,
      videoId: video.metadata?.videoId || null,
      title: video.metadata?.title || null
    },
    file: {
      size: Number(video.file?.size || 0),
      sizeMB: Number(video.file?.sizeMB || 0),
      mimeType: video.file?.mimeType || null,
      fileName: video.file?.fileName || null
    },
    durationSeconds: Number(video.durationSeconds || 0)
  };
}

async function syncTelegramVideoIndex({ fullScan = false } = {}) {
  if (courseCache.promise) {
    return courseCache.promise;
  }

  courseCache.promise = (async () => {
    const startedAt = Date.now();
    const mode = fullScan || videoIndex.size === 0 ? "full" : "incremental";

    syncState = {
      ...syncState,
      status: "syncing",
      mode,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: null,
      durationMs: 0,
      scannedMessages: 0,
      discoveredVideos: 0,
      newVideos: 0,
      updatedVideos: 0,
      totalVideos: videoIndex.size,
      highestMessageId: getMaxIndexedMessageId(),
      error: null
    };

    try {
      await loadVideoIndexFromFirestore();

      const messages = await collectTelegramMessages({ fullScan });
      const discoveredVideos = messages
        .filter(isVideoMessage)
        .map((message) => normalizeVideoRecord(toVideoRecord(message)));

      const changedRecords = [];
      let newVideos = 0;
      let updatedVideos = 0;

      for (const record of discoveredVideos) {
        const previous = videoIndex.get(record.messageId);
        if (!previous) {
          newVideos += 1;
          changedRecords.push(record);
        } else if (
          getVideoRecordSignature(previous) !==
          getVideoRecordSignature(record)
        ) {
          updatedVideos += 1;
          changedRecords.push(record);
        }

        videoIndex.set(record.messageId, {
          ...(previous || {}),
          ...record,
          lastSeenAt: new Date().toISOString()
        });
      }

      await persistVideoIndexUpdates(changedRecords);

      const videos = getIndexedVideoArray();
      const durationMs = Date.now() - startedAt;
      const highestMessageId = Math.max(
        getMaxIndexedMessageId(),
        ...messages.map((message) => Number(message.id) || 0)
      );

      syncState = {
        ...syncState,
        status: "ready",
        completedAt: new Date().toISOString(),
        durationMs,
        scannedMessages: messages.length,
        discoveredVideos: discoveredVideos.length,
        newVideos,
        updatedVideos,
        totalVideos: videos.length,
        highestMessageId,
        error: null
      };

      courseCache = {
        data: videos,
        expiresAt: Date.now() + COURSE_CACHE_TTL_MS,
        promise: null
      };

      console.log(
        `Telegram sync complete: ${videos.length} indexed videos; ${newVideos} new; ${updatedVideos} updated; ${messages.length} messages scanned in ${durationMs}ms.`
      );

      return videos;
    } catch (error) {
      const durationMs = Date.now() - startedAt;

      syncState = {
        ...syncState,
        status: "error",
        completedAt: new Date().toISOString(),
        durationMs,
        totalVideos: videoIndex.size,
        highestMessageId: getMaxIndexedMessageId(),
        error: error?.message || "Telegram sync failed."
      };

      courseCache.promise = null;
      console.error("TELEGRAM VIDEO INDEX SYNC ERROR:", error);
      throw error;
    }
  })();

  return courseCache.promise;
}

async function getCachedVideoLibrary(force = false, fullScan = false) {
  await loadVideoIndexFromFirestore();

  if (!courseCache.data && videoIndex.size > 0) {
    courseCache.data = getIndexedVideoArray();
    courseCache.expiresAt = Date.now();
  }

  const now = Date.now();

  if (!force && courseCache.data && now < courseCache.expiresAt) {
    return courseCache.data;
  }

  if (!force && courseCache.data && now >= courseCache.expiresAt) {
    void syncTelegramVideoIndex({ fullScan: false }).catch(() => {});
    return courseCache.data;
  }

  return syncTelegramVideoIndex({
    fullScan: Boolean(fullScan)
  });
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
  const unmappedVideos = videos
    .filter((video) => !hasCompleteMetadata(video))
    .map((video) => ({
      ...video,
      metadataComplete: false,
      missingMetadata: [
        ["course", video.metadata?.course],
        ["module", video.metadata?.module],
        ["videoId", video.metadata?.videoId],
        ["title", video.metadata?.title]
      ].filter(([, value]) => !value).map(([key]) => key)
    }))
    .sort((a, b) => Number(b.messageId) - Number(a.messageId));
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
      durationSeconds: Number(video.durationSeconds || 0),
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
    // videoCount intentionally includes ALL Telegram video messages, even
    // when a caption is missing. Unmapped videos are returned separately so
    // the admin can publish them without having to re-upload the file.
    videoCount: videos.length,
    mappedVideoCount: validVideos.length,
    unmappedVideoCount: unmappedVideos.length,
    courses,
    unmappedVideos
  };
}

async function streamTelegramVideo(req, res, message) {
  const tg = await getBotClient();
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
    `private, max-age=${STREAM_CACHE_SECONDS}, must-revalidate`
  );
  res.setHeader("X-Playback-Cache", "private");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Accel-Buffering", "no");

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true, 10_000);
  }

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const CHUNK_SIZE = STREAM_CHUNK_SIZE;
  const requestedBytes = contentLength;
  const chunkCount = Math.ceil(requestedBytes / CHUNK_SIZE);
  const parallelRequests = Math.min(
    STREAM_PARALLEL_REQUESTS,
    Math.max(chunkCount, 1)
  );

  console.log(
    `Streaming message ${message.id}: ${start}-${end}/${fileSize}`
  );
  console.log(
    `Chunks required: ${chunkCount}; parallel Telegram requests: ${parallelRequests}`
  );

  // Controlled read-ahead: keep at most two 1 MiB Telegram requests in flight.
  // This lets Render fetch the next chunk while the current chunk is being
  // delivered to a slower mobile browser, without creating an unbounded buffer.
  const downloadChunk = async (chunkIndex) => {
    const chunkStart = start + chunkIndex * CHUNK_SIZE;
    const remaining = requestedBytes - chunkIndex * CHUNK_SIZE;
    const expectedLength = Math.min(CHUNK_SIZE, remaining);

    const iterator = tg.iterDownload({
      file: message.media,
      offset: bigInt(chunkStart),
      requestSize: CHUNK_SIZE,
      chunkSize: CHUNK_SIZE,
      limit: 1,
      fileSize: bigInt(fileSize)
    });

    const pieces = [];
    for await (const piece of iterator) {
      pieces.push(piece);
      if (pieces.reduce((sum, item) => sum + item.length, 0) >= expectedLength) {
        break;
      }
    }

    if (!pieces.length) {
      throw new Error(`Telegram returned no data for chunk ${chunkIndex}.`);
    }

    const combined = pieces.length === 1
      ? pieces[0]
      : Buffer.concat(pieces);

    return combined.length > expectedLength
      ? combined.subarray(0, expectedLength)
      : combined;
  };

  const inFlight = new Map();
  let nextChunkToStart = 0;

  const startChunk = (index) => {
    const promise = downloadChunk(index);
    inFlight.set(index, promise);
  };

  while (
    nextChunkToStart < parallelRequests &&
    nextChunkToStart < chunkCount
  ) {
    startChunk(nextChunkToStart);
    nextChunkToStart += 1;
  }

  let bytesSent = 0;

  try {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (res.destroyed) break;

      const promise = inFlight.get(chunkIndex);
      if (!promise) {
        throw new Error(`Missing in-flight chunk ${chunkIndex}.`);
      }
      inFlight.delete(chunkIndex);

      // Start the next Telegram request before writing the current chunk so
      // there is always a small read-ahead window.
      if (nextChunkToStart < chunkCount) {
        startChunk(nextChunkToStart);
        nextChunkToStart += 1;
      }

      const outputChunk = await promise;

      if (res.destroyed) break;

      const canContinue = res.write(outputChunk);
      bytesSent += outputChunk.length;

      if (!canContinue && !res.destroyed) {
        await once(res, "drain");
      }
    }
  } finally {
    console.log(`Stream finished: ${bytesSent} bytes`);
  }

  if (!res.destroyed) {
    res.end();
  }
}

function productionSecurityChecks() {
  const checks = {
    modeProtected: VIDEO_SECURITY_MODE === "protected",
    originConfigured: ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes("*"),
    signingSecretConfigured: PLAYBACK_SIGNING_SECRET.length >= 32,
    firebaseConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    telegramConfigured: Boolean(API_ID && API_HASH && BOT_TOKEN)
  };

  return {
    ...checks,
    productionReady: Object.values(checks).every(Boolean)
  };
}

function requireProductionSecurity() {
  if (VIDEO_SECURITY_MODE === "test") return;
  const checks = productionSecurityChecks();
  if (!checks.productionReady) {
    const missing = Object.entries(checks)
      .filter(([key, value]) => key !== "productionReady" && !value)
      .map(([key]) => key);
    throw new Error(`Production security is not ready: ${missing.join(", ")}.`);
  }
}

// ==================================================
// HEALTH
// ==================================================

app.get("/health", async (req, res) => {
  try {
    await getBotClient();

    res.json({
      success: true,
      server: "Sayeed Courses Video API",
      telegram: "connected",
      telegramBotConfigured: Boolean(API_ID && API_HASH && BOT_TOKEN),
      telegramUserSyncConfigured: Boolean(API_ID && API_HASH && TELEGRAM_USER_SESSION_STRING),
      firebaseAdminConfigured: Boolean(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ),
      playbackSigningConfigured: PLAYBACK_SIGNING_SECRET.length >= 32,
      playbackTokenTtlSeconds: PLAYBACK_TOKEN_TTL_SECONDS,
      securityMode: VIDEO_SECURITY_MODE,
      websiteOrigin: WEBSITE_ORIGIN,
      securityChecks: productionSecurityChecks(),
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
    requireProductionSecurity();
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
      .map((video) => ({
        ...video,
        metadataComplete: hasCompleteMetadata(video),
        missingMetadata: [
          ["course", video.metadata?.course],
          ["module", video.metadata?.module],
          ["videoId", video.metadata?.videoId],
          ["title", video.metadata?.title]
        ].filter(([, value]) => !value).map(([key]) => key)
      }))
      .sort((a, b) => a.messageId - b.messageId);

    res.json({
      success: true,
      count: filteredVideos.length,
      videos: filteredVideos,
      sync: syncState
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
// TELEGRAM SYNC STATUS / MANUAL SYNC
// ==================================================

app.get("/sync-status", async (req, res) => {
  try {
    await loadVideoIndexFromFirestore();
    res.json({
      success: true,
      sync: syncState,
      indexedVideoCount: videoIndex.size,
      cacheReady: Boolean(courseCache.data),
      cacheExpiresAt: courseCache.expiresAt || null
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Could not load sync status."
    });
  }
});

app.get("/sync", async (req, res) => {
  try {
    const fullScan = parseBoolean(req.query.full, false);
    await getCachedVideoLibrary(true, fullScan);

    res.json({
      success: true,
      sync: syncState,
      indexedVideoCount: videoIndex.size
    });
  } catch (error) {
    console.error("SYNC ERROR:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Telegram sync failed.",
      sync: syncState
    });
  }
});

// ==================================================
// COURSE → MODULE → VIDEOS
// ==================================================

app.get("/courses", async (req, res) => {
  try {
    const force = parseBoolean(req.query.refresh, false);
    const fullScan = parseBoolean(req.query.full, false);
    const videos = await getCachedVideoLibrary(force, fullScan);
    const catalogue = buildCourseCatalogue(videos);

    res.json({
      success: true,
      ...catalogue,
      cachedForMs: COURSE_CACHE_TTL_MS,
      cacheExpiresAt: courseCache.expiresAt || null,
      cacheReady: Boolean(courseCache.data),
      sync: syncState
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

    if (VIDEO_SECURITY_MODE !== "test") {
      requireProductionSecurity();
    }

    if (playbackToken) {
      const payload = verifyPlaybackToken(playbackToken);
      if (courseId && payload.courseId !== courseId) {
        throw httpError("Playback token does not match this course.", 403);
      }
      if (requestedMessageId !== undefined && Number(payload.messageId) !== Number(requestedMessageId)) {
        throw httpError("Playback token does not match this video.", 403);
      }
      message = await getVideoMessage(payload.messageId);
    } else if (VIDEO_SECURITY_MODE === "test") {
      if (requestedMessageId !== undefined) {
        message = await getVideoMessage(requestedMessageId);
      } else {
        message = await findLatestVideoMessage();
      }
    } else {
      throw httpError("A short-lived playback token is required.", 401);
    }

    return streamTelegramVideo(req, res, message);
  } catch (error) {
    console.error("VIDEO ERROR:", error);
    if (res.headersSent) return res.destroy();
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
    const playbackToken = String(req.query.token || "").trim();
    const requestedMessageId = req.query.messageId;
    let message;

    if (VIDEO_SECURITY_MODE !== "test") {
      requireProductionSecurity();
    }

    if (playbackToken) {
      const payload = verifyPlaybackToken(playbackToken);
      if (requestedMessageId !== undefined && Number(payload.messageId) !== Number(requestedMessageId)) {
        throw httpError("Playback token does not match this video.", 403);
      }
      message = await getVideoMessage(payload.messageId);
    } else if (VIDEO_SECURITY_MODE === "test") {
      message = requestedMessageId !== undefined
        ? await getVideoMessage(requestedMessageId)
        : await findLatestVideoMessage();
    } else {
      throw httpError("A short-lived playback token is required.", 401);
    }

    const document = message.media.document;
    const fileSize = Number(document.size);
    res.status(200);
    res.setHeader("Content-Type", document.mimeType || "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", fileSize);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    res.end();
  } catch (error) {
    console.error("VIDEO HEAD ERROR:", error);
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

const server = app.listen(PORT, () => {
  console.log(
    `Sayeed Courses Video API running on port ${PORT}`
  );
  console.log(
    `Video security mode: ${VIDEO_SECURITY_MODE}`
  );
  console.log(
    `Streaming: ${STREAM_CHUNK_SIZE / (1024 * 1024)} MiB chunks, ${STREAM_PARALLEL_REQUESTS} parallel requests`
  );
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

// Warm the Telegram video index in the background. On a warm Render instance,
// the website can then receive /courses from memory instead of waiting for
// Telegram discovery.
if (TELEGRAM_USER_SESSION_STRING) {
  void getCachedVideoLibrary(false, false).catch((error) => {
    console.warn("Telegram user sync warm-up failed:", error?.message || error);
  });
} else {
  console.warn("Telegram user sync session not configured; video library sync is waiting for TELEGRAM_USER_SESSION_STRING.");
}
