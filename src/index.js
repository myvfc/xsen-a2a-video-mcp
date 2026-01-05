import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT ?? 8080;
const MCP_AUTH_KEY = process.env.MCP_AUTH_KEY ?? "";
const SHEET_CSV_URL = process.env.SHEET_CSV_URL ?? "";

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 900);
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 3);

const TITLE_COL = process.env.TITLE_COL ?? "OU Sooners videos";
const DESC_COL = process.env.DESC_COL ?? "Description";
const URL_COL = process.env.URL_COL ?? "URL";

/* -------------------------------------------------------------------------- */
/*                                   CACHE                                    */
/* -------------------------------------------------------------------------- */

let cache = {
  loadedAt: 0,
  rows: []
};

const nowSec = () => Math.floor(Date.now() / 1000);

/* -------------------------------------------------------------------------- */
/*                              CSV LOADING                                   */
/* -------------------------------------------------------------------------- */

async function loadSheet() {
  if (!SHEET_CSV_URL) {
    throw new Error("SHEET_CSV_URL not set");
  }

  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch CSV: HTTP ${res.status}`);
  }

  const csvText = await res.text();

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true
  });

  cache.rows = records;
  cache.loadedAt = nowSec();

  console.log(`✅ Loaded ${records.length} rows from Google Sheets`);
}

async function ensureFresh() {
  if (
    cache.rows.length === 0 ||
    nowSec() - cache.loadedAt > CACHE_TTL_SECONDS
  ) {
    await loadSheet();
  }
}

/* -------------------------------------------------------------------------- */
/*                                SEARCH LOGIC                                */
/* -------------------------------------------------------------------------- */

function searchVideos(query) {
  const q = query.toLowerCase();

  return cache.rows
    .map(row => ({
      title: row[TITLE_COL] ?? "",
      description: row[DESC_COL] ?? "",
      url: row[URL_COL] ?? ""
    }))
    .filter(v => v.title && v.url)
    .filter(v =>
      `${v.title} ${v.description}`.toLowerCase().includes(q)
    )
    .slice(0, MAX_RESULTS);
}

/* -------------------------------------------------------------------------- */
/*                               HEALTH ROUTES                                */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "XSEN A2A Video MCP",
    cached_rows: cache.rows.length,
    cache_age_seconds: cache.loadedAt
      ? nowSec() - cache.loadedAt
      : null
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* -------------------------------------------------------------------------- */
/*                                MCP ENDPOINT                                */
/* -------------------------------------------------------------------------- */

app.post("/mcp", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${MCP_AUTH_KEY}`) {
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

    /* ---------------------------- INITIALIZE ---------------------------- */

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "XSEN A2A Video MCP",
            version: "1.0.0"
          },
          capabilities: { tools: {} }
        }
      });
    }

    if (method === "notifications/initialized") {
      return res.status(200).end();
    }

    /* ----------------------------- LIST TOOLS ---------------------------- */

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "xsen_search",
              description:
                "Search the XSEN video library and return JSON video results (title, description, url).",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description:
                      "Search query, e.g. 'Baker Mayfield highlights'"
                  }
                },
                required: ["query"]
              }
            }
          ]
        }
      });
    }

    /* ----------------------------- CALL TOOL ----------------------------- */

    if (method === "tools/call" && params?.name === "xsen_search") {
      await ensureFresh();

      const query = params?.arguments?.query ?? "";
      const videos = searchVideos(query);

      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "json",
              json: { videos }
            }
          ]
        }
      });
    }

    /* ----------------------------- FALLBACK ------------------------------ */

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

/* -------------------------------------------------------------------------- */
/*                                START SERVER                                */
/* -------------------------------------------------------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 XSEN A2A Video MCP running on port ${PORT}`);
});
