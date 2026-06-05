-- FTS5 full-text search over messages.content.
--
-- The virtual table indexes (chat_id, role, content) so we can scope
-- searches per-chat OR across the whole user, while still filtering
-- out pending/streaming rows in the application layer.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  user_id UNINDEXED,
  chat_id UNINDEXED,
  role UNINDEXED,
  content,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO messages_fts (message_id, user_id, chat_id, role, content)
SELECT id, user_id, chat_id, role, content FROM messages
WHERE NOT EXISTS (
  SELECT 1 FROM messages_fts WHERE messages_fts.message_id = messages.id
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (message_id, user_id, chat_id, role, content)
  VALUES (new.id, new.user_id, new.chat_id, new.role, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  UPDATE messages_fts
  SET content = new.content,
      role = new.role,
      chat_id = new.chat_id,
      user_id = new.user_id
  WHERE message_id = old.id;
END;
