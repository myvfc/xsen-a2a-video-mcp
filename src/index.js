import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * -------------------------------
 * ENV
 * -------------------------------
 * Required:
 *  - MCP_AUTH_KEY            (Bearer token expected by /mcp)
 *  - SHEET_ID                (Google Sheet ID)
 *
 * Choose ONE of the following ways to read the sheet:
 *
 * Option A (recommended if possible): publish the sheet tab to web as CSV
 *  - SHEET_CSV_URL           (full published CSV URL)
 *
 * Option B: Google Sheets API key (read-only)
 *  - GOOGLE_SHEETS_API_KEY
 *  - SHEET_RANGE             (e.g. "Sheet1!A:Z")
 *
 * Optional:
 *  - PORT                    (Railway sets this)
 *  - CACHE_TTL_SECONDS       (default 900)
 *  - MAX_RESULTS             (default 3)
 *  - TITLE_COL               (default "OU Sooners videos")
 *  - DESC_COL                (default "Description")
 *  - URL_COL                 (default "URL")
 */

const PORT = process.env.PORT ?? 8080;
const MCP_AUTH_KEY = process.env.MCP_AUTH_KEY ?? "";
const SHEET_ID = process.env.SHEET_ID ?? "";

const SHEET_CSV_URL = process.env.SHEET_CSV_URL ?? ""; // Option A
const GOOGLE_SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY ?? ""; // Option B
const SHEET_RANGE = process.env.SHEET_RANGE ?? "Sheet1!A:Z";

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 900);
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 3);

const TITLE_COL = process.env.TITLE_COL ?? "OU Sooners videos";
const DESC_COL = process.env.DESC_COL ?? "Description";
const URL_COL = process.env.URL_COL ?? "URL";

let cache = {
  loadedAt: 0,
  rows: [] // array of objects {colName: value}
};

/* -------------------------------
 * Helpers
 * ------------------------------- */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalize(s) {
  return (s ?? "").toString().trim();
}

function lower(s) {
  return normalize(s).toLowerCase();
}

/**
 * Very small CSV parser (good enough for normal Sheets exports).
 * If your data contains heavy quoting/commas/newlines inside cells,
 * you may want to swap to a CSV library later.
 */
function parseCsvSimple(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  // naive split by comma; assumes no embedded commas in cells
  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const row = {};
    headers.forEach((h, idx) => (row[h] = cols[idx] ?? ""));
    rows.push(row);
  }
  return rows;
}

/**
 * Option B: Google Sheets API v4 values endpoint (simple).
 * Returns array of objects keyed by header row.
 */
async function fetchSheetViaApiKey() {
  if (!SHEET_ID) throw new Error("Missing SHEET_ID");
  if (!GOOGLE_SHEETS_API_KEY) throw new Error("Missing GOOGLE_SHEETS_API_KEY");

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}?key=${encodeURIComponent(GOOGLE_SHEETS_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}`);
  const data = await res.json();

  const values = data.values ?? [];
  if (values.length < 2) return [];

  const headers = values[0].map((h) => normalize(h));
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const rowArr = values[i];
    const row = {};
    headers.forEach((h, idx) => (row[h] = rowArr[idx] ?? ""));
    rows.push(row);
  }
  return rows;
}

async function fetchSheetRows() {
  // Option A: Published CSV URL (fastest + simplest)
  if (SHEET_CSV_URL) {
    const res = await fetch(SHEET_CSV_URL);
    if (!res.ok) throw new Error(`CSV fetch HTTP ${res.status}`);
    const csvText = await res.text();
    return parseCsvSimple(csvText);
  }

  // Option B: API key
  if (GOOGLE_SHEETS_API_KEY) {
    return fetchSheetViaApiKey();
  }

  throw new Error(
    "No sheet reader configured. Set SHEET_CSV_URL OR GOOGLE_SHEETS_API_KEY + SHEET_RANGE."
  );
}

async function ensureCacheFresh() {
  const age = nowSec() - cache.loadedAt;
  if (cache.rows.length > 0 && age < CACHE_TTL_SECONDS) return;

  const rows = await fetchSheetRows();
  cache = { loadedAt: nowSec(), rows };
  console.log(`✅ Loaded ${rows.length} rows from Google Sheets`);
}

/* -------------------------------
 * Search logic (JSON-only)
 * ------------------------------- */

function searchVideos(query) {
  const q = lower(query);
  if (!q) return [];

  const matches = cache.rows
    .map((r) => {
      const title = normalize(r[TITLE_COL]);
      const desc = normalize(r[DESC_COL]);
      const url = normalize(r[URL_COL]);

      return {
        title,
        description: desc,
        url
      };
    })
    .filter((v) => {
      // Only return rows that have required fields
      if (!v.title || !v.url) return false;
      const hay = `${v.title} ${v.description}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, MAX_RESULTS);

  // IMPORTANT: No rewriting. Return URL exactly as stored in the sheet.
  return matches;
}

/* -------------------------------
 * Health endpoints
 * ------------------------------- */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "XSEN A2A Video MCP (JSON-only)",
    cached_rows: cache.rows.length,
    cache_age_seconds: cache.loadedAt ? nowSec() - cache.loadedAt : null
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* -------------------------------
 * MCP endpoint (JSON-RPC)
 * ------------------------------- */

app.post("/mcp", async (req, res) => {
  try {
    // Auth check
    const authHeader = req.headers.authorization || "";
    const expected = `Bearer ${MCP_AUTH_KEY}`;

    if (!MCP_AUTH_KEY) {
      return res.status(500).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code: -32000, message: "Server missing MCP_AUTH_KEY" }
      });
    }

    if (authHeader !== expected) {
      return res.status(401).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code: -32600, message: "Unauthorized" }
      });
    }

    const { jsonrpc, method, id, params } = req.body || {};

    if (jsonrpc !== "2.0") {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid JSON-RPC version" }
      });
    }

    // Initialize
    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "XSEN A2A Video MCP", version: "1.0.0" },
          capabilities: { tools: {} }
        }
      });
    }

    if (method === "notifications/initialized") {
      return res.status(200).end();
    }

    // List tools
    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "xsen_search",
              description:
                "Search the XSEN video library (from Google Sheets) and return JSON video objects (title, url, description). No HTML, no embedding, no URL rewriting.",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Search query, e.g. 'Baker Mayfield highlights'"
                  }
               
