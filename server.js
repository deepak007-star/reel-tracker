/**
 * server.js — dashboard at http://localhost:3333 (or Render's PORT)
 * Run: node server.js
 */

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { pool, initDb } from "./db.js";
import { scrapeAndSave } from "./scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT ?? process.env.DASHBOARD_PORT ?? "3333");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Read APIs ──────────────────────────────────────────────────────────────────

// Returns data in same shape as old JSON file so the frontend needs no change:
// { [url]: { label, url, shortCode, displayUrl, postedAt, snapshots: [...] } }
app.get("/api/data", async (_req, res) => {
  try {
    const { rows: reels } = await pool.query("SELECT * FROM reels ORDER BY created_at");
    const { rows: snaps } = await pool.query("SELECT * FROM snapshots ORDER BY reel_url, captured_at ASC");

    const data = {};
    for (const r of reels) {
      data[r.url] = {
        label:      r.label,
        url:        r.url,
        shortCode:  r.short_code,
        displayUrl: r.display_url,
        postedAt:   r.posted_at,
        snapshots:  snaps
          .filter(s => s.reel_url === r.url)
          .map(s => ({
            capturedAt:     s.captured_at,
            videoPlayCount: s.video_play_count,
            videoViewCount: s.video_view_count,
            likeCount:      s.like_count,
            commentsCount:  s.comments_count,
            saves:          s.saves,
            shares:         s.shares,
          })),
      };
    }
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/reels", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT url, label FROM reels ORDER BY created_at");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Add a reel ─────────────────────────────────────────────────────────────────

app.post("/api/reels", async (req, res) => {
  const { url, label } = req.body ?? {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }
  if (!/instagram\.com\/(reel|p)\/[A-Za-z0-9_-]+/.test(url)) {
    return res.status(400).json({ error: "Not a valid Instagram reel/post URL" });
  }

  const clean      = url.split("?")[0].replace(/\/?$/, "/");
  const shortCode  = clean.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/)?.[2] ?? null;
  const entryLabel = label?.trim() || shortCode || clean;

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO reels (url, label, short_code) VALUES ($1, $2, $3)
       ON CONFLICT (url) DO NOTHING`,
      [clean, entryLabel, shortCode]
    );
    console.log(`  + Added reel: ${entryLabel}`);
    res.json({ ok: true, entry: { url: clean, label: entryLabel } });

    // Fire an immediate first scrape in the background — don't block the response.
    if (rowCount > 0) {
      scrapeAndSave([{ url: clean, label: entryLabel, short_code: shortCode }])
        .catch(e => console.error(`  Background scrape failed for ${entryLabel}:`, e.message));
    }
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "URL already tracked" });
    res.status(500).json({ error: e.message });
  }
});

// ── Remove a reel ──────────────────────────────────────────────────────────────

app.delete("/api/reels", async (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const { rowCount } = await pool.query("DELETE FROM reels WHERE url = $1", [url]);
    if (!rowCount) return res.status(404).json({ error: "URL not found" });
    console.log(`  - Removed reel: ${url}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scrape endpoint (called by external cron, e.g. cron-job.org) ──────────────
// Responds immediately with 202 so cron-job.org doesn't timeout or hit its
// response-size limit while Apify runs (~5 min). Scrape continues in background.

app.post("/api/scrape", async (req, res) => {
  const secret = process.env.SCRAPE_SECRET;
  if (secret && req.headers["x-scrape-token"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { rows: reels } = await pool.query(
      "SELECT url, label, short_code FROM reels ORDER BY created_at"
    );

    // Acknowledge immediately — Apify takes up to 5 min and cron-job.org will abort otherwise.
    res.status(202).json({ ok: true, queued: reels.length });

    if (!reels.length) return;

    scrapeAndSave(reels).catch(e => console.error("Background scrape error:", e.message));
  } catch (e) {
    console.error("Scrape endpoint error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set. Copy .env.example → .env and add it.");
    process.exit(1);
  }

  await initDb();
  app.listen(PORT, () => {
    console.log(`\nDashboard → http://localhost:${PORT}`);
  });
}

main();
