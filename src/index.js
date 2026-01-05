import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------- CONFIG ---------------- */

const PORT = process.env.PORT ?? 8080;
const MCP_AUTH_KEY = process.env.MCP_AUTH_KEY ?? "";
const SHEET_CSV_URL = process.env.SHEET_CSV_URL ?? "";

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 900);
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 3);

const TITLE_COL = process.env.TITLE_COL ?? "OU Sooners videos";
const DESC_COL = process.env.DESC_COL ?? "Description";
const URL_COL = process.env.URL_COL ?? "URL";

let cache = {
  loadedAt: 0,
  rows: []
};

/* ---------------- HELPERS ---------------- */

const nowSec = () => Math.floor(Date.now() / 1000);

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.replace(/^"|"$/g, "").trim());
    const row = {};
    headers.forEach((h, idx) => (row[h] = cols[idx] ?? ""));
    rows.push(row);
  }
  return rows;
}

async function loadSheet() {
  if (!SHEET_CSV_URL) {
    throw new Error("SHEET_CSV_URL not set");
  }
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  const text = await res.text();
  cache.rows = parseCsv(text);
  cache.loadedAt = nowSec();
  console.log(`✅ Loaded ${cache.rows.length} rows from Google Sheets`);
}

async function ensureFresh() {
  if (cache.rows.length === 0 || nowSec() - cache.loadedAt > CACHE_TTL_SECONDS) {
    await loadSheet();
  }
}

/* ---------------- SEARCH ---------------- */

function searchVideos(query) {
  const q = query.toLowerCase();

  return cache.rows
    .map(r => ({
      title: r[TITLE_COL],
      description: r[DESC_COL],
      url: r[URL_COL]
    }))
    .filter(v => v.title && v.url)
    .filter(v =>
      `${v.title} ${v.description}`.toLowerCase().includes(q)
    )
    .slice(0, MAX_RESULTS);
}

/* ---------------- HEALTH ---------------- */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "XSEN A2A Video MCP",
    cached_rows: cache.rows.length,
    cache_age_seconds: cache.loadedAt ? nowSec() - cache.loadedAt : null
  });
});

app.get("/health", (req, res) => res.send("OK"));

/* ---------------- MCP ---------------- */

app.post("/mcp", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${MCP_AUTH_KEY}`) {
      return res.status(401).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code: -32600, message: "Unauthorized" }
      });
    }

    const { jsonrpc, method, id, params } = req.body;

    if (jsonrpc !== "2.0") {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid JSON-RPC version" }
      });
    }

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

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "xsen_search",
              description: "Search OU video library and return JSON results.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" }
                },
                required: ["query"]
              }
            }
          ]
        }
      });
    }

    if (method === "tools/call" && params?.name === "xsen_search") {
      await ensureFresh();
      const results = searchVideos(params.arguments?.query ?? "");
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "json", json: { videos: results } }]
        }
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Unknown method" }
    });

  } catch (err) {
    console.error("❌ MCP Error:", err.message);
    return res.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error" }
    });
  }
});

/* ---------------- START ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 XSEN A2A Video MCP running on port ${PORT}`);
});
