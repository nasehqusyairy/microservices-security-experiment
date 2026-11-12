-- Manual MariaDB setup for replay protection experiment
-- Run with: mariadb -uroot < database/init-replay-mariadb.sql

CREATE DATABASE IF NOT EXISTS mse;
USE mse;

CREATE USER IF NOT EXISTS 'mse'@'localhost' IDENTIFIED BY '';
GRANT ALL PRIVILEGES ON mse.* TO 'mse'@'localhost';
FLUSH PRIVILEGES;

CREATE TABLE IF NOT EXISTS consumed_tokens (
    jti_hash CHAR(64) NOT NULL PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE INDEX idx_consumed_tokens_expires_at
    ON consumed_tokens (expires_at);

SELECT 'MariaDB replay protection database initialized.' AS status;
