import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = String(process.env.TELEGRAM_API_HASH || "").trim();

if (!API_ID || !API_HASH) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script.");
}

const rl = readline.createInterface({ input, output });
const ask = async (question) => (await rl.question(question)).trim();

const client = new TelegramClient(
  new StringSession(""),
  API_ID,
  API_HASH,
  { connectionRetries: 5 }
);

try {
  await client.start({
    phoneNumber: async () => await ask("Telegram phone number (with country code): "),
    phoneCode: async () => await ask("Telegram login code: "),
    password: async () => await ask("Telegram 2FA password (leave blank if none): "),
    onError: (error) => console.error("Telegram login error:", error?.message || error)
  });

  console.log("\nLOGIN SUCCESSFUL");
  console.log("TELEGRAM_USER_SESSION_STRING=");
  console.log(client.session.save());
  console.log("\nIMPORTANT: This session string is a secret. Do not share it in screenshots, GitHub, or chat.");
} finally {
  rl.close();
  await client.disconnect();
}
