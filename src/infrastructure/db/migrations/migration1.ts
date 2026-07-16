export const MIGRATION_1_SQL = String.raw`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE baby_profile (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  name TEXT,
  sex TEXT CHECK (sex IN ('male', 'female') OR sex IS NULL),
  birth_date TEXT,
  birth_weight_g INTEGER,
  birth_height_cm REAL,
  birth_head_cm REAL,
  is_premature INTEGER NOT NULL DEFAULT 0 CHECK (is_premature IN (0, 1)),
  gestational_weeks INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'completed', 'failed', 'cancelled')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 100),
  error_code TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (id, conversation_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'data_card', 'safety_alert')),
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, conversation_id),
  UNIQUE (turn_id, role, ordinal),
  FOREIGN KEY (turn_id, conversation_id)
    REFERENCES chat_turns(id, conversation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_messages_one_user_per_turn
ON messages(turn_id)
WHERE role = 'user';

CREATE UNIQUE INDEX uq_messages_one_assistant_per_turn
ON messages(turn_id)
WHERE role = 'assistant';

CREATE VIRTUAL TABLE message_search_fts USING fts5(
  content,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO message_search_fts(message_search_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO message_search_fts(message_search_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO message_search_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE growth_records (
  id TEXT PRIMARY KEY,
  measurement_date TEXT NOT NULL,
  weight_g INTEGER CHECK (weight_g BETWEEN 100 AND 50000 OR weight_g IS NULL),
  height_cm REAL CHECK (height_cm BETWEEN 10.0 AND 150.0 OR height_cm IS NULL),
  head_cm REAL CHECK (head_cm BETWEEN 10.0 AND 100.0 OR head_cm IS NULL),
  weight_percentile REAL CHECK (weight_percentile BETWEEN 0.0 AND 100.0 OR weight_percentile IS NULL),
  height_percentile REAL CHECK (height_percentile BETWEEN 0.0 AND 100.0 OR height_percentile IS NULL),
  head_percentile REAL CHECK (head_percentile BETWEEN 0.0 AND 100.0 OR head_percentile IS NULL),
  notes TEXT,
  source_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (weight_g IS NOT NULL OR height_cm IS NOT NULL OR head_cm IS NOT NULL)
);

CREATE TABLE feeding_records (
  id TEXT PRIMARY KEY,
  feed_time TEXT NOT NULL,
  feed_type TEXT NOT NULL CHECK (feed_type IN ('breast', 'formula', 'solid')),
  amount_ml INTEGER CHECK (amount_ml BETWEEN 0 AND 2000 OR amount_ml IS NULL),
  duration_min INTEGER CHECK (duration_min BETWEEN 0 AND 1440 OR duration_min IS NULL),
  notes TEXT,
  source_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (feed_type != 'formula' OR amount_ml IS NOT NULL),
  CHECK (feed_type != 'breast' OR duration_min IS NOT NULL)
);

CREATE TABLE sleep_records (
  id TEXT PRIMARY KEY,
  sleep_start TEXT NOT NULL,
  sleep_end TEXT,
  sleep_type TEXT NOT NULL CHECK (sleep_type IN ('nap', 'night')),
  night_wakings INTEGER NOT NULL DEFAULT 0 CHECK (night_wakings BETWEEN 0 AND 100),
  notes TEXT,
  source_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (sleep_type != 'nap' OR night_wakings = 0)
);

CREATE TABLE diaper_records (
  id TEXT PRIMARY KEY,
  diaper_time TEXT NOT NULL,
  diaper_type TEXT NOT NULL CHECK (diaper_type IN ('poop', 'pee', 'mixed')),
  notes TEXT,
  source_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE health_records (
  id TEXT PRIMARY KEY,
  record_date TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('vaccination', 'illness', 'checkup')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description TEXT,
  source_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_growth_records_date ON growth_records(measurement_date, deleted_at);
CREATE INDEX idx_feeding_records_time ON feeding_records(feed_time, deleted_at);
CREATE INDEX idx_sleep_records_start ON sleep_records(sleep_start, deleted_at);
CREATE INDEX idx_diaper_records_time ON diaper_records(diaper_time, deleted_at);
CREATE INDEX idx_health_records_date ON health_records(record_date, deleted_at);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at, id);

CREATE TABLE pending_agent_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('tracker_create', 'tracker_update', 'tracker_delete', 'baby_profile_update')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_confirmation', 'completed', 'cancelled', 'expired')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  payload_json TEXT NOT NULL,
  missing_slots_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_turn_id, conversation_id)
    REFERENCES chat_turns(id, conversation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_pending_agent_task_active
ON pending_agent_tasks((1))
WHERE status IN ('pending', 'awaiting_confirmation');

CREATE TABLE local_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  lease_owner TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_local_job_active_dedupe
ON local_jobs(dedupe_key)
WHERE status IN ('queued', 'leased');

CREATE TABLE committed_job_effects (
  effect_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES local_jobs(id),
  result_hash TEXT,
  committed_at TEXT NOT NULL
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('baby', 'user', 'agent')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
  content TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  superseded_by_id TEXT REFERENCES memory_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  through_message_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, through_message_id),
  FOREIGN KEY (through_message_id, conversation_id)
    REFERENCES messages(id, conversation_id) ON DELETE CASCADE
);

CREATE TABLE model_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  chat_path TEXT NOT NULL,
  model_id TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'custom')),
  header_names_json TEXT NOT NULL,
  secret_revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_capabilities (
  config_fingerprint TEXT NOT NULL,
  probe_version INTEGER NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('supported', 'unsupported', 'error')),
  error_code TEXT,
  probed_at TEXT NOT NULL,
  PRIMARY KEY (config_fingerprint, probe_version, capability)
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  storage_path TEXT NOT NULL UNIQUE,
  thumbnail_cache_key TEXT,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  import_state TEXT NOT NULL CHECK (import_state IN ('staging', 'committed', 'deleting')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE photo_tags (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL CHECK (tag_type IN ('scene', 'expression', 'milestone')),
  tag_value TEXT NOT NULL,
  confidence REAL,
  is_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (is_confirmed IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE diagnostic_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  correlation_id TEXT,
  result_category TEXT NOT NULL,
  duration_ms INTEGER,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memory_items_scope_status ON memory_items(scope, status, updated_at);
CREATE INDEX idx_local_jobs_schedule ON local_jobs(status, next_attempt_at, lease_expires_at);
CREATE INDEX idx_diagnostic_events_created ON diagnostic_events(created_at, event_name);
CREATE INDEX idx_photos_taken_deleted ON photos(taken_at, deleted_at);
`;

export const MIGRATION_1_SHA256 = "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec";
