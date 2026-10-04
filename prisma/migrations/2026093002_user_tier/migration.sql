ALTER TABLE users
ADD COLUMN tier VARCHAR(255) DEFAULT 'free'
CHECK (tier IN ('free', 'enterprise'));