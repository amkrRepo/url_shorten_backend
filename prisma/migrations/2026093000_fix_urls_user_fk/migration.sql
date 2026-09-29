ALTER TABLE urls
DROP CONSTRAINT fk_urls_foreign_key;

ALTER TABLE urls
ADD CONSTRAINT fk_urls_foreign_key
FOREIGN KEY (user_id)
REFERENCES users(id);
