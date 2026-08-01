PRAGMA foreign_keys = ON;

CREATE TABLE rooms (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  manager_token_hash TEXT NOT NULL CHECK(length(manager_token_hash) = 64),
  creator_session_id TEXT NOT NULL CHECK(length(creator_session_id) = 36),
  room_code TEXT NOT NULL CHECK(length(room_code) = 5 AND room_code NOT GLOB '*[^0-9]*'),
  purpose TEXT NOT NULL CHECK(purpose IN ('random', 'event', 'song', 'support', 'other')),
  song TEXT NOT NULL DEFAULT '' CHECK(length(song) <= 40),
  open_seats INTEGER NOT NULL CHECK(open_seats BETWEEN 1 AND 4),
  host_bonus INTEGER NOT NULL DEFAULT 0 CHECK(host_bonus BETWEEN 0 AND 999),
  minimum_bonus INTEGER NOT NULL DEFAULT 0 CHECK(minimum_bonus BETWEEN 0 AND 999),
  rounds INTEGER NOT NULL DEFAULT 0 CHECK(rounds BETWEEN 0 AND 99),
  rules TEXT NOT NULL DEFAULT '' CHECK(length(rules) <= 200),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'full', 'closed', 'hidden')),
  extensions INTEGER NOT NULL DEFAULT 0 CHECK(extensions BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX rooms_public_idx ON rooms(status, expires_at, created_at DESC);
CREATE INDEX rooms_creator_idx ON rooms(creator_session_id, created_at DESC);
CREATE INDEX rooms_code_idx ON rooms(room_code, status, expires_at);

CREATE TABLE room_signals (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('entered', 'full')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, session_id, kind)
);

CREATE TABLE content_reports (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  reason TEXT NOT NULL CHECK(reason IN ('invalid', 'unsafe', 'spam', 'other')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, session_id)
);

CREATE TABLE product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(name IN ('visited', 'room_created', 'room_code_copied', 'entry_confirmed', 'board_filtered', 'room_managed', 'returned')),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  room_id TEXT NOT NULL DEFAULT '' CHECK(length(room_id) IN (0, 32)),
  day TEXT NOT NULL CHECK(length(day) = 10),
  created_at INTEGER NOT NULL,
  is_qa INTEGER NOT NULL DEFAULT 0 CHECK(is_qa IN (0, 1)),
  UNIQUE(name, session_id, room_id, day)
);

CREATE INDEX product_events_day_idx ON product_events(day, name, is_qa);
