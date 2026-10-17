CREATE TABLE request_logs (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    time_stamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    http_method VARCHAR(10) NOT NULL,
    url TEXT NOT NULL,
    user_agent TEXT,
    ip VARCHAR(75) NOT NULL
);

CREATE INDEX idx_request_time_logs ON request_logs (time_stamp);