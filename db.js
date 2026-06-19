import pg from "pg";
const { Pool } = pg;

const isLocal = process.env.DATABASE_URL?.includes("localhost") ||
                process.env.DATABASE_URL?.includes("127.0.0.1");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reels (
      url         TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      short_code  TEXT,
      display_url TEXT,
      posted_at   TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id                SERIAL PRIMARY KEY,
      reel_url          TEXT        NOT NULL REFERENCES reels(url) ON DELETE CASCADE,
      captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      video_play_count  INTEGER     NOT NULL DEFAULT 0,
      video_view_count  INTEGER,
      like_count        INTEGER     NOT NULL DEFAULT 0,
      comments_count    INTEGER     NOT NULL DEFAULT 0,
      saves             INTEGER     NOT NULL DEFAULT 0,
      shares            INTEGER     NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS snapshots_reel_time ON snapshots (reel_url, captured_at);
  `);
  console.log("  DB ready");
}
