CREATE TABLE line_friend_attribution (
  subject TEXT PRIMARY KEY,
  follow_id TEXT,
  followed_at INTEGER,
  visited_at INTEGER,
  fbp TEXT,
  fbc TEXT,
  claim_until INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX line_friend_attribution_expiry ON line_friend_attribution(expires_at);
