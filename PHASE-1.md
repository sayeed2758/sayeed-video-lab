# Sayeed Courses Video API — Phase 1

This phase upgrades the existing `sayeed-video-lab` project without replacing the tested Telegram MTProto streaming engine.

## What changed

- Renamed the backend identity to `Sayeed Courses Video API`.
- Added Firebase Admin SDK support.
- Added Firebase ID-token verification helper.
- Added Firestore enrollment verification.
- Added `GET /access?courseId=<website-course-id>` for authenticated enrollment checks.
- Added configurable CORS with `WEBSITE_ORIGIN`.
- Added a `VIDEO_SECURITY_MODE` switch.
- Added short-lived in-memory caching for Telegram video scans so `/courses` and `/library` do not scan messages on every request.
- Kept the existing MTProto range-streaming logic and 512 KB chunking.
- Added a `HEAD /video` route for player/network checks.
- Kept the old `api/telegram.js` and `api/video.js` files untouched for reference; the Express `server.js` is the active Render backend.

## Important

For Phase 1 deployment, keep:

`VIDEO_SECURITY_MODE=test`

This preserves the current working test player while we build the real Sayeed Courses Hub player connection.

The next phase will move video playback to a short-lived secure playback mechanism so the main website can use a normal HTML video element without putting a long-lived Firebase Authorization header into the video URL.

## Render environment variables

Keep the existing Telegram variables:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_BOT_TOKEN`

Add:

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `WEBSITE_ORIGIN=https://sayeed-courses-hubb.vercel.app`
- `VIDEO_SECURITY_MODE=test`

Do not commit the Firebase service-account JSON to GitHub and do not paste the private key into chat.

## Verification

After deploy, open:

`/health`

Expected fields include:

- `success: true`
- `telegram: "connected"`
- `firebaseAdminConfigured: true`
- `securityMode: "test"`

Then test:

`/courses`

and confirm the same Telegram videos still appear.

## Active endpoint map

- `GET /health`
- `GET /latest`
- `GET /library`
- `GET /courses`
- `GET /access?courseId=...` (Firebase auth required)
- `GET /video?messageId=...` (test mode is currently public for compatibility)
- `HEAD /video?messageId=...`
