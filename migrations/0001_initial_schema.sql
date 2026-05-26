-- Mirrors the legacy localStorage shape (kids_library_v1 / DEFAULT_STATE
-- version 4) with a few normalization changes:
--   - readsByKid:{kidId:count} → book_reads(kid_id, book_isbn, count)
--   - cover (URL or data-URL) → cover_url (external) + cover_r2_key (R2)
--   - lastShelfStint kept as JSON; one-shelf-stint history is what the
--     legacy app stored, normalizing it into a stints table would be
--     scope creep.
-- Adds created_by_email on writeable entities so we know which family
-- member added each book / review once we have multiple users.

CREATE TABLE kids (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  age               INTEGER,
  interests         TEXT,
  notes             TEXT,
  created_by_email  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE books (
  isbn               TEXT PRIMARY KEY,
  title              TEXT,
  author             TEXT,
  cover_url          TEXT,
  cover_r2_key       TEXT,
  source             TEXT NOT NULL DEFAULT 'owned'    CHECK (source IN ('owned', 'library')),
  location           TEXT NOT NULL DEFAULT 'backstock' CHECK (location IN ('accessible', 'backstock')),
  added_date         TEXT NOT NULL DEFAULT (datetime('now')),
  placed_on_shelf_at TEXT,
  last_shelf_stint   TEXT,
  created_by_email   TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX books_location ON books(location);
CREATE INDEX books_source   ON books(source);

CREATE TABLE book_reads (
  kid_id     TEXT NOT NULL REFERENCES kids(id)    ON DELETE CASCADE,
  book_isbn  TEXT NOT NULL REFERENCES books(isbn) ON DELETE CASCADE,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kid_id, book_isbn)
);

CREATE INDEX book_reads_book ON book_reads(book_isbn);

CREATE TABLE reviews (
  id                TEXT PRIMARY KEY,
  kid_id            TEXT NOT NULL REFERENCES kids(id)    ON DELETE CASCADE,
  book_isbn         TEXT NOT NULL REFERENCES books(isbn) ON DELETE CASCADE,
  rating            INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  liked             TEXT,
  disliked          TEXT,
  notes             TEXT,
  date_read         TEXT,
  created_by_email  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX reviews_kid  ON reviews(kid_id);
CREATE INDEX reviews_book ON reviews(book_isbn);
