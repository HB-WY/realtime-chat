// src/db/index.js
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const setupSchema = require('./schema');
const seed = require('./seed');

const db = new DatabaseSync(config.DB_PATH);

db.exec(`PRAGMA journal_mode = ${config.DB_JOURNAL_MODE};`);
db.exec(`PRAGMA foreign_keys = ${config.DB_FOREIGN_KEYS ? 'ON' : 'OFF'};`);

setupSchema(db);
const { OFFICIAL_USER_ID, OFFICIAL_USERNAME } = seed(db);

module.exports = { db, OFFICIAL_USER_ID, OFFICIAL_USERNAME };