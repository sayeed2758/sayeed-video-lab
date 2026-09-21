# Sayeed Video Lab — Phase 2 Secure Playback

Adds short-lived HMAC-signed playback URLs. The website authenticates once with Firebase at `/playback`; the native HTML video element then uses the returned URL without sending the Firebase ID token to `/video`.

## New Render environment variable
`PLAYBACK_SIGNING_SECRET` — random secret, at least 32 characters. Keep it private and never commit it.

Optional: `PLAYBACK_TOKEN_TTL_SECONDS` (60–1800, default 600).

Keep `VIDEO_SECURITY_MODE=test` during the website player rollout. After the player is verified, switch to `protected`.

Do not put the Firebase service-account JSON or playback secret in GitHub.
