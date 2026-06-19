/**
 * tracker.js — scrapes Apify for reel metrics and saves snapshots to Postgres
 *
 * Usage:
 *   node tracker.js           → runs once, then every INTERVAL_MINUTES
 *   node tracker.js --once    → runs once and exits (used by Render Cron Job)
 */

import "dotenv/config";
import { pool, initDb } from "./db.js";
import { scrapeAndSave } from "./scraper.js";

const INTERVAL_MS = parseInt(process.env.INTERVAL_MINUTES ?? "30") * 60 * 1000;

async function scrapeAll() {
  const { rows: reels } = await pool.query(
    "SELECT url, label, short_code FROM reels ORDER BY created_at"
  );

  if (!reels.length) {
    console.log("  No reels in DB yet. Add some via the dashboard.");
    return;
  }

  await scrapeAndSave(reels);
}

async function main() {
  if (!process.env.APIFY_TOKEN)  { console.error("APIFY_TOKEN not set.");  process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set."); process.exit(1); }

  await initDb();

  const runOnce = process.argv.includes("--once");
  await scrapeAll().catch(e => console.error("Scrape error:", e.message));

  if (runOnce) {
    console.log("\nDone (--once). Exiting.");
    await pool.end();
    return;
  }

  const mins = parseInt(process.env.INTERVAL_MINUTES ?? "30");
  console.log(`\nScheduled — next run in ${mins} min. Ctrl+C to stop.\n`);
  setInterval(
    () => scrapeAll().catch(e => console.error("Scrape error:", e.message)),
    INTERVAL_MS
  );
}

main();
