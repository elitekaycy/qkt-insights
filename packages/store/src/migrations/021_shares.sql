-- Public share links. One row per shared subject: the instance overview (subject ''),
-- a portfolio group, or a strategy. visibility NULL means "inherit"; the token is the
-- bearer secret in the public link and survives visibility changes until rotated.
CREATE TABLE IF NOT EXISTS shares (
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('overview', 'portfolio', 'strategy')),
  subject TEXT NOT NULL DEFAULT '',
  visibility TEXT CHECK (visibility IN ('public', 'private')),
  token TEXT NOT NULL UNIQUE,
  -- 1 once the token has been shown while the subject was public; cleared when it is replaced.
  exposed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, kind, subject)
);
