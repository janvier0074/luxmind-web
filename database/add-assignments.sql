CREATE TABLE IF NOT EXISTS assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id       INTEGER NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  deadline        TEXT,
  max_points      INTEGER DEFAULT 100,
  attachment_path TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id   INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  file_path       TEXT,
  file_name       TEXT,
  text_content    TEXT,
  submitted_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  score           INTEGER,
  feedback        TEXT,
  graded_by       INTEGER,
  graded_at       TEXT,
  UNIQUE(assignment_id, user_id),
  FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);