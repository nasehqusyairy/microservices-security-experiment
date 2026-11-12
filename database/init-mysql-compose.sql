-- MySQL initialization for the isolated replay experiment database.
CREATE DATABASE IF NOT EXISTS mse;
CREATE USER IF NOT EXISTS 'mse_runner'@'%' IDENTIFIED BY '';
ALTER USER 'mse_runner'@'%' IDENTIFIED BY '';
GRANT CREATE, SELECT, INSERT ON mse.* TO 'mse_runner'@'%';

CREATE TABLE IF NOT EXISTS mse.consumed_tokens (
    jti_hash CHAR(64) NOT NULL PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

FLUSH PRIVILEGES;
