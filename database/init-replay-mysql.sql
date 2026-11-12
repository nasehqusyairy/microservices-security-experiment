-- Manual MySQL setup for the replay protection experiment.
-- Run with: mysql -uroot < database/init-replay-mysql.sql

CREATE DATABASE IF NOT EXISTS mse;
USE mse;

CREATE USER IF NOT EXISTS 'mse_runner'@'localhost' IDENTIFIED BY '';
CREATE USER IF NOT EXISTS 'mse_runner'@'127.0.0.1' IDENTIFIED BY '';
ALTER USER 'mse_runner'@'localhost' IDENTIFIED BY '';
ALTER USER 'mse_runner'@'127.0.0.1' IDENTIFIED BY '';
GRANT CREATE, SELECT, INSERT ON mse.* TO 'mse_runner'@'localhost';
GRANT CREATE, SELECT, INSERT ON mse.* TO 'mse_runner'@'127.0.0.1';
FLUSH PRIVILEGES;

CREATE TABLE IF NOT EXISTS consumed_tokens (
    jti_hash CHAR(64) NOT NULL PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

SELECT 'MySQL replay protection database initialized.' AS status;
