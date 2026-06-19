/**
 * tracker.js — scrapes Apify for reel metrics and saves snapshots to Postgres
 *
 * Usage:
 *   node tracker.js           → runs once, then every INTERVAL_MINUTES
 *   node tracker.js --once    → runs once and exits (used by Render Cron Job)
 */

import "dotenv/config";
import { ApifyClient } from "apify-client";
import { pool, initDb } from "./db.js";

const IG_ACTOR    = process.env.APIFY_IG_ACTOR_ID ?? "apify~instagram-scraper";
const INTERVAL_MS = parseInt(process.env.INTERVAL_MINUTES ?? "30") * 60 * 1000;

function extractShortCode(url) {
  const m = url.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/);
  return m ? m[2] : null;
}

async function runApify(urls, resultsType) {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const run    = await client.actor(IG_ACTOR).call(
    { directUrls: urls, resultsType, resultsLimit: urls.length },
    { waitSecs: 180 }
  );
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}

async function scrapeAndStore() {
  const now = new Date().toISOString();
  console.log(`\n[${now}] Starting scrape...`);

  const { rows: reels } = await pool.query("SELECT url, label, short_code FROM reels ORDER BY created_at");

  if (!reels.length) {
    console.log("  No reels in DB yet. Add some via the dashboard.");
    return;
  }

  const reelUrls = reels.filter(r => /\/reel\//.test(r.url));
  const postUrls = reels.filter(r => /\/p\//.test(r.url));
  const allItems = [];

  if (reelUrls.length) {
    console.log(`  Scraping ${reelUrls.length} reel(s)...`);
    try {
      const items = await runApify(reelUrls.map(r => r.url), "reels");
      console.log(`  Apify returned ${items.length} item(s) for reels`);
      allItems.push(...items);
    } catch (e) { console.error("  Reel scrape failed:", e.message); }
  }

  if (postUrls.length) {
    console.log(`  Scraping ${postUrls.length} post(s)...`);
    try {
      const items = await runApify(postUrls.map(r => r.url), "posts");
      console.log(`  Apify returned ${items.length} item(s) for posts`);
      allItems.push(...items);
    } catch (e) { console.error("  Post scrape failed:", e.message); }
  }

  if (!allItems.length) {
    console.warn("  No data returned from Apify this run.");
    return;
  }

  let saved = 0;

  for (const reel of reels) {
    const shortCode = reel.short_code ?? extractShortCode(reel.url);
    const item = allItems.find(i =>
      (shortCode && i.shortCode === shortCode) || i.url === reel.url
    );

    if (!item) {
      console.warn(`  ✗ No Apify result for: ${reel.label}`);
      continue;
    }

    // Update reel metadata if we got new info (displayUrl, postedAt)
    if (item.displayUrl || item.timestamp) {
      await pool.query(
        `UPDATE reels SET
           display_url = COALESCE(display_url, $1),
           posted_at   = COALESCE(posted_at, $2),
           short_code  = COALESCE(short_code, $3)
         WHERE url = $4`,
        [item.displayUrl ?? null, item.timestamp ?? null, item.shortCode ?? shortCode, reel.url]
      );
    }

    const snap = {
      videoPlayCount: item.videoPlayCount ?? item.playsCount   ?? 0,
      videoViewCount: item.videoViewCount ?? null,
      likeCount:      item.likesCount     ?? item.likeCount    ?? 0,
      commentsCount:  item.commentsCount  ?? 0,
      saves:          item.savesCount     ?? item.saves        ?? 0,
      shares:         item.sharesCount    ?? item.shares       ?? 0,
    };

    await pool.query(
      `INSERT INTO snapshots
         (reel_url, captured_at, video_play_count, video_view_count, like_count, comments_count, saves, shares)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [reel.url, now, snap.videoPlayCount, snap.videoViewCount, snap.likeCount, snap.commentsCount, snap.saves, snap.shares]
    );

    saved++;

    const engRate = snap.videoPlayCount > 0
      ? ((snap.likeCount + snap.commentsCount + snap.saves) / snap.videoPlayCount * 100).toFixed(2)
      : "0.00";

    console.log(
      `  ✓ ${reel.label.padEnd(24)}` +
      `  plays: ${String(snap.videoPlayCount).padStart(8)}` +
      `  likes: ${String(snap.likeCount).padStart(6)}` +
      `  eng: ${engRate}%`
    );
  }

  console.log(`  Saved ${saved}/${reels.length} snapshots to Postgres`);
}

async function main() {
  if (!process.env.APIFY_TOKEN)    { console.error("APIFY_TOKEN not set.");    process.exit(1); }
  if (!process.env.DATABASE_URL)   { console.error("DATABASE_URL not set.");   process.exit(1); }

  await initDb();

  const runOnce = process.argv.includes("--once");
  await scrapeAndStore().catch(e => console.error("Scrape error:", e.message));

  if (runOnce) {
    console.log("\nDone (--once). Exiting.");
    await pool.end();
    return;
  }

  const mins = parseInt(process.env.INTERVAL_MINUTES ?? "30");
  console.log(`\nScheduled — next run in ${mins} min. Ctrl+C to stop.\n`);
  setInterval(
    () => scrapeAndStore().catch(e => console.error("Scrape error:", e.message)),
    INTERVAL_MS
  );
}

main();
