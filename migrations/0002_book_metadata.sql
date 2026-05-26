-- Adds legacy fields I missed in 0001: authors (array), subjects (array),
-- publishYear (string). Stored as JSON text columns rather than separate
-- tables — at family scale a book has ~1-3 authors and ~5-8 subjects;
-- normalizing would add joins for no real benefit.
--
-- The `author` single-string column from 0001 stays for backward compat
-- with anything that wrote rows with single-author shape (none yet —
-- DBs were empty when this lands). New writes go through authors_json.
-- API mappers prefer authors_json, falling back to author if absent.

ALTER TABLE books ADD COLUMN authors_json TEXT;
ALTER TABLE books ADD COLUMN subjects_json TEXT;
ALTER TABLE books ADD COLUMN publish_year TEXT;
