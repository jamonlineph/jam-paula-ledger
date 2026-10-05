-- Jam & Paula Ledger: initial schema

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- small JSON documents: 'settings', 'sheets_state'
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE weeks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created TEXT NOT NULL,
  ratio_p REAL NOT NULL,
  paid TEXT,
  meta TEXT NOT NULL DEFAULT '{}',   -- imports list, Notion link map, other app-only fields
  count INTEGER NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  settle REAL NOT NULL DEFAULT 0,
  min_date TEXT,
  max_date TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE txns (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  card TEXT NOT NULL,
  mode TEXT,
  p REAL NOT NULL DEFAULT 0,
  j REAL NOT NULL DEFAULT 0,
  s REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  src TEXT NOT NULL DEFAULT 'csv',
  sug INTEGER NOT NULL DEFAULT 0,
  imp TEXT,
  dup_ok INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX txns_week ON txns(week_id);
CREATE INDEX txns_date ON txns(date);

-- tokens that let an AI client use the MCP endpoint (stored hashed)
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_used TEXT
);

INSERT INTO kv (key, value, updated_at) VALUES (
  'settings',
  '{"names":{"p":"Paula","j":"Jam"},"ratioP":56,"importCard":"main","hiddenQuick":[],"fileCards":{},"cards":[{"id":"main","name":"Main credit card","payer":"j"},{"id":"other","name":"Other card","payer":"j"},{"id":"cash","name":"Cash / e-transfer","payer":"j"}],"notion":{"pageUrl":"https://app.notion.com/p/3ed0815a353c81f8b4c3c08d8a1ed7dd","weeksDs":"26a8a6bd-1d95-4f47-a5b8-3a28925f8101","ledgerDs":"1d3d5aad-2b90-41a8-894d-08adb6e53ed1","weeksUrl":"https://app.notion.com/p/b85602a6e48942c0a39488ef00e76340","ledgerUrl":"https://app.notion.com/p/96eaeb542bd04926bc20d682f9d84248"}}',
  datetime('now')
);
INSERT INTO kv (key, value, updated_at) VALUES ('sheets_state', '{"dirty":false}', datetime('now'));
