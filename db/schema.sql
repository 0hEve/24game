-- Application-owned schema. This migration only creates missing objects; it
-- never resets players, sessions, rounds, or the permanent rating ledger.
CREATE SCHEMA IF NOT EXISTS club24;

CREATE TABLE IF NOT EXISTS club24.players (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9_-]{3,20}$'),
  name_key text NOT NULL UNIQUE CHECK (name_key = lower(name)),
  rating integer NOT NULL DEFAULT 1000 CHECK (rating >= 0),
  peak_rating integer NOT NULL DEFAULT 1000,
  games integer NOT NULL DEFAULT 0,
  fast_streak integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club24_players_leaderboard ON club24.players (rating DESC, created_at, id);

CREATE TABLE IF NOT EXISTS club24.sessions (
  token_hash text PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES club24.players(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS club24_sessions_player ON club24.sessions(player_id);

CREATE TABLE IF NOT EXISTS club24.runs (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES club24.players(id),
  cards jsonb NOT NULL,
  target integer NOT NULL,
  settings jsonb NOT NULL,
  witness jsonb NOT NULL,
  board jsonb NOT NULL,
  snapshots jsonb NOT NULL DEFAULT '[]',
  moves jsonb NOT NULL DEFAULT '[]',
  fingerprint text NOT NULL,
  difficulty integer NOT NULL,
  par_seconds numeric NOT NULL,
  rating_version text NOT NULL DEFAULT 'v2',
  ranked boolean NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  hint_count integer NOT NULL DEFAULT 0,
  undo_count integer NOT NULL DEFAULT 0,
  restart_count integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  penalty_paid integer NOT NULL DEFAULT 0,
  harsh_penalty_paid integer NOT NULL DEFAULT 0,
  revealed boolean NOT NULL DEFAULT false,
  rating_before integer NOT NULL,
  rating_after integer,
  delta integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS club24_one_active_run ON club24.runs(player_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS club24_runs_seen ON club24.runs(player_id, fingerprint);

CREATE TABLE IF NOT EXISTS club24.run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES club24.players(id),
  run_id uuid REFERENCES club24.runs(id),
  request_id text NOT NULL,
  action text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id, request_id)
);
CREATE INDEX IF NOT EXISTS club24_events_rate ON club24.run_events(player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS club24.rating_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES club24.players(id),
  run_id uuid REFERENCES club24.runs(id),
  event_key text NOT NULL,
  rating_before integer NOT NULL,
  rating_after integer NOT NULL,
  delta integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club24_history_player ON club24.rating_history(player_id, id DESC);

-- Forward-only upgrades for an existing local installation. Old history is
-- retained and receives a unique legacy event key rather than being rewritten.
ALTER TABLE club24.players ADD COLUMN IF NOT EXISTS fast_streak integer NOT NULL DEFAULT 0;
ALTER TABLE club24.players DROP CONSTRAINT IF EXISTS players_name_check;
ALTER TABLE club24.players ADD CONSTRAINT players_name_check CHECK (name ~ '^[A-Za-z0-9_-]{3,20}$');
ALTER TABLE club24.runs ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE club24.runs ADD COLUMN IF NOT EXISTS penalty_paid integer NOT NULL DEFAULT 0;
ALTER TABLE club24.runs ADD COLUMN IF NOT EXISTS harsh_penalty_paid integer NOT NULL DEFAULT 0;
ALTER TABLE club24.runs ALTER COLUMN rating_version SET DEFAULT 'v2';
ALTER TABLE club24.rating_history DROP CONSTRAINT IF EXISTS rating_history_run_id_key;
ALTER TABLE club24.rating_history ADD COLUMN IF NOT EXISTS event_key text;
UPDATE club24.rating_history SET event_key = 'legacy:' || id WHERE event_key IS NULL;
ALTER TABLE club24.rating_history ALTER COLUMN event_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS club24_history_event ON club24.rating_history(event_key);

CREATE TABLE IF NOT EXISTS club24.request_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY(bucket, window_start)
);
