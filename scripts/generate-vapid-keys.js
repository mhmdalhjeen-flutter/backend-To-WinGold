/**
 * Generate VAPID keys for Web Push.
 * Usage: node scripts/generate-vapid-keys.js
 *
 * Prints keys to stdout — add them to backend/.env (never commit .env).
 */
const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();

console.log("Add these to backend/.env:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:admin@yourdomain.com");
console.log("\nOr set VAPID_SUBJECT to your customer PWA URL, e.g.:");
console.log("VAPID_SUBJECT=https://win-gold-moll.pages.dev");
