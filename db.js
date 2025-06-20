// db.js – simple SQLite wrapper for link handling const sqlite3 = require('sqlite3').verbose(); const db = new sqlite3.Database('./links.db');

db.exec(CREATE TABLE IF NOT EXISTS links ( discord   TEXT PRIMARY KEY, roblox    INTEGER UNIQUE NOT NULL, code      TEXT, verified  INTEGER DEFAULT 0, created   INTEGER DEFAULT (strftime('%s','now')) ));

module.exports = { getVerified(discordId) { return new Promise(resolve => { db.get('SELECT * FROM links WHERE discord = ? AND verified = 1', [discordId], (err, row) => { resolve(row); }); }); },

removeLink(discordId) { return new Promise(resolve => { db.run('DELETE FROM links WHERE discord = ?', [discordId], () => resolve()); }); } };

