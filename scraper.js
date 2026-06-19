import { ApifyClient } from "apify-client";
import { pool } from "./db.js";

const IG_ACTOR = process.env.APIFY_IG_ACTOR_ID ?? "apify~instagram-scraper";

function extractShortCode(url) {
  const m = url.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/);
  return m ? m[2] : null;
}

async function runApify(urls) {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  // resultsType "posts" works for both /reel/ and /p/ direct URLs.
  // "reels" is only for scraping a profile's reels tab — not individual post URLs.
  const run = await client.actor(IG_ACTOR).call(
    { directUrls: urls, resultsType: "posts" },
    { waitSecs: 300 }
  );
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}

/**
 * Scrapes Apify for the given reels and saves snapshots to Postgres.
 * @param {Array<{url: string, label: string, short_code: string|null}>} reels
 * @returns {Promise<number>} number of snapshots saved
 */
export async function scrapeAndSave(reels) {
  if (!reels.length) return 0;

  const now = new Date().toISOString();
  console.log(`\n[${now}] Scraping ${reels.length} URL(s) via Apify...`);

  let items = [];
  try {
    items = await runApify(reels.map(r => r.url));
    console.log(`  Apify returned ${items.length} item(s)`);
  } catch (e) {
    console.error("  Apify scrape failed:", e.message);
    return 0;
  }

  if (!items.length) {
    console.warn("  No data returned from Apify this run.");
    return 0;
  }

  let saved = 0;

  for (const reel of reels) {
    const shortCode = reel.short_code ?? extractShortCode(reel.url);
    const item = items.find(i =>
      (shortCode && i.shortCode === shortCode) || i.url === reel.url
    );

    if (!item) {
      console.warn(`  ✗ No Apify result for: ${reel.label}`);
      continue;
    }

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
      videoPlayCount: item.videoPlayCount ?? item.playsCount  ?? 0,
      videoViewCount: item.videoViewCount ?? null,
      likeCount:      item.likesCount     ?? item.likeCount   ?? 0,
      commentsCount:  item.commentsCount  ?? 0,
      saves:          item.savesCount     ?? item.saves       ?? 0,
      shares:         item.sharesCount    ?? item.shares      ?? 0,
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

  console.log(`  Saved ${saved}/${reels.length} snapshots`);
  return saved;
}
