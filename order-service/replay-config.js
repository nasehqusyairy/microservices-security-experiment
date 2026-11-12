module.exports = {
  redis: {
    url: "redis://127.0.0.1:6379"
  },
  mariadb: {
    host: "127.0.0.1",
    // The isolated experiment database uses host port 3308; native MariaDB can use 3306.
    port: 3308,
    database: "mse",
    user: "root",
    password: "",
    connectionLimit: 10,
    connectTimeout: 5000,
    multipleStatements: false
  }
};
