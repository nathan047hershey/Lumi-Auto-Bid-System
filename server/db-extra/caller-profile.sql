-- Caller-entered profile info (lightweight, separate from candidate_profiles).
-- One row per caller user. The form lives at /caller/profile.
CREATE TABLE IF NOT EXISTS caller_profile_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id INTEGER NOT NULL UNIQUE,
  profile_info TEXT,
  years_of_experience TEXT,
  main_tech_stack TEXT,
  availability TEXT,
  availability_this_week TEXT,
  location TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE
);
