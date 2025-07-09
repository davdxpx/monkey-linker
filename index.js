// ╔═══════════════════════════════════════════════════════════════════╗
// ║  index.js – Monkey Linker Bot · FINAL LTS                        ║
// ║  Discord ⇆ Roblox account linking & event commands               ║
// ║                                                                 ║
// ║  ▸ Dual DB‑Backend (SQLite ⟷ Mongo multi‑cluster)                ║
// ║  ▸ Slash‑command autoloader & hot‑reload                         ║
// ║  ▸ Robust interaction / reaction verification flow               ║
// ║  ▸ Optional Roblox OpenCloud stats DM                            ║
// ║  ▸ Express keep‑alive (+ /healthz /stats) & self‑ping            ║
// ║                                                                 ║
// ║  StillBrokeStudios © 2025 · Author @davdxpx                      ║
// ╚═══════════════════════════════════════════════════════════════════╝

//-------------------------------------------------------------------
// 1 · ENV & CONFIG
//-------------------------------------------------------------------
require('dotenv').config();
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  OWNER_ID = '', // Added OWNER_ID
  VERIFIED_ROLE_ID,
  ADMIN_ROLES = '',

  // DB backend
  DB_PATH = './links.db',
  MONGO_DB_NAME,
  MONGO_URI_1,
  MONGO_URI_2,
  MONGO_URI_3,
  MONGO_URI_4,

  // Roblox OpenCloud
  UNIVERSE_ID,
  OC_KEY,

  // Hosting
  PORT = 8080,
  KEEPALIVE_URL,

  // Debug
  DEBUG_LINKER = '0',
  DEBUG_MONGO  = '0',
} = process.env;

const DBG  = DEBUG_LINKER === '1';
const log  = (...m) => DBG && console.log('[DBG]', ...m);
const warn = (...m) => console.warn('[WARN]', ...m);

//-------------------------------------------------------------------
// 2 · DEPENDENCIES
//-------------------------------------------------------------------
const fs      = require('node:fs');
const path    = require('node:path');
const axios   = require('axios');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const {
  Client,
  REST,
  Routes,
  Collection,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,    // Added
  ButtonBuilder,       // Added (already used but good to ensure it's explicitly here)
  StringSelectMenuBuilder, // Added
  ModalBuilder,          // Added (already used but good to ensure it's explicitly here)
  TextInputBuilder,      // Added (already used but good to ensure it's explicitly here)
  MessageFlags,          // Added
} = require('discord.js');
const { migrateEventsJsonToDb, EVENTS_JSON_PATH } = require('./utils/migrateEvents.js');

//-------------------------------------------------------------------
// 3 · CLIENT SETUP
//-------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});
client.commands  = new Collection();
client.cooldowns = new Collection();
client.pendingEventCreations = new Map(); // Map to temporarily store data between command and modal
// ─── globale Variable ───────────────────────
let linkStore;
const reactionCache = new Map();

//-------------------------------------------------------------------
// 4 · BACKEND IMPLEMENTATIONS
//-------------------------------------------------------------------
const DBSYNC_INT_SEC = 5 * 60;            // ⏰ SQLite-Cleanup alle 5 Minuten
const MONGO_TIMEOUT  = 8_000;             // ⏰ 8 s – danach Fallback auf SQLite

function wrapSql(db) {
  const get = (q, p = []) => new Promise((res, rej) =>
    db.get(q, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (q, p = []) => new Promise((res, rej) =>
    db.run(q, p, e => (e ? rej(e) : res())));
  return { get, run };
}

// ─────────────────────────── SQLite ──────────────────────────────
async function initSqlite(DB_PATH = './links.db') {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      DB_PATH,
      err => err ? reject(err) : console.log('🗄️  SQLite opened:', DB_PATH)
    );

    db.serialize(() => { // Serialize to ensure statements run in order
      db.exec(`CREATE TABLE IF NOT EXISTS links (
        discord      TEXT PRIMARY KEY,
        roblox       INTEGER UNIQUE NOT NULL,
        code         TEXT,
        attempts     INTEGER DEFAULT 0,
        lastAttempt  INTEGER DEFAULT 0,
        verified     INTEGER DEFAULT 0,
        created      INTEGER DEFAULT (strftime('%s','now'))
      );`);

      // New Event System Tables
      db.exec(`CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          creator_discord_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft', -- draft, published, archived, cancelled, active
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          start_at INTEGER NOT NULL,
          end_at INTEGER,
          island_name TEXT,
          area_name TEXT,
          image_main_url TEXT,
          image_thumbnail_url TEXT,
          capacity INTEGER DEFAULT 0,
          rsvp_count_going INTEGER DEFAULT 0,
          rsvp_count_interested INTEGER DEFAULT 0,
          announcement_message_id TEXT,
          announcement_channel_id TEXT,
          is_recurring INTEGER DEFAULT 0,
          recurrence_rule TEXT,
          template_name TEXT
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS event_rsvps (
          rsvp_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          user_discord_id TEXT NOT NULL,
          rsvp_status TEXT NOT NULL, -- 'going', 'interested', 'waitlisted', 'cancelled_rsvp'
          rsvp_at INTEGER NOT NULL,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS event_custom_fields (
          custom_field_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          field_name TEXT NOT NULL,
          field_value TEXT NOT NULL,
          display_order INTEGER DEFAULT 0,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS event_templates (
          template_id INTEGER PRIMARY KEY AUTOINCREMENT,
          template_name TEXT NOT NULL UNIQUE,
          creator_discord_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          event_data TEXT NOT NULL -- JSON string
      );`);

      // Indexes for events
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_rsvps_event_id ON event_rsvps(event_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_rsvps_user_id ON event_rsvps(user_discord_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_custom_fields_event_id ON event_custom_fields(event_id);`);

      // Bot Permissions Table
      db.exec(`CREATE TABLE IF NOT EXISTS bot_permissions (
          user_id TEXT PRIMARY KEY,
          is_moderator INTEGER DEFAULT 0,
          granted_by_user_id TEXT,
          granted_at INTEGER
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_permissions_user_id ON bot_permissions(user_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_permissions_is_moderator ON bot_permissions(is_moderator);`);

      // Event Rewards Table (Now links to Global Reward Types)
      db.exec(`DROP TABLE IF EXISTS event_rewards;`); // Drop old table if it exists to apply new schema
      db.exec(`CREATE TABLE IF NOT EXISTS event_rewards (
          event_reward_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          global_reward_type_id TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          display_order INTEGER DEFAULT 0,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
          FOREIGN KEY (global_reward_type_id) REFERENCES global_reward_types(reward_type_id) ON DELETE CASCADE -- Or SET NULL / RESTRICT
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_rewards_event_id ON event_rewards(event_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_rewards_global_reward_type_id ON event_rewards(global_reward_type_id);`);

      // Global Reward Types Table
      db.exec(`CREATE TABLE IF NOT EXISTS global_reward_types (
          reward_type_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          creator_discord_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          icon_url TEXT
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_global_reward_types_name ON global_reward_types(name);`);

      // Drop old RSVP role config table
      db.exec(`DROP TABLE IF EXISTS rsvp_role_config;`);

      // New Bot Role Configurations Table
      db.exec(`CREATE TABLE IF NOT EXISTS bot_role_configs (
          config_id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          config_type TEXT NOT NULL, -- e.g., 'VERIFIED_ROLE', 'EVENT_RSVP_ROLE'
          role_id TEXT NOT NULL,
          set_by_user_id TEXT NOT NULL,
          set_at INTEGER NOT NULL,
          UNIQUE(guild_id, config_type)
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_role_configs_guild_type ON bot_role_configs(guild_id, config_type);`);

    });

    const sql = wrapSql(db);

    // Define the linkStore API methods
    const linkStoreApi = {
      // Link methods
      get:            d => sql.get('SELECT * FROM links WHERE discord=?', [d]),
      getByRb:        r => sql.get('SELECT * FROM links WHERE roblox=?',  [r]),
      upsert: ({ discord, roblox, code, attempts = 0, lastAttempt = 0, verified = 0 }) =>
        sql.run(
          `INSERT OR REPLACE INTO links
           (discord, roblox, code, attempts, lastAttempt, verified, created)
           VALUES (?,?,?,?,?,?,strftime('%s','now'))`,
          [discord, roblox, code, attempts, lastAttempt, verified]
        ),
      remove:    d => sql.run('DELETE FROM links WHERE discord=?', [d]),
      setAttempts:   (d, a, ts) => ts
        ? sql.run('UPDATE links SET attempts=?, lastAttempt=? WHERE discord=?', [a, ts, d])
        : sql.run('UPDATE links SET attempts=? WHERE discord=?', [a, d]),
      verify:        d      => sql.run('UPDATE links SET verified=1 WHERE discord=?', [d]),
      cleanupExpired:s      => sql.run(
        'DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > ?',
        [s]
      ),

      // Event methods (SQLite implementations)
      createEvent: (eventData) => {
        const { generateEventId } = require('./utils/idGenerator');
        const eventId = generateEventId();
        const { title, description, creator_discord_id, status = 'draft', created_at, updated_at, start_at, end_at, island_name, area_name, image_main_url, image_thumbnail_url, capacity = 0 } = eventData;
        return sql.run(
          `INSERT INTO events (event_id, title, description, creator_discord_id, status, created_at, updated_at, start_at, end_at, island_name, area_name, image_main_url, image_thumbnail_url, capacity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [eventId, title, description, creator_discord_id, status, created_at, updated_at, start_at, end_at, island_name, area_name, image_main_url, image_thumbnail_url, capacity]
        ).then(() => eventId); // Return the generated eventId
      },
      getEventById: (eventId) => sql.get('SELECT * FROM events WHERE event_id = ?', [eventId]),
      getPublishedEvents: (limit = 25) => sql.all('SELECT * FROM events WHERE status = ? ORDER BY start_at ASC LIMIT ?', ['published', limit]),
      getDraftEvents: (limit = 25) => sql.all('SELECT event_id, title, start_at FROM events WHERE status = ? ORDER BY created_at DESC LIMIT ?', ['draft', limit]), // New method
      updateEventStatus: (eventId, status, updated_at) => sql.run('UPDATE events SET status = ?, updated_at = ? WHERE event_id = ?', [status, updated_at, eventId]),
      deleteEvent: async function(eventId) { // Use function keyword for 'this' context
        await this.deleteEventCustomFieldsByEventId(eventId);
        await this.deleteEventRsvpsByEventId(eventId);
        await this.deleteEventRewardsByEventId(eventId); // Now include this
        return sql.run('DELETE FROM events WHERE event_id = ?', [eventId]);
      },
      updateEvent: (eventId, eventData) => {
        // Construct SET clause dynamically for flexibility, ensure updated_at is always set
        const fields = Object.keys(eventData).filter(k => k !== 'event_id'); // Don't update event_id
        if (fields.length === 0) return Promise.resolve();
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const values = fields.map(field => eventData[field]);
        values.push(Math.floor(Date.now() / 1000)); // updated_at
        values.push(eventId);
        return sql.run(`UPDATE events SET ${setClause}, updated_at = ? WHERE event_id = ?`, values);
      },
      // Placeholder for RSVP methods - to be implemented in Phase 2
      // addRsvp: (eventId, userId, rsvpStatus) => { /* ... */ },
      // getRsvpsForEvent: (eventId) => { /* ... */ },

      // RSVP Management Methods (SQLite)
      addRsvp: async (eventId, userId, rsvpStatus) => {
        const now = Math.floor(Date.now() / 1000);
        // Upsert logic: Insert or replace RSVP
        await sql.run(
          `INSERT INTO event_rsvps (event_id, user_discord_id, rsvp_status, rsvp_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id, user_discord_id) DO UPDATE SET rsvp_status = excluded.rsvp_status, rsvp_at = excluded.rsvp_at`,
          [eventId, userId, rsvpStatus, now]
        );
        // Update counts on events table
        const counts = await sql.get(
          `SELECT
             SUM(CASE WHEN rsvp_status = 'going' THEN 1 ELSE 0 END) as going,
             SUM(CASE WHEN rsvp_status = 'interested' THEN 1 ELSE 0 END) as interested
           FROM event_rsvps WHERE event_id = ?`,
          [eventId]
        );
        await sql.run('UPDATE events SET rsvp_count_going = ?, rsvp_count_interested = ?, updated_at = ? WHERE event_id = ?',
          [counts.going || 0, counts.interested || 0, now, eventId]);
        return true;
      },
      getRsvp: (eventId, userId) => sql.get('SELECT * FROM event_rsvps WHERE event_id = ? AND user_discord_id = ?', [eventId, userId]),
      getRsvpsForEvent: (eventId, status = null) => {
        if (status) {
          return sql.all('SELECT * FROM event_rsvps WHERE event_id = ? AND rsvp_status = ? ORDER BY rsvp_at ASC', [eventId, status]);
        }
        return sql.all('SELECT * FROM event_rsvps WHERE event_id = ? ORDER BY rsvp_at ASC', [eventId]);
      },
      deleteEventRsvpsByEventId: (eventId) => { // Added for cascading delete
        return sql.run('DELETE FROM event_rsvps WHERE event_id = ?', [eventId]);
      },

      // Custom Field Methods (SQLite)
      addEventCustomField: (eventId, fieldName, fieldValue, displayOrder = 0) => { // Renamed for clarity
        return sql.run(
          `INSERT INTO event_custom_fields (event_id, field_name, field_value, display_order) VALUES (?, ?, ?, ?)`,
          [eventId, fieldName, fieldValue, displayOrder]
        ).then(function() { return this.lastID; });
      },
      getEventCustomFields: (eventId) => { // Renamed for clarity
        return sql.all('SELECT * FROM event_custom_fields WHERE event_id = ? ORDER BY display_order ASC, custom_field_id ASC', [eventId]);
      },
      updateEventCustomField: (customFieldId, fieldName, fieldValue, displayOrder) => { // Renamed for clarity
        const updates = [];
        const values = [];
        if (fieldName !== undefined) { updates.push('field_name = ?'); values.push(fieldName); }
        if (fieldValue !== undefined) { updates.push('field_value = ?'); values.push(fieldValue); }
        if (displayOrder !== undefined) { updates.push('display_order = ?'); values.push(displayOrder); }
        if (updates.length === 0) return Promise.resolve();
        values.push(customFieldId);
        return sql.run(`UPDATE event_custom_fields SET ${updates.join(', ')} WHERE custom_field_id = ?`, values);
      },
      deleteEventCustomField: (customFieldId) => { // Renamed for clarity
        return sql.run('DELETE FROM event_custom_fields WHERE custom_field_id = ?', [customFieldId]);
      },
      deleteEventCustomFieldsByEventId: (eventId) => { // Renamed for clarity
        return sql.run('DELETE FROM event_custom_fields WHERE event_id = ?', [eventId]);
      },

      // Event Reward Methods (SQLite) - Reworked for linked global rewards
      linkEventReward: (eventId, globalRewardTypeId, quantity, displayOrder = 0) => {
        return sql.run(
          `INSERT INTO event_rewards (event_id, global_reward_type_id, quantity, display_order) VALUES (?, ?, ?, ?)`,
          [eventId, globalRewardTypeId, quantity, displayOrder]
        ).then(function() { return this.lastID; }); // Returns event_reward_id
      },
      getEventRewards: (eventId) => {
        // Join with global_reward_types to get details
        return sql.all(
          `SELECT
             er.event_reward_id, er.event_id, er.global_reward_type_id, er.quantity, er.display_order,
             grt.name, grt.description, grt.icon_url, grt.creator_discord_id AS global_reward_creator_id, grt.created_at AS global_reward_created_at
           FROM event_rewards er
           JOIN global_reward_types grt ON er.global_reward_type_id = grt.reward_type_id
           WHERE er.event_id = ?
           ORDER BY er.display_order ASC, er.event_reward_id ASC`,
          [eventId]
        );
      },
      updateEventRewardQuantity: (eventRewardId, quantity) => {
        if (quantity === undefined || quantity < 1) return Promise.reject(new Error("Quantity must be a positive integer."));
        return sql.run(
          `UPDATE event_rewards SET quantity = ? WHERE event_reward_id = ?`,
          [quantity, eventRewardId]
        );
      },
      deleteEventReward: (eventRewardId) => { // Now takes event_reward_id (PK of the link table)
        return sql.run('DELETE FROM event_rewards WHERE event_reward_id = ?', [eventRewardId]);
      },
      getSpecificEventReward: (eventRewardId) => { // New method to get a single linked reward with its details
        return sql.get(
          `SELECT
             er.event_reward_id, er.event_id, er.global_reward_type_id, er.quantity, er.display_order,
             grt.name, grt.description, grt.icon_url
           FROM event_rewards er
           JOIN global_reward_types grt ON er.global_reward_type_id = grt.reward_type_id
           WHERE er.event_reward_id = ?`,
          [eventRewardId]
        );
      },
      deleteEventRewardsByEventId: (eventId) => { // This remains useful for cleaning up all linked rewards for an event
        return sql.run('DELETE FROM event_rewards WHERE event_id = ?', [eventId]);
      },

      // Event Template Methods (SQLite)
      createEventTemplate: (templateName, creatorId, eventDataJson) => {
        const createdAt = Math.floor(Date.now() / 1000);
        return sql.run(
          `INSERT INTO event_templates (template_name, creator_discord_id, created_at, event_data) VALUES (?, ?, ?, ?)`,
          [templateName, creatorId, createdAt, eventDataJson]
        ).then(function() { return this.lastID; });
      },
      getEventTemplateByName: (templateName) => {
        return sql.get('SELECT * FROM event_templates WHERE template_name = ?', [templateName]);
      },
      getEventTemplateById: (templateId) => { // Added for completeness
        return sql.get('SELECT * FROM event_templates WHERE template_id = ?', [templateId]);
      },
      getAllEventTemplates: () => {
        return sql.all('SELECT template_id, template_name, creator_discord_id, created_at FROM event_templates ORDER BY template_name ASC'); // Don't fetch full event_data for list
      },
      deleteEventTemplateByName: (templateName) => {
        return sql.run('DELETE FROM event_templates WHERE template_name = ?', [templateName]);
      },

      // Bot Permissions Methods (SQLite)
      grantModeratorRole: (userId, adminUserId) => {
        const now = Math.floor(Date.now() / 1000);
        return sql.run(
          `INSERT INTO bot_permissions (user_id, is_moderator, granted_by_user_id, granted_at) VALUES (?, 1, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET is_moderator = 1, granted_by_user_id = excluded.granted_by_user_id, granted_at = excluded.granted_at`,
          [userId, adminUserId, now]
        );
      },
      revokeModeratorRole: (userId) => {
        return sql.run(
          `UPDATE bot_permissions SET is_moderator = 0 WHERE user_id = ?`,
          [userId]
        );
        // Alternative: Delete the record
        // return sql.run('DELETE FROM bot_permissions WHERE user_id = ?', [userId]);
      },
      isBotModerator: async (userId) => {
        const row = await sql.get('SELECT is_moderator FROM bot_permissions WHERE user_id = ?', [userId]);
        return row ? row.is_moderator === 1 : false;
      },
      listModerators: () => {
        return sql.all('SELECT user_id, granted_by_user_id, granted_at FROM bot_permissions WHERE is_moderator = 1 ORDER BY granted_at DESC');
      },

      // Global Reward Type Methods (SQLite)
      createGlobalRewardType: (rewardTypeId, name, description, creatorId, iconUrl = null) => {
        const now = Math.floor(Date.now() / 1000);
        return sql.run(
          `INSERT INTO global_reward_types (reward_type_id, name, description, creator_discord_id, created_at, updated_at, icon_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [rewardTypeId, name, description, creatorId, now, now, iconUrl]
        );
      },
      getGlobalRewardTypeById: (id) => {
        return sql.get('SELECT * FROM global_reward_types WHERE reward_type_id = ?', [id]);
      },
      getGlobalRewardTypeByName: (name) => {
        return sql.get('SELECT * FROM global_reward_types WHERE name = ?', [name]);
      },
      getAllGlobalRewardTypes: () => {
        return sql.all('SELECT * FROM global_reward_types ORDER BY name ASC');
      },
      updateGlobalRewardType: (id, name, description, iconUrl) => {
        const now = Math.floor(Date.now() / 1000);
        // Ensure that only provided fields are updated.
        const updates = [];
        const values = [];
        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (iconUrl !== undefined) { updates.push('icon_url = ?'); values.push(iconUrl); } // iconUrl can be null to clear it

        if (updates.length === 0) return Promise.resolve(); // No actual fields to update besides timestamp

        updates.push('updated_at = ?');
        values.push(now);
        values.push(id);

        return sql.run(`UPDATE global_reward_types SET ${updates.join(', ')} WHERE reward_type_id = ?`, values);
      },
      deleteGlobalRewardType: (id) => {
        return sql.run('DELETE FROM global_reward_types WHERE reward_type_id = ?', [id]);
      },

      // New Bot Role Config Methods (SQLite)
      setRoleConfig: (guildId, configType, roleId, adminUserId) => {
        const now = Math.floor(Date.now() / 1000);
        return sql.run(
          `INSERT OR REPLACE INTO bot_role_configs (guild_id, config_type, role_id, set_by_user_id, set_at)
           VALUES (?, ?, ?, ?, ?)`,
          [guildId, configType, roleId, adminUserId, now]
        );
      },
      getRoleConfig: (guildId, configType) => {
        return sql.get('SELECT role_id, set_by_user_id, set_at FROM bot_role_configs WHERE guild_id = ? AND config_type = ?', [guildId, configType]);
      },
      getAllRoleConfigs: (guildId) => {
        return sql.all('SELECT config_type, role_id, set_by_user_id, set_at FROM bot_role_configs WHERE guild_id = ?', [guildId]);
      },
      clearRoleConfig: (guildId, configType) => {
        return sql.run('DELETE FROM bot_role_configs WHERE guild_id = ? AND config_type = ?', [guildId, configType]);
      },
    };

    // ⏰ Periodische Bereinigung: nicht verifizierte Links nach 15 min löschen
    setInterval(() => linkStoreApi.cleanupExpired(900).catch(() => {}),
                DBSYNC_INT_SEC * 1_000);

    // Pass the raw db object for migration before resolving with the API
    resolve({ db, api: linkStoreApi, dbType: 'sqlite' });
  });
}

// ─────────────────────────── MongoDB ─────────────────────────────
async function initMongoBackend(cfg) {
  const { MongoClient } = require('mongodb');
  const uri = [cfg.MONGO_URI_1, cfg.MONGO_URI_2, cfg.MONGO_URI_3, cfg.MONGO_URI_4]
    .filter(Boolean)[0];

  const client = new MongoClient(uri, {
    connectTimeoutMS: MONGO_TIMEOUT, socketTimeoutMS: MONGO_TIMEOUT,
    serverSelectionTimeoutMS: MONGO_TIMEOUT,
  });

  await client.connect();
  console.log('🍃  Mongo connected');

  const db = client.db(cfg.MONGO_DB_NAME);
  const linksCol = db.collection('links');

  // Ensure indexes for new event collections in MongoDB
  const eventsCol = db.collection('events');
  await eventsCol.createIndex({ status: 1 });
  await eventsCol.createIndex({ start_at: 1 });

  const eventRsvpsCol = db.collection('event_rsvps');
  await eventRsvpsCol.createIndex({ event_id: 1 });
  await eventRsvpsCol.createIndex({ user_discord_id: 1 });

  const eventCustomFieldsCol = db.collection('event_custom_fields');
  await eventCustomFieldsCol.createIndex({ event_id: 1 });

  const eventTemplatesCol = db.collection('event_templates');
  await eventTemplatesCol.createIndex({ template_name: 1 }, { unique: true });

  const eventRewardsCol = db.collection('event_rewards'); // This will store links and quantities
  await eventRewardsCol.createIndex({ event_id: 1 });
  await eventRewardsCol.createIndex({ global_reward_type_id: 1 });

  const botPermissionsCol = db.collection('bot_permissions');
  await botPermissionsCol.createIndex({ user_id: 1 }, { unique: true });
  await botPermissionsCol.createIndex({ is_moderator: 1 });

  const globalRewardTypesCol = db.collection('global_reward_types');
  await globalRewardTypesCol.createIndex({ name: 1 }, { unique: true });
  await globalRewardTypesCol.createIndex({ reward_type_id: 1 }, { unique: true });

  // Remove old rsvpRoleConfigCol if it was ever created (optional, as it might not exist)
  // await db.collection('rsvp_role_config').drop().catch(e => { if (e.code !== 26) console.warn("Tried to drop rsvp_role_config, but it didn't exist or another error:", e.message); });

  const botRoleConfigsCol = db.collection('bot_role_configs');
  await botRoleConfigsCol.createIndex({ guild_id: 1, config_type: 1 }, { unique: true });


  // Note: The linkStore API will need to be expanded to handle these new collections/tables.
  const mongoApi = {
    // Link methods
    get:       d => linksCol.findOne({ discord: d }),
    getByRb:   r => linksCol.findOne({ roblox: r }),
    upsert:    row => linksCol.updateOne({ discord: row.discord }, { $set: row }, { upsert: true }),
    remove:    d => linksCol.deleteOne({ discord: d }),
    setAttempts:(d, a, ts) => {
      const upd = { attempts: a };
      if (ts) upd.lastAttempt = ts;
      return linksCol.updateOne({ discord: d }, { $set: upd });
    },
    verify:    d => linksCol.updateOne({ discord: d }, { $set: { verified: 1 } }),
    cleanupExpired: s =>
      linksCol.deleteMany({ verified: 0, created: { $lt: Math.floor(Date.now() / 1000) - s } }),

    // Event methods (MongoDB implementations)
    createEvent: async (eventData) => {
      const { generateEventId } = require('./utils/idGenerator');
      const eventId = generateEventId();
      const fullEventData = { ...eventData, _id: eventId, event_id: eventId }; // Use generated ID as _id and event_id
      await eventsCol.insertOne(fullEventData);
      return eventId; // Return the generated eventId
    },
    getEventById: (eventId) => eventsCol.findOne({ _id: eventId }), // Now eventId is our string ID
    getPublishedEvents: (limit = 25) => eventsCol.find({ status: 'published' }).sort({ start_at: 1 }).limit(limit).toArray(),
    getDraftEvents: (limit = 25) => eventsCol.find({ status: 'draft' }, { projection: { event_id: 1, title: 1, start_at: 1, _id: 0 } }).sort({ created_at: -1 }).limit(limit).toArray(), // New method
    updateEventStatus: (eventId, status, updated_at) => eventsCol.updateOne({ _id: eventId }, { $set: { status, updated_at } }),
    deleteEvent: async function(eventId) { // Use function keyword for 'this' context
        await this.deleteEventCustomFieldsByEventId(eventId); // Assumes these use event_id matching _id
        await this.deleteEventRsvpsByEventId(eventId);
        // Future: await this.deleteEventRewardsByEventId(eventId);
        return eventsCol.deleteOne({ _id: eventId });
    },
    updateEvent: (eventId, eventData) => {
        const updatePayload = { ...eventData };
        // _id should not be in eventData if we are identifying by it in query
        delete updatePayload._id;
        delete updatePayload.event_id; // also remove event_id if present, as it's same as _id
        updatePayload.updated_at = Math.floor(Date.now() / 1000);
        return eventsCol.updateOne({ _id: eventId }, { $set: updatePayload });
    },
    // Placeholder for RSVP methods
    // addRsvp: (eventId, userId, rsvpStatus) => { /* ... */ },
    // getRsvpsForEvent: (eventId) => { /* ... */ },

    // RSVP Management Methods (MongoDB)
    addRsvp: async (eventId, userId, rsvpStatus) => {
        const now = Math.floor(Date.now() / 1000);
        await eventRsvpsCol.updateOne(
            { event_id: eventId, user_discord_id: userId },
            { $set: { rsvp_status: rsvpStatus, rsvp_at: now } },
            { upsert: true }
        );
        // Update counts on events table
        const goingCount = await eventRsvpsCol.countDocuments({ event_id: eventId, rsvp_status: 'going' });
        const interestedCount = await eventRsvpsCol.countDocuments({ event_id: eventId, rsvp_status: 'interested' });
        await eventsCol.updateOne({ _id: eventId }, { $set: { rsvp_count_going: goingCount, rsvp_count_interested: interestedCount, updated_at: now } });
        return true;
    },
    getRsvp: (eventId, userId) => eventRsvpsCol.findOne({ event_id: eventId, user_discord_id: userId }),
    getRsvpsForEvent: (eventId, status = null) => {
        const query = { event_id: eventId };
        if (status) {
            query.rsvp_status = status;
        }
        return eventRsvpsCol.find(query).sort({ rsvp_at: 1 }).toArray();
    },
    deleteEventRsvpsByEventId: (eventId) => { // Added for cascading delete
        return eventRsvpsCol.deleteMany({ event_id: eventId });
    },

    // Custom Field Methods (MongoDB)
    addEventCustomField: async (eventId, fieldName, fieldValue, displayOrder = 0) => { // Renamed
        const result = await eventCustomFieldsCol.insertOne({ event_id: eventId, field_name: fieldName, field_value: fieldValue, display_order: displayOrder });
        return result.insertedId;
    },
    getEventCustomFields: (eventId) => { // Renamed
        return eventCustomFieldsCol.find({ event_id: eventId }).sort({ display_order: 1, _id: 1 }).toArray();
    },
    updateEventCustomField: (customFieldId, fieldName, fieldValue, displayOrder) => { // Renamed
        const updates = {};
        if (fieldName !== undefined) updates.field_name = fieldName;
        if (fieldValue !== undefined) updates.field_value = fieldValue;
        if (displayOrder !== undefined) updates.display_order = displayOrder;
        if (Object.keys(updates).length === 0) return Promise.resolve();
        // Assuming customFieldId is ObjectId for Mongo
        const { ObjectId } = require('mongodb'); // Ensure ObjectId is available
        return eventCustomFieldsCol.updateOne({ _id: new ObjectId(customFieldId) }, { $set: updates });
    },
    deleteEventCustomField: (customFieldId) => { // Renamed
        const { ObjectId } = require('mongodb');
        return eventCustomFieldsCol.deleteOne({ _id: new ObjectId(customFieldId) });
    },
    deleteEventCustomFieldsByEventId: (eventId) => { // Renamed
        return eventCustomFieldsCol.deleteMany({ event_id: eventId });
    },

    // Event Reward Methods (MongoDB) - Reworked
    linkEventReward: async (eventId, globalRewardTypeId, quantity, displayOrder = 0) => {
      const result = await eventRewardsCol.insertOne({
        event_id: eventId,
        global_reward_type_id: globalRewardTypeId,
        quantity: quantity,
        display_order: displayOrder,
        linked_at: Math.floor(Date.now() / 1000)
      });
      return result.insertedId; // This is the _id of the event_rewards document (the link itself)
    },
    getEventRewards: async (eventId) => {
      // Need to perform a lookup (equivalent to JOIN)
      const rewards = await eventRewardsCol.aggregate([
        { $match: { event_id: eventId } },
        {
          $lookup: {
            from: 'global_reward_types', // The collection name for global_reward_types
            localField: 'global_reward_type_id',
            foreignField: '_id', // Assuming global_reward_type_id in event_rewards links to _id in global_reward_types
            as: 'globalRewardDetails'
          }
        },
        // Handle cases where a global reward might have been deleted after linking
        {
          $unwind: {
            path: "$globalRewardDetails",
            preserveNullAndEmptyArrays: true // Keep event_rewards link even if global_reward_type is missing
          }
        },
        {
          $project: { // Shape the output
            _id: 1,
            event_reward_id: '$_id',
            event_id: 1,
            global_reward_type_id: 1,
            quantity: 1,
            display_order: 1,
            // Use $ifNull to provide default values if globalRewardDetails is missing (due to deletion)
            name: { $ifNull: ['$globalRewardDetails.name', 'Deleted Reward Type'] },
            description: { $ifNull: ['$globalRewardDetails.description', 'Details unavailable'] },
            icon_url: { $ifNull: ['$globalRewardDetails.icon_url', null] },
          }
        },
        { $sort: { display_order: 1, _id: 1 } }
      ]).toArray();
      return rewards;
    },
    updateEventRewardQuantity: (eventRewardId, quantity) => {
      if (quantity === undefined || quantity < 1) return Promise.reject(new Error("Quantity must be a positive integer."));
      const { ObjectId } = require('mongodb');
      return eventRewardsCol.updateOne(
        { _id: new ObjectId(eventRewardId) },
        { $set: { quantity: quantity } }
      );
    },
    deleteEventReward: (eventRewardId) => { // eventRewardId is the _id of the link document
      const { ObjectId } = require('mongodb');
      return eventRewardsCol.deleteOne({ _id: new ObjectId(eventRewardId) });
    },
    getSpecificEventReward: async (eventRewardId) => { // New method for MongoDB
      const { ObjectId } = require('mongodb');
      const rewards = await eventRewardsCol.aggregate([
        { $match: { _id: new ObjectId(eventRewardId) } },
        {
          $lookup: {
            from: 'global_reward_types',
            localField: 'global_reward_type_id',
            foreignField: '_id',
            as: 'globalRewardDetails'
          }
        },
        { $unwind: { path: "$globalRewardDetails", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1, event_reward_id: '$_id', event_id: 1, global_reward_type_id: 1, quantity: 1, display_order: 1,
            name: { $ifNull: ['$globalRewardDetails.name', 'Deleted Reward Type'] },
            description: { $ifNull: ['$globalRewardDetails.description', 'Details unavailable'] },
            icon_url: { $ifNull: ['$globalRewardDetails.icon_url', null] },
          }
        }
      ]).toArray();
      return rewards.length > 0 ? rewards[0] : null;
    },
    deleteEventRewardsByEventId: (eventId) => { // This remains useful
      return eventRewardsCol.deleteMany({ event_id: eventId });
    },

    // Event Template Methods (MongoDB)
    createEventTemplate: async (templateName, creatorId, eventDataJson) => {
        const createdAt = Math.floor(Date.now() / 1000);
        // Parse JSON string to object for MongoDB storage, or store as string if preferred
        let event_data_obj = eventDataJson;
        try {
            event_data_obj = JSON.parse(eventDataJson);
        } catch (e) { /* keep as string if not valid JSON, or handle error */ }

        const result = await eventTemplatesCol.insertOne({
            template_name: templateName,
            creator_discord_id: creatorId,
            created_at: createdAt,
            event_data: event_data_obj
        });
        return result.insertedId;
    },
    getEventTemplateByName: async (templateName) => {
        const template = await eventTemplatesCol.findOne({ template_name: templateName });
        if (template && typeof template.event_data !== 'string') { // Ensure event_data is stringified if it was stored as object
            template.event_data = JSON.stringify(template.event_data);
        }
        return template;
    },
    getEventTemplateById: async (templateId) => { // Added for completeness
        const { ObjectId } = require('mongodb');
        const template = await eventTemplatesCol.findOne({ _id: new ObjectId(templateId) });
         if (template && typeof template.event_data !== 'string') {
            template.event_data = JSON.stringify(template.event_data);
        }
        return template;
    },
    getAllEventTemplates: () => {
        return eventTemplatesCol.find({}, { projection: { event_data: 0 } }).sort({ template_name: 1 }).toArray(); // Exclude event_data from list
    },
    deleteEventTemplateByName: (templateName) => {
        return eventTemplatesCol.deleteOne({ template_name: templateName });
    },

    // Bot Permissions Methods (MongoDB)
    grantModeratorRole: (userId, adminUserId) => {
      const now = Math.floor(Date.now() / 1000);
      return botPermissionsCol.updateOne(
        { user_id: userId },
        { $set: { is_moderator: true, granted_by_user_id: adminUserId, granted_at: now } },
        { upsert: true }
      );
    },
    revokeModeratorRole: (userId) => {
      return botPermissionsCol.updateOne(
        { user_id: userId },
        { $set: { is_moderator: false } }
        // We could also add $unset: { granted_by_user_id: "", granted_at: "" } if desired
      );
    },
    isBotModerator: async (userId) => {
      const userPerm = await botPermissionsCol.findOne({ user_id: userId });
      return userPerm ? userPerm.is_moderator === true : false;
    },
    listModerators: () => {
      return botPermissionsCol.find({ is_moderator: true }).sort({ granted_at: -1 }).toArray(); // -1 for descending
    },

    // Global Reward Type Methods (MongoDB)
    createGlobalRewardType: async (rewardTypeId, name, description, creatorId, iconUrl = null) => {
      const now = Math.floor(Date.now() / 1000);
      await globalRewardTypesCol.insertOne({
        _id: rewardTypeId, // Use rewardTypeId as MongoDB _id
        reward_type_id: rewardTypeId,
        name,
        description,
        icon_url: iconUrl,
        creator_discord_id: creatorId,
        created_at: now,
        updated_at: now,
      });
      return rewardTypeId;
    },
    getGlobalRewardTypeById: (id) => {
      return globalRewardTypesCol.findOne({ _id: id });
    },
    getGlobalRewardTypeByName: (name) => {
      return globalRewardTypesCol.findOne({ name: name });
    },
    getAllGlobalRewardTypes: () => {
      return globalRewardTypesCol.find({}).sort({ name: 1 }).toArray();
    },
    updateGlobalRewardType: (id, name, description, iconUrl) => {
      const now = Math.floor(Date.now() / 1000);
      const updates = { updated_at: now };
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (iconUrl !== undefined) updates.icon_url = iconUrl; // Handles null to clear, or new URL

      // Check if only updated_at is present (meaning no actual data fields changed)
      const fieldUpdateKeys = Object.keys(updates).filter(key => key !== 'updated_at');
      if (fieldUpdateKeys.length === 0) return Promise.resolve();

      return globalRewardTypesCol.updateOne({ _id: id }, { $set: updates });
    },
    deleteGlobalRewardType: (id) => {
      return globalRewardTypesCol.deleteOne({ _id: id });
    },

    // New Bot Role Config Methods (MongoDB)
    setRoleConfig: (guildId, configType, roleId, adminUserId) => {
      const now = Math.floor(Date.now() / 1000);
      return botRoleConfigsCol.updateOne(
        { guild_id: guildId, config_type: configType },
        { $set: { role_id: roleId, set_by_user_id: adminUserId, set_at: now } },
        { upsert: true }
      );
    },
    getRoleConfig: async (guildId, configType) => {
      const config = await botRoleConfigsCol.findOne({ guild_id: guildId, config_type: configType });
      if (config) {
        return { role_id: config.role_id, set_by_user_id: config.set_by_user_id, set_at: config.set_at };
      }
      return null;
    },
    getAllRoleConfigs: (guildId) => {
      return botRoleConfigsCol.find({ guild_id: guildId }).toArray();
    },
    clearRoleConfig: (guildId, configType) => {
      return botRoleConfigsCol.deleteOne({ guild_id: guildId, config_type: configType });
    },
  };
  return { db, api: mongoApi, dbType: 'mongo' };
}

// ───────────────────────── Backend-Chooser ───────────────────────
async function selectBackend() {
  const  {
    MONGO_DB_NAME, MONGO_URI_1, MONGO_URI_2, MONGO_URI_3, MONGO_URI_4,
    DEBUG_MONGO
  } = process.env;

  if (MONGO_URI_1 && MONGO_DB_NAME) {
    try {
      console.log('🔍  Trying Mongo backend …');
      return await initMongoBackend({
        MONGO_DB_NAME, MONGO_URI_1, MONGO_URI_2, MONGO_URI_3, MONGO_URI_4,
        debug: DEBUG_MONGO === '1'
      });
    } catch (e) {
      console.error('❌  Mongo init failed – falling back to SQLite:', e.message);
    }
  }

  console.log('🗄️  Falling back to SQLite');
  return await initSqlite(process.env.DB_PATH || './links.db');
}

//-------------------------------------------------------------------
// 5 · COMMAND LOADING + REGISTRATION
//-------------------------------------------------------------------
function loadCommands() {
  const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
  const commandList = [];
  console.log('[COMMAND_LOADER] Loading commands...');
  for (const file of commandFiles) {
    const filePath = path.join(__dirname, 'commands', file);
    try {
      // Clear cache for hot reloading if needed (though full restart is safer for big changes)
      delete require.cache[require.resolve(filePath)];
      const command = require(filePath);
      if (command.data && typeof command.execute === 'function') {
        client.commands.set(command.data.name, command);
        commandList.push(command.data.toJSON());
        console.log(`[COMMAND_LOADER] ✅ Loaded command: ${command.data.name}`);
      } else {
        warn(`[COMMAND_LOADER] ⚠️ Command file ${file} is missing 'data' or 'execute'.`);
      }
    } catch (error) {
      console.error(`[COMMAND_LOADER] ❌ Error loading command ${file}:`, error);
    }
  }
  console.log(`[COMMAND_LOADER] ${commandList.length} commands prepared for registration.`);
  return commandList;
}

async function registerCommands(list) {
  const rest  = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: list });
  console.log(`✅ Registered ${list.length} slash commands ${GUILD_ID ? 'in guild' : 'globally'}`);
}

//-------------------------------------------------------------------
// 6 · INTERACTION HANDLER
//-------------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  // Handle Modal Submissions & Button Interactions
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'eventCreateModal') {
      try {
      // Defer reply immediately for modal submission
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const title = interaction.fields.getTextInputValue('eventTitle');
      const description = interaction.fields.getTextInputValue('eventDescription');
      const dateStr = interaction.fields.getTextInputValue('eventDate');
      const timeStr = interaction.fields.getTextInputValue('eventTime');
      let imageMainUrl = interaction.fields.getTextInputValue('eventImageMainUrl') || null; // From modal

      // Check if there was a pre-uploaded image or template data from the command
      const pendingData = client.pendingEventCreations.get(interaction.user.id);
      if (pendingData && pendingData.attachmentUrl) {
        imageMainUrl = pendingData.attachmentUrl; // Prioritize uploaded image
      }

      let island_name = null;
      let area_name = null;
      let capacity = 0;

      if (pendingData && pendingData.templateIsland) island_name = pendingData.templateIsland;
      if (pendingData && pendingData.templateArea) area_name = pendingData.templateArea;
      if (pendingData && pendingData.templateCapacity) capacity = parseInt(pendingData.templateCapacity, 10) || 0;

      // TODO: Add island/area selection UI logic. For now, using template or null.
      // This would typically involve another interaction step (select menu) after modal.

      // Validate date and time (basic)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
        return interaction.followUp({ content: 'Invalid date or time format. Please use YYYY-MM-DD and HH:MM (UTC).', ephemeral: true });
      }
      const start_at = Math.floor(new Date(`${dateStr}T${timeStr}:00.000Z`).getTime() / 1000); // Assume UTC
      const now = Math.floor(Date.now() / 1000);

      const eventData = {
        title,
        description,
        creator_discord_id: interaction.user.id,
        status: 'draft',
        created_at: now,
        updated_at: now,
        start_at,
        island_name,
        area_name,
        image_main_url: imageMainUrl,
        capacity: capacity,
      };

      const eventId = await linkStore.createEvent(eventData);
      const successEmbed = new EmbedBuilder()
        .setColor(0x4CAF50) // SUCCESS_COLOR
        .setTitle('🎉 Event Draft Created!')
        .setDescription(`Your event draft "**${title}**" has been created with ID #${eventId}.`)
        .setTimestamp();

      const components = [];
      const { ISLAND_DATA } = require('./utils/gameData.js'); // Ensure ISLAND_DATA is available

      // Determine next step: Location selection or just custom fields/rewards
      if (!island_name) { // Island not set by template, ask user
        successEmbed.addFields({ name: 'Next Step: Location', value: 'Please select the island for your event below.'});
        const islandOptions = Object.keys(ISLAND_DATA).map(key => ({
            label: `${ISLAND_DATA[key].emoji} ${key}`,
            value: key,
        }));
        const islandSelectMenu = new StringSelectMenuBuilder()
            .setCustomId(`select-island-${eventId}`)
            .setPlaceholder('Select an island...')
            .addOptions(islandOptions);
        components.push(new ActionRowBuilder().addComponents(islandSelectMenu));
      } else if (!area_name) { // Island set by template, but area is not
        successEmbed.addFields({ name: 'Next Step: Area', value: `Island "**${island_name}**" set from template. Please select the area below.`});
        const areas = ISLAND_DATA[island_name]?.areas || [];
        if (areas.length > 0) {
            const areaOptions = areas.map(area => ({ label: area, value: area }));
            const areaSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select-area-${eventId}-${island_name}`) // Include island_name for context
                .setPlaceholder('Select an area...')
                .addOptions(areaOptions);
            components.push(new ActionRowBuilder().addComponents(areaSelectMenu));
        } else {
             successEmbed.addFields({ name: 'Location Note', value: `Island "**${island_name}**" set. No specific areas defined for this island, or an issue occurred.`});
        }
      } else { // Both island and area were set by template
         successEmbed.addFields({ name: 'Location Set', value: `Location **${island_name} - ${area_name}** set from template.`});
      }

      // Always add manage custom fields/rewards buttons if location part is done or was pre-filled
      if (island_name && area_name) { // Or if no location step was needed
        successEmbed.addFields({ name: 'Further Setup', value: `You can now publish the event or manage custom fields/rewards.` });
      }

      // Add buttons for custom fields and rewards
      const manageButtonsRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Manage Custom Fields').setStyle(2),
            new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Manage Rewards').setStyle(2)
        );
      components.push(manageButtonsRow);


      await interaction.editReply({ embeds: [successEmbed], components: components }); // Ephemeral flag is inherited from deferReply

      if (pendingData) {
        client.pendingEventCreations.delete(interaction.user.id); // Clean up
      }

    } catch (modalError) {
      console.error('Error processing eventCreateModal:', modalError);
      // Ensure reply if not already done
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error creating your event draft. Please try again.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      } else {
        await interaction.followUp({ content: 'There was an error creating your event draft. Please try again.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
    }
   } else if (interaction.customId.startsWith('customFieldAddModal-')) {
      try {
        const eventId = interaction.customId.split('-')[1]; // Event ID is now a string
        const fieldName = interaction.fields.getTextInputValue('customFieldName');
        const fieldValue = interaction.fields.getTextInputValue('customFieldValue');
        const displayOrderStr = interaction.fields.getTextInputValue('customFieldDisplayOrder');
        const displayOrder = displayOrderStr ? parseInt(displayOrderStr, 10) : 0;

        if (!fieldName || !fieldValue) {
          return interaction.reply({ content: 'Field Name and Field Value are required.', flags: MessageFlags.Ephemeral });
        }

        await linkStore.addEventCustomField(eventId, fieldName, fieldValue, displayOrder || 0);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Add Another Field').setStyle(1), // Primary
            new ButtonBuilder().setCustomId(`custom-field-finish-${eventId}`).setLabel('Finish Adding Fields').setStyle(2) // Secondary
          );

        return interaction.reply({ content: `Custom field "**${fieldName}**" added. Add another or finish.`, components: [row], flags: MessageFlags.Ephemeral });
      } catch (customModalError) {
        console.error('Error processing customFieldAddModal:', customModalError);
        return interaction.reply({ content: 'Error adding custom field.', flags: MessageFlags.Ephemeral });
      }
    } else if (interaction.customId.startsWith('eventRewardAddModal-')) {
      try {
        const eventId = interaction.customId.split('-')[1]; // Event ID is now a string
        const name = interaction.fields.getTextInputValue('rewardName');
        const description = interaction.fields.getTextInputValue('rewardDescription') || null;
        const imageUrl = interaction.fields.getTextInputValue('rewardImageUrl') || null;
        const displayOrderStr = interaction.fields.getTextInputValue('rewardDisplayOrder');
        const displayOrder = displayOrderStr ? parseInt(displayOrderStr, 10) : 0;

        if (!name) {
          return interaction.reply({ content: 'Reward Name is required.', flags: MessageFlags.Ephemeral });
        }

        await linkStore.addEventReward(eventId, name, description, imageUrl, displayOrder || 0);

        const { ButtonBuilder, ActionRowBuilder } = require('discord.js'); // Ensure in scope
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Add Another Reward').setStyle(1),
            new ButtonBuilder().setCustomId(`reward-finish-${eventId}`).setLabel('Finish Adding Rewards').setStyle(2)
          );

        return interaction.reply({ content: `Reward "**${name}**" added. Add another or finish.`, components: [row], flags: MessageFlags.Ephemeral });
      } catch (rewardModalError) {
        console.error('Error processing eventRewardAddModal:', rewardModalError);
        return interaction.reply({ content: 'Error adding reward.', flags: MessageFlags.Ephemeral });
      }
    }
  } else if (interaction.isButton()) {
    const customIdParts = interaction.customId.split('-');
    const prefix = customIdParts[0];
    const action = customIdParts[1];
    const eventIdStr = customIdParts[2]; // This might be eventId or part of a more complex customId

    if (prefix === 'rsvp' && eventIdStr) {
      const eventId = eventIdStr; // Event ID is now a string
      const rsvpStatusType = action; // 'going', 'interested', 'cantgo' - Renamed to avoid conflict
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userId = interaction.user.id;
        const event = await linkStore.getEventById(eventId);

        if (!event || event.status !== 'published') {
          // editReply will be ephemeral due to deferReply
          return interaction.editReply({ content: 'This event is not available or no longer active for RSVPs.' });
        }

        let newRsvpStatus = type;
        let replyMessage = '';
        let roleAssignedMessage = ''; // For RSVP role assignment status

        if (rsvpStatusType === 'cantgo') { // Use rsvpStatusType consistently
          newRsvpStatus = 'cancelled_rsvp';
          await linkStore.addRsvp(eventId, userId, newRsvpStatus);
          replyMessage = `You've indicated you can't go to **${event.title}**. Your RSVP has been updated.`;

          // Attempt to remove RSVP role if they previously were 'going'
          const rsvpRoleConfig = await linkStore.getRoleConfig(interaction.guildId, 'EVENT_RSVP_ROLE'); // Updated
          if (rsvpRoleConfig && rsvpRoleConfig.role_id && interaction.member) {
            try {
              if (interaction.member.roles.cache.has(rsvpRoleConfig.role_id)) {
                await interaction.member.roles.remove(rsvpRoleConfig.role_id);
                roleAssignedMessage = `\nThe Event RSVP role <@&${rsvpRoleConfig.role_id}> has been removed.`; // Clarified message
              }
            } catch (roleError) {
              console.warn(`Event RSVP Role (cantgo): Failed to remove role ${rsvpRoleConfig.role_id} from ${userId}:`, roleError.message);
              roleAssignedMessage = `\nThere was an issue removing the Event RSVP role. Please check bot permissions.`; // Clarified message
            }
          }

        } else { // 'going' or 'interested'
          newRsvpStatus = rsvpStatusType; // Use rsvpStatusType
          // Check capacity for 'going'
          if (newRsvpStatus === 'going' && event.capacity > 0 && event.rsvp_count_going >= event.capacity) {
            const existingRsvp = await linkStore.getRsvp(eventId, userId);
            if (!existingRsvp || existingRsvp.rsvp_status !== 'going') {
                return interaction.editReply({ content: `Sorry, event **${event.title}** has reached its capacity for 'Going' RSVPs. You can still mark yourself as 'Interested'.` });
            }
          }

          await linkStore.addRsvp(eventId, userId, newRsvpStatus);
          replyMessage = `You are now marked as **${newRsvpStatus}** for event **${event.title}**!`;

          // If 'going', attempt to assign the RSVP role
          if (newRsvpStatus === 'going') {
            const rsvpRoleConfig = await linkStore.getRoleConfig(interaction.guildId, 'EVENT_RSVP_ROLE'); // Updated
            if (rsvpRoleConfig && rsvpRoleConfig.role_id) {
              if (!interaction.member) {
                roleAssignedMessage = `\nCould not assign Event RSVP role as member data is unavailable.`; // Clarified message
              } else {
                try {
                  if (!interaction.member.roles.cache.has(rsvpRoleConfig.role_id)) {
                    await interaction.member.roles.add(rsvpRoleConfig.role_id);
                    roleAssignedMessage = `\nYou have been granted the <@&${rsvpRoleConfig.role_id}> role!`;
                  } else {
                    roleAssignedMessage = `\nYou already have the <@&${rsvpRoleConfig.role_id}> role.`;
                  }
                } catch (roleError) {
                  console.error(`RSVP Role: Failed to assign role ${rsvpRoleConfig.role_id} to ${userId}:`, roleError.message);
                  roleAssignedMessage = `\nThere was an issue assigning the RSVP role. Please check bot permissions and role hierarchy.`;
                }
              }
            }
          }
        }

        replyMessage += roleAssignedMessage; // Append role assignment status

        // Optionally, try to update the original event message with new counts if message_id is stored
        if (event.announcement_message_id && event.announcement_channel_id) {
            try {
                const channel = await client.channels.fetch(event.announcement_channel_id);
                const message = await channel.messages.fetch(event.announcement_message_id);
                const updatedEvent = await linkStore.getEventById(eventId); // Get latest counts

                // Rebuild embed with new counts - requires buildEventEmbed from events.js or similar logic here
                // For simplicity now, we won't rebuild the full embed, just acknowledge.
                // A proper update would involve fetching ISLAND_DATA and using the buildEventEmbed logic.
                // This part can be enhanced later.
            } catch (msgUpdateError) {
                warn(`Could not update event message ${event.announcement_message_id} with new RSVP counts:`, msgUpdateError.message);
            }
        }

        return interaction.editReply({ content: replyMessage });

      } catch (rsvpError) {
        console.error(`Error processing RSVP button for event ${eventId}:`, rsvpError);
        return interaction.editReply({ content: 'There was an error processing your RSVP. Please try again.' }).catch(()=>{});
      }
    } else if (prefix === 'manage' && action === 'custom' && customIdParts[2] === 'fields' && customIdParts[3]) {
        // manage-custom-fields-<eventId>
        const eventId = customIdParts[3]; // Event ID is now a string
        await interaction.deferUpdate(); // Defer update before showing modal
        const { ModalBuilder, TextInputBuilder, ActionRowBuilder } = require('discord.js'); // Ensure they are in scope
        const modal = new ModalBuilder()
            .setCustomId(`customFieldAddModal-${eventId}`)
            .setTitle(`Add Custom Field for Event #${eventId}`);
        const nameInput = new TextInputBuilder().setCustomId('customFieldName').setLabel("Field Name").setStyle(1).setRequired(true);
        const valueInput = new TextInputBuilder().setCustomId('customFieldValue').setLabel("Field Value").setStyle(2).setRequired(true);
        const orderInput = new TextInputBuilder().setCustomId('customFieldDisplayOrder').setLabel("Display Order (Optional, e.g., 1, 2)").setStyle(1).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(valueInput), new ActionRowBuilder().addComponents(orderInput));
        await interaction.showModal(modal);
        // The original interaction (button click) is ephemeral, so no explicit reply needed here as modal takes over.
    } else if (prefix === 'custom' && action === 'field' && customIdParts[2] === 'finish' && customIdParts[3]) {
        // custom-field-finish-<eventId>
        const eventIdCf = customIdParts[3]; // Event ID is now a string
        await interaction.deferUpdate();
        await interaction.editReply({ content: `Finished adding custom fields for Event #${eventIdCf}. You can publish or further edit the event.`, components: [] });
    } else if (prefix === 'edit' && action === 'location' && eventIdStr) {
        // edit-location-<eventId>
        const eventId = eventIdStr; // Event ID is now a string
        await interaction.deferUpdate(); // Defer update before sending new components
        const { ISLAND_DATA } = require('./utils/gameData.js');
        const islandOptions = Object.keys(ISLAND_DATA).map(key => ({
            label: `${ISLAND_DATA[key].emoji} ${key}`,
            value: key,
        }));
        const islandSelectMenu = new StringSelectMenuBuilder()
            .setCustomId(`select-island-${eventId}`)
            .setPlaceholder('Select a new island...')
            .addOptions(islandOptions);
        const row = new ActionRowBuilder().addComponents(islandSelectMenu);
        // This is a button click, so we need to reply or update.
        // Since the original /events edit is ephemeral, this should be an update to that interaction or a new ephemeral reply.
        // interaction.update is for the component's message. If the original /events edit reply had components, this would update it.
        // If it was just an embed, we might need to send a new message or ensure the original interaction can be updated.
        // For simplicity with ephemeral, we can use editReply on the button's interaction.
        await interaction.editReply({ content: `Changing location for Event #${eventId}. Please select the new island.`, embeds: [], components: [row] });

    } else if (prefix === 'manage' && action === 'event' && customIdParts[2] === 'rewards' && customIdParts[3]) {
        // manage-event-rewards-<eventId> - Reworked
        const eventId = customIdParts[3]; // Event ID is now a string
        await interaction.deferReply({ ephemeral: true }); // Changed from deferUpdate to deferReply for a fresh reply
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        try {
            const eventBeingManaged = await linkStore.getEventById(eventId);
            if (!eventBeingManaged) {
                return interaction.editReply({ content: 'Could not find the event to manage rewards for.', components: [] });
            }

            const linkedRewards = await linkStore.getEventRewards(eventId); // This now returns joined data

            const manageRewardsEmbed = new EmbedBuilder()
                .setColor(0x00BCD4)
                .setTitle(`🎁 Rewards for: ${eventBeingManaged.title.substring(0, 200)}`)
                .setTimestamp();

            const components = [];
            let descriptionLines = ['Current rewards linked to this event:'];

            if (!linkedRewards || linkedRewards.length === 0) {
                descriptionLines.push('No rewards are currently linked to this event.');
            } else {
                linkedRewards.forEach(lr => {
                    let iconDisplay = lr.icon_url ? (lr.icon_url.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u) ? lr.icon_url : '[Icon]') : '';
                    descriptionLines.push(`${iconDisplay} **${lr.name}** (Quantity: ${lr.quantity}) - ID: \`${lr.event_reward_id}\``);
                    // Add buttons for each linked reward (up to component limits)
                    // For simplicity in this pass, we'll add one row per reward if few, or paginate later.
                    // This example just lists; buttons will be complex to add dynamically here.
                    // Instead, we'll have general buttons below the list.
                });
                 // Simplified for now: Buttons to edit/unlink will be part of a more complex UI or separate commands if list is long.
                 // For this step, let's focus on listing and the "Link New" button.
                 // A better UI might involve select menus to pick a reward to edit/unlink.
            }
            manageRewardsEmbed.setDescription(descriptionLines.join('\n').substring(0, 4090));

            // Add "Link New Global Reward" button
            const linkNewButton = new ButtonBuilder()
                .setCustomId(`link_new_global_reward_btn-${eventId}`)
                .setLabel('Link New Global Reward')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔗');
            components.push(new ActionRowBuilder().addComponents(linkNewButton));

            // Placeholder: Add buttons for "Edit Quantity" and "Unlink" later if needed.
            // These would likely require selecting a reward first.
            // For now, the user would manage quantities/unlinking by re-linking or via a future specific command.
            // Or, we can add "Manage Existing Links" button which then lists them with edit/unlink buttons.
            // Let's add a generic way to manage existing for now.
            if (linkedRewards && linkedRewards.length > 0) {
                 const manageExistingButton = new ButtonBuilder()
                    .setCustomId(`manage_existing_linked_rewards-${eventId}`)
                    .setLabel('Manage Existing Links')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('✏️');
                // Check if the first row already has max components
                if (components[0] && components[0].components.length < 5) {
                    components[0].addComponents(manageExistingButton);
                } else {
                    components.push(new ActionRowBuilder().addComponents(manageExistingButton));
                }
            }


            await interaction.editReply({ embeds: [manageRewardsEmbed], components: components, ephemeral: true });

        } catch (error) {
            console.error(`Error in manage-event-rewards-${eventId}:`, error);
            await interaction.editReply({ content: 'An error occurred while fetching event reward data.', ephemeral: true });
        }


    } else if (interaction.customId.startsWith('manage_existing_linked_rewards-')) {
        const eventId = interaction.customId.split('-')[1];
        await interaction.deferReply({ephemeral: true});
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const linkedRewards = await linkStore.getEventRewards(eventId);

        if (!linkedRewards || linkedRewards.length === 0) {
            return interaction.editReply({ content: 'No rewards are currently linked to this event to manage.', components: [], ephemeral: true });
        }

        const listEmbed = new EmbedBuilder()
            .setColor(0x00BCD4)
            .setTitle(`✏️ Manage Existing Rewards for Event #${eventId}`)
            .setDescription('Select a reward to edit its quantity or unlink it.');

        const components = [];
        // Max 5 action rows, max 5 buttons per row.
        // Each reward gets an Edit Qty and Unlink button. So 1 reward per row for clarity, or 2 if space is tight.
        for (let i = 0; i < linkedRewards.length && components.length < 5; i++) {
            const lr = linkedRewards[i];
            const actionRow = new ActionRowBuilder();
            let iconDisplay = lr.icon_url ? (lr.icon_url.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u) ? lr.icon_url + " " : '') : '';

            actionRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`edit_event_reward_qty_btn-${lr.event_reward_id}`) // event_reward_id is PK of the link
                    .setLabel(`Qty for: ${iconDisplay}${lr.name.substring(0, 30)} (Currently ${lr.quantity})`)
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`unlink_event_reward_btn-${lr.event_reward_id}`)
                    .setLabel(`Unlink ${lr.name.substring(0, 20)}`)
                    .setStyle(ButtonStyle.Danger)
            );
            components.push(actionRow);
        }
         if (linkedRewards.length > 5) {
            listEmbed.setFooter({text: `Showing management options for the first 5 linked rewards.`});
        }

        await interaction.editReply({embeds: [listEmbed], components: components, ephemeral: true});


    } else if (interaction.customId.startsWith('link_new_global_reward_btn-')) { // Renamed from add_predefined_event_reward_btn
        const eventId = interaction.customId.split('-')[1];
        await interaction.deferUpdate(); // Acknowledge this button click before replying
        const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, EmbedBuilder } = require('discord.js');

        try {
            const globalRewards = await linkStore.getAllGlobalRewardTypes();
            if (!globalRewards || globalRewards.length === 0) {
                return interaction.editReply({ content: 'There are no predefined global reward types available to add. Please create some first via the `/manage` command.', components: [], ephemeral: true });
            }

            const options = globalRewards.slice(0, 25).map(gr => // Max 25 options for select menu
                new StringSelectMenuOptionBuilder()
                    .setLabel(gr.name.substring(0, 100))
                    .setDescription((gr.description || 'No description').substring(0, 100))
                    .setValue(`gr-${gr.reward_type_id}`) // Prefix with gr- to identify it as global reward selection
            );

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select-global-reward-${eventId}`) // eventId is for context of which event to add to
                .setPlaceholder('Select a predefined reward type...')
                .addOptions(options);

            const selectEmbed = new EmbedBuilder()
                .setColor(0x00BCD4)
                .setTitle('📚 Add Predefined Reward')
                .setDescription(`Select a global reward type from the list below to add it as a new reward to event #${eventId}.`)
                .setFooter({text: globalRewards.length > 25 ? 'Showing first 25 predefined types.' : '' });

            await interaction.editReply({ embeds: [selectEmbed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });

        } catch (error) {
            console.error(`Error fetching global reward types for event ${eventId}:`, error);
            await interaction.editReply({ content: 'An error occurred while fetching predefined reward types.', components: [], ephemeral: true });
        }

    } else if (interaction.customId.startsWith('add_custom_event_reward_btn-')) {
        // This is the old 'manage-event-rewards-<eventId>' logic, now more specific
        const eventId = interaction.customId.split('-')[1];
        const { ModalBuilder, TextInputBuilder, ActionRowBuilder } = require('discord.js'); // Keep for this specific path
        const modal = new ModalBuilder()
            .setCustomId(`eventRewardAddModal-${eventId}`) // Existing modal custom ID
            .setTitle(`Add Custom Reward to Event #${eventId}`);
        const nameInput = new TextInputBuilder().setCustomId('rewardName').setLabel("Reward Name").setStyle(1).setRequired(true);
        const descriptionInput = new TextInputBuilder().setCustomId('rewardDescription').setLabel("Description (Optional)").setStyle(2).setRequired(false);
        const imageUrlInput = new TextInputBuilder().setCustomId('rewardImageUrl').setLabel("Image URL (Optional, for icon)").setStyle(1).setRequired(false);
        const orderInput = new TextInputBuilder().setCustomId('rewardDisplayOrder').setLabel("Display Order (Optional)").setStyle(1).setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(descriptionInput),
            new ActionRowBuilder().addComponents(imageUrlInput),
            new ActionRowBuilder().addComponents(orderInput)
        );
        await interaction.showModal(modal);
    } else if (prefix === 'reward' && action === 'finish' && customIdParts[2]) {
        // reward-finish-<eventId>
        const eventId = customIdParts[2]; // Event ID is now a string
        await interaction.deferUpdate();
        await interaction.editReply({ content: `Finished adding rewards for Event #${eventId}.`, components: [] });
    }
    // Other button interactions can be handled here
    else if (interaction.customId === 'manage_bot_moderators') {
      // This now opens a sub-menu for moderator management
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const modManageEmbed = new EmbedBuilder()
        .setColor(0x5865F2) // Discord Blurple
        .setTitle('🛡️ Manage Bot Moderators')
        .setDescription('Add, remove, or list users who have bot moderator permissions.')
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('add_bot_mod_btn')
            .setLabel('Add Moderator')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕'),
          new ButtonBuilder()
            .setCustomId('remove_bot_mod_btn')
            .setLabel('Remove Moderator')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('➖'),
          new ButtonBuilder()
            .setCustomId('list_bot_mods_integrated_btn')
            .setLabel('List Moderators')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📋')
        );
      // This interaction is a button click from the /manage command, which was ephemeral.
      // So, this reply should also be ephemeral.
      await interaction.reply({ embeds: [modManageEmbed], components: [row], ephemeral: true });

    } else if (interaction.customId === 'add_bot_mod_btn') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder()
            .setCustomId('addBotModModal')
            .setTitle('Add Bot Moderator');
        const userInput = new TextInputBuilder()
            .setCustomId('botModUserInput')
            .setLabel("User ID or Mention")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g., 123456789012345678 or @username');
        modal.addComponents(new ActionRowBuilder().addComponents(userInput));
        await interaction.showModal(modal);

    } else if (interaction.customId === 'remove_bot_mod_btn') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder()
            .setCustomId('removeBotModModal')
            .setTitle('Remove Bot Moderator');
        const userInput = new TextInputBuilder()
            .setCustomId('botModUserInput')
            .setLabel("User ID or Mention of Moderator to Remove")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g., 123456789012345678 or @username');
        modal.addComponents(new ActionRowBuilder().addComponents(userInput));
        await interaction.showModal(modal);

    } else if (interaction.customId === 'list_bot_mods_integrated_btn') {
        await interaction.deferReply({ ephemeral: true });
        const { EmbedBuilder } = require('discord.js');
        try {
            const moderators = await linkStore.listModerators();
            const listEmbed = new EmbedBuilder()
                .setColor(0x00BCD4)
                .setTitle('📋 Current Bot Moderators');

            if (!moderators || moderators.length === 0) {
                listEmbed.setDescription('No users are currently designated as bot moderators.');
            } else {
                const modUsers = [];
                for (const mod of moderators) {
                    try {
                        const user = await client.users.fetch(mod.user_id);
                        modUsers.push(`- ${user.tag} (ID: ${mod.user_id})\n  Granted by: <@${mod.granted_by_user_id}> on <t:${mod.granted_at}:D>`);
                    } catch (fetchError) {
                        modUsers.push(`- Unknown User (ID: ${mod.user_id})\n  Granted by: <@${mod.granted_by_user_id}> on <t:${mod.granted_at}:D> (Error fetching user)`);
                        console.warn(`Could not fetch user details for moderator ID ${mod.user_id}:`, fetchError.message);
                    }
                }
                listEmbed.setDescription(modUsers.join('\n').substring(0, 4000));
            }
            await interaction.editReply({ embeds: [listEmbed] });
        } catch (error) {
            console.error('Error listing moderators (integrated):', error);
            await interaction.editReply({ content: 'Could not retrieve the list of moderators.' });
        }
    } else if (interaction.customId === 'manage_event_reward_types') {
      // Handler for "Manage Event Reward Types" button from /manage command
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const rewardTypesEmbed = new EmbedBuilder()
        .setColor(0x5865F2) // Discord Blurple
        .setTitle('🎁 Manage Global Event Reward Types')
        .setDescription('Create, view, edit, or delete global reward types that can be used as templates for events.')
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('create_global_reward_type_btn')
            .setLabel('Create New Reward Type')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕'),
          new ButtonBuilder()
            .setCustomId('list_global_reward_types_btn')
            .setLabel('List Reward Types')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📋')
        );
      // This interaction is a button click from the /manage command, which was ephemeral.
      // So, this reply should also be ephemeral.
      await interaction.reply({ embeds: [rewardTypesEmbed], components: [row], ephemeral: true });

    } else if (interaction.customId === 'create_global_reward_type_btn') {
      // Handler for "Create New Reward Type" button
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId('createGlobalRewardTypeModal')
        .setTitle('Create New Global Reward Type');

      const nameInput = new TextInputBuilder()
        .setCustomId('rewardTypeNameInput')
        .setLabel("Reward Type Name (Unique)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      const descriptionInput = new TextInputBuilder()
        .setCustomId('rewardTypeDescriptionInput')
        .setLabel("Description (Optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500);

      const iconUrlInput = new TextInputBuilder()
        .setCustomId('rewardTypeIconUrlInput')
        .setLabel("Icon URL or Emoji (Optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(255); // Typical URL length limit

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(iconUrlInput)
      );
      await interaction.showModal(modal);

    } else if (interaction.customId === 'list_global_reward_types_btn') {
      // Handler for "List Reward Types" button
      await interaction.deferReply({ ephemeral: true });
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextInputStyle, ModalBuilder, TextInputBuilder: TextInputBuilderList } = require('discord.js'); // Added ModalBuilder, TextInputBuilder for this scope
      try {
        const rewardTypes = await linkStore.getAllGlobalRewardTypes();
        const listEmbed = new EmbedBuilder()
          .setColor(0x00BCD4) // INFO_COLOR
          .setTitle('📋 Global Event Reward Types');

        if (!rewardTypes || rewardTypes.length === 0) {
          listEmbed.setDescription('No global reward types have been created yet. Use the "Create New Reward Type" button to add one.');
          await interaction.editReply({ embeds: [listEmbed], ephemeral: true });
        } else {
          listEmbed.setDescription('Here are the currently configured global reward types:');

          const components = [];
          let currentActionRow = new ActionRowBuilder();
          const maxFields = 25; // Embed field limit
          const maxButtonsTotal = 25; // Max 5 rows * 5 buttons per row
          let buttonsAdded = 0;

          for (let i = 0; i < rewardTypes.length; i++) {
            const rt = rewardTypes[i];
            if (i < maxFields) {
                let valueString = `ID: \`${rt.reward_type_id}\`\nDesc: ${rt.description || '_No description_'}`;
                if (rt.icon_url) {
                    // Check if it's likely an emoji (single character, possibly variant selector)
                    if (rt.icon_url.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u)) {
                        valueString += `\nIcon: ${rt.icon_url}`;
                    } else { // Assume URL
                        valueString += `\nIcon URL: ${rt.icon_url.length > 100 ? rt.icon_url.substring(0,97) + '...' : rt.icon_url}`; // Truncate long URLs
                    }
                }
                valueString += `\nCreated by <@${rt.creator_discord_id}> on <t:${rt.created_at}:D>`;
                 listEmbed.addFields({
                    name: rt.name,
                    value: valueString,
                    inline: false
                });
            }

            // Add Edit and Delete buttons
            if (components.length < 5 && currentActionRow.components.length < 5 && buttonsAdded < maxButtonsTotal) {
                 currentActionRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`edit-reward-type-${rt.reward_type_id}`)
                        .setLabel(`Edit: ${rt.name.substring(0, 20)}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('✏️')
                );
                buttonsAdded++;
            }
            if (components.length < 5 && currentActionRow.components.length < 5 && buttonsAdded < maxButtonsTotal) {
                 currentActionRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`delete-reward-type-${rt.reward_type_id}`)
                        .setLabel(`Del: ${rt.name.substring(0, 20)}`)
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🗑️')
                );
                buttonsAdded++;
            }

            if (currentActionRow.components.length > 0 && (currentActionRow.components.length >= 5 || i === rewardTypes.length - 1 || buttonsAdded >= maxButtonsTotal)) {
                 if(components.length < 5) components.push(currentActionRow);
                 currentActionRow = new ActionRowBuilder();
                 if (buttonsAdded >= maxButtonsTotal && i < rewardTypes.length -1) {
                    listEmbed.setFooter({text: `Displaying buttons for the first ${i+1} types due to Discord limits.`});
                    break;
                 }
            }
          }

          if (rewardTypes.length > maxFields) {
            const currentFooter = listEmbed.data.footer?.text || "";
            listEmbed.setFooter({ text: `Showing details for ${maxFields} of ${rewardTypes.length} types. ${currentFooter}`.trim() });
          }
          await interaction.editReply({ embeds: [listEmbed], components: components, ephemeral: true });
        }
      } catch (error) {
        console.error('Error listing global reward types:', error);
        await interaction.editReply({ content: 'An error occurred while fetching the reward types.', ephemeral: true });
      }
    } else if (interaction.customId.startsWith('edit-reward-type-')) {
        const rewardTypeId = interaction.customId.replace('edit-reward-type-', '');
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        try {
            const rewardType = await linkStore.getGlobalRewardTypeById(rewardTypeId);
            if (!rewardType) {
                return interaction.reply({ content: 'This reward type could not be found. It might have been deleted.', ephemeral: true });
            }

            const modal = new ModalBuilder()
                .setCustomId(`editGlobalRewardTypeModal-${rewardTypeId}`)
                .setTitle(`Edit Reward Type: ${rewardType.name.substring(0, 30)}`);

            const nameInput = new TextInputBuilder()
                .setCustomId('rewardTypeNameInput')
                .setLabel("Reward Type Name (Unique)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(rewardType.name)
                .setMaxLength(100);

            const descriptionInput = new TextInputBuilder()
                .setCustomId('rewardTypeDescriptionInput')
                .setLabel("Description (Optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(rewardType.description || '')
                .setMaxLength(500);

            const iconUrlInput = new TextInputBuilder()
                .setCustomId('rewardTypeIconUrlInput')
                .setLabel("Icon URL or Emoji (Optional)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(rewardType.icon_url || '')
                .setMaxLength(255);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(descriptionInput),
                new ActionRowBuilder().addComponents(iconUrlInput)
            );
            await interaction.showModal(modal);

        } catch (error) {
            console.error(`Error fetching reward type ${rewardTypeId} for edit:`, error);
            await interaction.reply({ content: 'An error occurred while preparing to edit this reward type.', ephemeral: true });
        }
    } else if (interaction.customId.startsWith('delete-reward-type-')) {
        const rewardTypeId = interaction.customId.replace('delete-reward-type-', '');
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        try {
            const rewardType = await linkStore.getGlobalRewardTypeById(rewardTypeId);
            if (!rewardType) {
                return interaction.reply({ content: 'This reward type could not be found. It might have already been deleted.', ephemeral: true });
            }

            const confirmEmbed = new EmbedBuilder()
                .setColor(0xFFC107) // WARN_COLOR
                .setTitle('🗑️ Confirm Deletion')
                .setDescription(`Are you sure you want to delete the global reward type: **${rewardType.name}** (ID: \`${rewardTypeId}\`)?\nThis action cannot be undone.`)
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`confirm-delete-reward-type-${rewardTypeId}`)
                        .setLabel('Confirm Delete')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('cancel-delete-reward-type')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary)
                );
            await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true });
        } catch (error) {
            console.error(`Error fetching reward type ${rewardTypeId} for delete confirmation:`, error);
            await interaction.reply({ content: 'An error occurred while trying to delete this reward type.', ephemeral: true });
        }
    } else if (interaction.customId.startsWith('confirm-delete-reward-type-')) {
        const rewardTypeId = interaction.customId.replace('confirm-delete-reward-type-', '');
        await interaction.deferUpdate(); // Acknowledge button click, will edit message later
        try {
            await linkStore.deleteGlobalRewardType(rewardTypeId);
            await interaction.editReply({ content: `Global reward type (ID: \`${rewardTypeId}\`) has been deleted successfully.`, embeds: [], components: [], ephemeral: true });
        } catch (error) {
            console.error(`Error deleting reward type ${rewardTypeId}:`, error);
            await interaction.editReply({ content: 'An error occurred while deleting the reward type.', embeds: [], components: [], ephemeral: true });
        }
    } else if (interaction.customId === 'cancel-delete-reward-type') {
        await interaction.deferUpdate();
        await interaction.editReply({ content: 'Deletion cancelled.', embeds: [], components: [], ephemeral: true });
    } else if (interaction.customId === 'configure_bot_roles_btn') {
        await interaction.deferReply({ ephemeral: true });
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        // Define manageable role types and their display names
        const manageableRoleTypes = [
            { type: 'VERIFIED_ROLE', name: 'Verified User Role', description: 'Role assigned after successful Roblox account verification.' },
            { type: 'EVENT_RSVP_ROLE', name: 'Event RSVP "Going" Role', description: 'Role assigned when a user RSVPs "Going" to an event.' },
            // Add more role types here as needed, e.g.:
            // { type: 'BOT_MOD_ROLE', name: 'Bot Moderator Role (Informational)', description: 'A general role for bot mods (actual permissions are DB based).' },
        ];

        try {
            const allConfigs = await linkStore.getAllRoleConfigs(interaction.guildId);
            const configsMap = new Map(allConfigs.map(c => [c.config_type, c]));

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('⚙️ Configure Bot Roles')
                .setDescription('Set or change various important roles used by the bot.')
                .setTimestamp();

            const components = [];

            for (const roleType of manageableRoleTypes) {
                const currentConfig = configsMap.get(roleType.type);
                let roleInfo = `**${roleType.name}**: ${currentConfig ? `<@&${currentConfig.role_id}> (\`${currentConfig.role_id}\`)` : '_Not Set_'}`;
                roleInfo += `\n*${roleType.description}*`;
                embed.addFields({ name: '\u200B', value: roleInfo }); // Using zero-width space for a visual break if needed

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`set_role_btn-${roleType.type}`)
                            .setLabel(currentConfig ? 'Change Role' : 'Set Role')
                            .setStyle(ButtonStyle.Primary)
                    );
                if (currentConfig) {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`clear_role_btn-${roleType.type}`)
                            .setLabel('Clear Setting')
                            .setStyle(ButtonStyle.Danger)
                    );
                }
                components.push(row);
            }
            if (components.length === 0) { // Should not happen with predefined manageableRoleTypes
                embed.addFields({name: "No Configurable Roles", value: "No role types are currently defined for configuration."});
            }

            await interaction.editReply({ embeds: [embed], components: components, ephemeral: true });

        } catch (error) {
            console.error('Error fetching or displaying role configurations:', error);
            await interaction.editReply({ content: 'An error occurred while loading role configurations.', ephemeral: true });
        }

    } else if (interaction.customId.startsWith('set_role_btn-')) {
        const configType = interaction.customId.split('-')[1];
        // Defer update because we are sending a new message with a select menu
        await interaction.deferUpdate({ephemeral: true});
        const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, EmbedBuilder } = require('discord.js');

        try {
            const roles = await interaction.guild.roles.fetch();
            const roleOptions = roles
                .filter(role => !role.managed && role.id !== interaction.guild.id) // Filter out managed roles and @everyone
                .map(role => new StringSelectMenuOptionBuilder().setLabel(role.name.substring(0,100)).setValue(role.id))
                .slice(0, 25); // Max 25 options

            if (roleOptions.length === 0) {
                return interaction.followUp({ content: 'No suitable roles found in this server to select.', ephemeral: true });
            }

            // Find display name for configType
            const manageableRoleTypes = [ // Duplicated here for now, consider moving to a shared const
                { type: 'VERIFIED_ROLE', name: 'Verified User Role' },
                { type: 'EVENT_RSVP_ROLE', name: 'Event RSVP "Going" Role' },
            ];
            const roleTypeInfo = manageableRoleTypes.find(rt => rt.type === configType);
            const roleTypeName = roleTypeInfo ? roleTypeInfo.name : configType;


            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select_discord_role_menu-${configType}`)
                .setPlaceholder(`Select a role for: ${roleTypeName}`)
                .addOptions(roleOptions);

            const selectEmbed = new EmbedBuilder()
                .setColor(0x00BCD4)
                .setTitle(`Select Role for: ${roleTypeName}`)
                .setDescription(`Please choose a role from the server to be used as the "${roleTypeName}".`);

            // Since original interaction was deferred, use followUp for new message with select menu
            await interaction.followUp({ embeds: [selectEmbed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });

        } catch (error) {
            console.error(`Error fetching roles for ${configType}:`, error);
            await interaction.followUp({ content: `An error occurred while fetching server roles. Ensure the bot has 'View Roles' permission.`, ephemeral: true });
        }
    } else if (interaction.customId.startsWith('clear_role_btn-')) {
        const configType = interaction.customId.split('-')[1];
        // Confirmation for clearing
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const confirmEmbed = new EmbedBuilder()
            .setColor(0xFFC107)
            .setTitle(`🗑️ Confirm Clear Role: ${configType}`)
            .setDescription(`Are you sure you want to clear the configuration for the "${configType}" role?`)
            .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`confirm_clear_role-${configType}`).setLabel('Confirm Clear').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('cancel_clear_role').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true }); // New reply for this confirmation

    } else if (interaction.customId.startsWith('confirm_clear_role-')) {
        const configType = interaction.customId.split('-')[1];
        await interaction.deferUpdate();
        try {
            await linkStore.clearRoleConfig(interaction.guildId, configType);
            // Optionally, resend the configure_bot_roles_btn view or a success message
            await interaction.editReply({ content: `Configuration for "${configType}" role has been cleared.`, components: [], embeds:[] });
        } catch (error) {
            console.error(`Error clearing role config ${configType}:`, error);
            await interaction.editReply({ content: `An error occurred while clearing the role config.`, components: [], embeds:[] });
        }
    } else if (interaction.customId === 'cancel_clear_role') {
        await interaction.deferUpdate();
        await interaction.editReply({ content: 'Clearing role configuration cancelled.', components: [], embeds:[] });
    }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId === 'addBotModModal') {
        await interaction.deferReply({ ephemeral: true });
        const userInput = interaction.fields.getTextInputValue('botModUserInput');
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        let targetUser;

        // Resolve user input (ID or mention)
        const userIdMatch = userInput.match(/^<@!?(\d+)>$/) || userInput.match(/^(\d+)$/);
        if (userIdMatch) {
            try {
                targetUser = await client.users.fetch(userIdMatch[1]);
            } catch (e) {
                return interaction.editReply({ content: `Could not find user with ID: ${userIdMatch[1]}. Please provide a valid User ID or mention.`, ephemeral: true });
            }
        } else {
            return interaction.editReply({ content: 'Invalid user input. Please provide a User ID or mention.', ephemeral: true });
        }

        if (!targetUser) {
             return interaction.editReply({ content: 'Could not resolve the user. Please try again with a valid ID or mention.', ephemeral: true });
        }
        if (targetUser.bot) {
            return interaction.editReply({ content: 'Bots cannot be designated as bot moderators.', ephemeral: true });
        }

        try {
            await linkStore.grantModeratorRole(targetUser.id, interaction.user.id);
            const successEmbed = new EmbedBuilder()
                .setColor(0x4CAF50)
                .setTitle('✅ Moderator Added')
                .setDescription(`${targetUser.tag} (${targetUser.id}) has been granted bot moderator status.`);

            const backButton = new ButtonBuilder().setCustomId('manage_bot_moderators').setLabel('Back to Mod Management').setStyle(ButtonStyle.Primary);
            await interaction.editReply({ embeds: [successEmbed], components: [new ActionRowBuilder().addComponents(backButton)] });
        } catch (error) {
            console.error(`Error granting moderator role to ${targetUser.id} via /manage:`, error);
            await interaction.editReply({ content: `Could not grant moderator status to ${targetUser.tag}. Please check logs.`});
        }

    } else if (interaction.customId === 'removeBotModModal') {
        await interaction.deferReply({ ephemeral: true });
        const userInput = interaction.fields.getTextInputValue('botModUserInput');
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        let targetUser;

        const userIdMatch = userInput.match(/^<@!?(\d+)>$/) || userInput.match(/^(\d+)$/);
        if (userIdMatch) {
            try {
                targetUser = await client.users.fetch(userIdMatch[1]);
            } catch (e) {
                return interaction.editReply({ content: `Could not find user with ID: ${userIdMatch[1]}.`, ephemeral: true });
            }
        } else {
            return interaction.editReply({ content: 'Invalid user input. Please provide a User ID or mention.', ephemeral: true });
        }

        if (!targetUser) {
             return interaction.editReply({ content: 'Could not resolve the user.', ephemeral: true });
        }

        try {
            const isMod = await linkStore.isBotModerator(targetUser.id);
            if (!isMod) {
                 return interaction.editReply({ content: `${targetUser.tag} is not currently a bot moderator.`, ephemeral: true });
            }
            await linkStore.revokeModeratorRole(targetUser.id);
            const successEmbed = new EmbedBuilder()
                .setColor(0x4CAF50) // Or an orange/yellow for removal
                .setTitle('🗑️ Moderator Removed')
                .setDescription(`${targetUser.tag} (${targetUser.id}) has had their bot moderator status revoked.`);

            const backButton = new ButtonBuilder().setCustomId('manage_bot_moderators').setLabel('Back to Mod Management').setStyle(ButtonStyle.Primary);
            await interaction.editReply({ embeds: [successEmbed], components: [new ActionRowBuilder().addComponents(backButton)] });
        } catch (error) {
            console.error(`Error revoking moderator role from ${targetUser.id} via /manage:`, error);
            await interaction.editReply({ content: `Could not revoke moderator status from ${targetUser.tag}. Please check logs.`});
        }

    // The 'setRsvpRoleModal' handler was here. It has been removed as it's obsolete.
    // Modals for add/remove bot mod are handled above.
    // Next modal is editGlobalRewardTypeModal.
    else if (interaction.customId.startsWith('editGlobalRewardTypeModal-')) {
        // Format: setEventRewardQuantityModal-<eventId>-<globalRewardTypeId>
        const parts = interaction.customId.split('-');
        const eventId = parts[1];
        const globalRewardTypeId = parts[2];
        await interaction.deferReply({ ephemeral: true });
        const quantityStr = interaction.fields.getTextInputValue('eventRewardQuantityInput');
        const quantity = parseInt(quantityStr, 10);
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');


        if (isNaN(quantity) || quantity < 1) {
            return interaction.editReply({ content: 'Invalid quantity. Please enter a positive number.', ephemeral: true });
        }

        try {
            await linkStore.linkEventReward(eventId, globalRewardTypeId, quantity);
            const globalReward = await linkStore.getGlobalRewardTypeById(globalRewardTypeId); // For name in reply
            const successEmbed = new EmbedBuilder()
                .setColor(0x4CAF50)
                .setTitle('✅ Reward Linked to Event')
                .setDescription(`Successfully linked global reward **${globalReward?.name || 'Selected Reward'}** with quantity **${quantity}** to event #${eventId}.`)
                .setTimestamp();

            // Provide buttons to link another or go back to managing this event's rewards
            const followupRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`link_new_global_reward_btn-${eventId}`)
                        .setLabel('Link Another Reward')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`manage-event-rewards-${eventId.split('_')[0]}-${eventId.split('_')[1]}-${eventId.split('_')[2]}-${eventId.split('_')[3]}`) // Reconstruct original manage ID
                        .setLabel('Back to Event Rewards')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.editReply({ embeds: [successEmbed], components: [followupRow], ephemeral: true });
        } catch (error) {
            console.error(`Error linking global reward ${globalRewardTypeId} to event ${eventId} with quantity ${quantity}:`, error);
            await interaction.editReply({ content: 'An error occurred while linking the reward to the event.', ephemeral: true });
        }

    } else if (interaction.customId.startsWith('updateEventRewardQuantityModal-')) {
        const eventSpecificRewardId = interaction.customId.replace('updateEventRewardQuantityModal-', '');
        await interaction.deferReply({ ephemeral: true });
        const quantityStr = interaction.fields.getTextInputValue('eventRewardQuantityInput');
        const quantity = parseInt(quantityStr, 10);
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        if (isNaN(quantity) || quantity < 1) {
            return interaction.editReply({ content: 'Invalid quantity. Please enter a positive number.', ephemeral: true });
        }

        try {
            await linkStore.updateEventRewardQuantity(eventSpecificRewardId, quantity);
            const updatedRewardInfo = await linkStore.getSpecificEventReward(eventSpecificRewardId); // Get name for reply

            const successEmbed = new EmbedBuilder()
                .setColor(0x4CAF50)
                .setTitle('✅ Reward Quantity Updated')
                .setDescription(`Quantity for reward **${updatedRewardInfo?.name || 'Reward'}** (Link ID: \`${eventSpecificRewardId}\`) updated to **${quantity}**.`)
                .setTimestamp();

            // Button to go back to managing this event's rewards. Need eventId.
            // We'd need to fetch the eventId from updatedRewardInfo.event_id
            const eventId = updatedRewardInfo?.event_id;
            const actionRow = new ActionRowBuilder();
            if (eventId) {
                 actionRow.addComponents(
                     new ButtonBuilder()
                        .setCustomId(`manage-event-rewards-${eventId.split('_')[0]}-${eventId.split('_')[1]}-${eventId.split('_')[2]}-${eventId.split('_')[3]}`)
                        .setLabel('Back to Event Rewards')
                        .setStyle(ButtonStyle.Primary)
                 );
            }


            await interaction.editReply({ embeds: [successEmbed], components: actionRow.components.length > 0 ? [actionRow] : [], ephemeral: true });
        } catch (error) {
            console.error(`Error updating quantity for event reward ${eventSpecificRewardId}:`, error);
            await interaction.editReply({ content: 'An error occurred while updating the reward quantity.', ephemeral: true });
        }


    } else if (interaction.customId.startsWith('editGlobalRewardTypeModal-')) {
        const rewardTypeId = interaction.customId.replace('editGlobalRewardTypeModal-', '');
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.fields.getTextInputValue('rewardTypeNameInput');
        const description = interaction.fields.getTextInputValue('rewardTypeDescriptionInput');
        const iconUrl = interaction.fields.getTextInputValue('rewardTypeIconUrlInput') || null; // Get icon_url
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        try {
            // Check for name conflict only if the name has changed
            const originalType = await linkStore.getGlobalRewardTypeById(rewardTypeId);
            if (originalType && originalType.name !== name) {
                const existingByName = await linkStore.getGlobalRewardTypeByName(name);
                if (existingByName) {
                    return interaction.editReply({ content: `Another global reward type with the name "${name}" already exists. Please choose a unique name.`, ephemeral: true });
                }
            }

            await linkStore.updateGlobalRewardType(rewardTypeId, name, description, iconUrl); // Pass iconUrl

            const successEmbed = new EmbedBuilder()
                .setColor(0x4CAF50) // SUCCESS_COLOR
                .setTitle('✅ Reward Type Updated')
                .setDescription(`Global reward type "**${name}**" (ID: \`${rewardTypeId}\`) updated successfully!`)
                .setTimestamp();

            const actionRow = new ActionRowBuilder()
                .addComponents(
                     new ButtonBuilder()
                        .setCustomId('list_global_reward_types_btn')
                        .setLabel('View All Reward Types')
                        .setStyle(ButtonStyle.Primary)
                );
            await interaction.editReply({ embeds: [successEmbed], components: [actionRow], ephemeral: true });

        } catch (error) {
            console.error(`Error updating global reward type ${rewardTypeId}:`, error);
            let errorMessage = 'An error occurred while updating the reward type.';
             if (error.message && error.message.includes('UNIQUE constraint failed')) {
                errorMessage = `Another global reward type with the name "${name}" already exists or another unique constraint was violated.`;
            } else if (error.code === 11000) { // MongoDB duplicate key
                errorMessage = `Another global reward type with the name "${name}" already exists or another unique constraint was violated (MongoDB).`;
            }
            await interaction.editReply({ content: errorMessage, ephemeral: true });
        }
    } else if (interaction.customId === 'createGlobalRewardTypeModal') {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.fields.getTextInputValue('rewardTypeNameInput');
      const description = interaction.fields.getTextInputValue('rewardTypeDescriptionInput');
      const iconUrl = interaction.fields.getTextInputValue('rewardTypeIconUrlInput') || null; // Get icon_url
      const { generateRewardTypeId } = require('./utils/idGenerator');
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      try {
        const existing = await linkStore.getGlobalRewardTypeByName(name);
        if (existing) {
          return interaction.editReply({ content: `A global reward type with the name "${name}" already exists. Please choose a unique name.`, ephemeral: true });
        }

        const rewardTypeId = generateRewardTypeId();
        await linkStore.createGlobalRewardType(rewardTypeId, name, description, interaction.user.id, iconUrl); // Pass iconUrl

        const successEmbed = new EmbedBuilder()
            .setColor(0x4CAF50) // SUCCESS_COLOR
            .setTitle('✅ Reward Type Created')
            .setDescription(`Global reward type "**${name}**" (ID: \`${rewardTypeId}\`) created successfully!`)
            .setTimestamp();

        const actionRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('list_global_reward_types_btn')
                    .setLabel('View All Reward Types')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('create_global_reward_type_btn')
                    .setLabel('Create Another')
                    .setStyle(ButtonStyle.Success)
            );

        await interaction.editReply({ embeds: [successEmbed], components: [actionRow], ephemeral: true });
      } catch (error) {
        console.error('Error creating global reward type:', error);
        let errorMessage = 'An error occurred while creating the reward type.';
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            errorMessage = `A global reward type with the name "${name}" already exists or another unique constraint was violated.`;
        } else if (error.code === 11000) { // MongoDB duplicate key
            errorMessage = `A global reward type with the name "${name}" already exists or another unique constraint was violated (MongoDB).`;
        }
        await interaction.editReply({ content: errorMessage, ephemeral: true });
      }
    } else if (interaction.customId === 'eventCreateModal') {
      try {
      // Defer reply immediately for modal submission
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const title = interaction.fields.getTextInputValue('eventTitle');
      const description = interaction.fields.getTextInputValue('eventDescription');
      const dateStr = interaction.fields.getTextInputValue('eventDate');
      const timeStr = interaction.fields.getTextInputValue('eventTime');
      let imageMainUrl = interaction.fields.getTextInputValue('eventImageMainUrl') || null; // From modal

      // Check if there was a pre-uploaded image or template data from the command
      const pendingData = client.pendingEventCreations.get(interaction.user.id);
      if (pendingData && pendingData.attachmentUrl) {
        imageMainUrl = pendingData.attachmentUrl; // Prioritize uploaded image
      }

      let island_name = null;
      let area_name = null;
      let capacity = 0;

      if (pendingData && pendingData.templateIsland) island_name = pendingData.templateIsland;
      if (pendingData && pendingData.templateArea) area_name = pendingData.templateArea;
      if (pendingData && pendingData.templateCapacity) capacity = parseInt(pendingData.templateCapacity, 10) || 0;

      // TODO: Add island/area selection UI logic. For now, using template or null.
      // This would typically involve another interaction step (select menu) after modal.

      // Validate date and time (basic)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
        return interaction.followUp({ content: 'Invalid date or time format. Please use YYYY-MM-DD and HH:MM (UTC).', ephemeral: true });
      }
      const start_at = Math.floor(new Date(`${dateStr}T${timeStr}:00.000Z`).getTime() / 1000); // Assume UTC
      const now = Math.floor(Date.now() / 1000);

      const eventData = {
        title,
        description,
        creator_discord_id: interaction.user.id,
        status: 'draft',
        created_at: now,
        updated_at: now,
        start_at,
        island_name,
        area_name,
        image_main_url: imageMainUrl,
        capacity: capacity,
      };

      const eventId = await linkStore.createEvent(eventData);
      const successEmbed = new EmbedBuilder()
        .setColor(0x4CAF50) // SUCCESS_COLOR
        .setTitle('🎉 Event Draft Created!')
        .setDescription(`Your event draft "**${title}**" has been created with ID #${eventId}.`)
        .setTimestamp();

      const components = [];
      const { ISLAND_DATA } = require('./utils/gameData.js'); // Ensure ISLAND_DATA is available

      // Determine next step: Location selection or just custom fields/rewards
      if (!island_name) { // Island not set by template, ask user
        successEmbed.addFields({ name: 'Next Step: Location', value: 'Please select the island for your event below.'});
        const islandOptions = Object.keys(ISLAND_DATA).map(key => ({
            label: `${ISLAND_DATA[key].emoji} ${key}`,
            value: key,
        }));
        const islandSelectMenu = new StringSelectMenuBuilder()
            .setCustomId(`select-island-${eventId}`)
            .setPlaceholder('Select an island...')
            .addOptions(islandOptions);
        components.push(new ActionRowBuilder().addComponents(islandSelectMenu));
      } else if (!area_name) { // Island set by template, but area is not
        successEmbed.addFields({ name: 'Next Step: Area', value: `Island "**${island_name}**" set from template. Please select the area below.`});
        const areas = ISLAND_DATA[island_name]?.areas || [];
        if (areas.length > 0) {
            const areaOptions = areas.map(area => ({ label: area, value: area }));
            const areaSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select-area-${eventId}-${island_name}`) // Include island_name for context
                .setPlaceholder('Select an area...')
                .addOptions(areaOptions);
            components.push(new ActionRowBuilder().addComponents(areaSelectMenu));
        } else {
             successEmbed.addFields({ name: 'Location Note', value: `Island "**${island_name}**" set. No specific areas defined for this island, or an issue occurred.`});
        }
      } else { // Both island and area were set by template
         successEmbed.addFields({ name: 'Location Set', value: `Location **${island_name} - ${area_name}** set from template.`});
      }

      // Always add manage custom fields/rewards buttons if location part is done or was pre-filled
      if (island_name && area_name) { // Or if no location step was needed
        successEmbed.addFields({ name: 'Further Setup', value: `You can now publish the event or manage custom fields/rewards.` });
      }

      // Add buttons for custom fields and rewards
      const manageButtonsRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Manage Custom Fields').setStyle(2),
            new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Manage Rewards').setStyle(2)
        );
      components.push(manageButtonsRow);


      await interaction.editReply({ embeds: [successEmbed], components: components }); // Ephemeral flag is inherited from deferReply

      if (pendingData) {
        client.pendingEventCreations.delete(interaction.user.id); // Clean up
      }

    } catch (modalError) {
      console.error('Error processing eventCreateModal:', modalError);
      // Ensure reply if not already done
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error creating your event draft. Please try again.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      } else {
        await interaction.followUp({ content: 'There was an error creating your event draft. Please try again.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
    }
   } else if (interaction.customId.startsWith('customFieldAddModal-')) {
      try {
        const eventId = interaction.customId.split('-')[1]; // Event ID is now a string
        const fieldName = interaction.fields.getTextInputValue('customFieldName');
        const fieldValue = interaction.fields.getTextInputValue('customFieldValue');
        const displayOrderStr = interaction.fields.getTextInputValue('customFieldDisplayOrder');
        const displayOrder = displayOrderStr ? parseInt(displayOrderStr, 10) : 0;

        if (!fieldName || !fieldValue) {
          return interaction.reply({ content: 'Field Name and Field Value are required.', flags: MessageFlags.Ephemeral });
        }

        await linkStore.addEventCustomField(eventId, fieldName, fieldValue, displayOrder || 0);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Add Another Field').setStyle(1), // Primary
            new ButtonBuilder().setCustomId(`custom-field-finish-${eventId}`).setLabel('Finish Adding Fields').setStyle(2) // Secondary
          );

        return interaction.reply({ content: `Custom field "**${fieldName}**" added. Add another or finish.`, components: [row], flags: MessageFlags.Ephemeral });
      } catch (customModalError) {
        console.error('Error processing customFieldAddModal:', customModalError);
        return interaction.reply({ content: 'Error adding custom field.', flags: MessageFlags.Ephemeral });
      }
    } else if (interaction.customId.startsWith('eventRewardAddModal-')) {
      try {
        const eventId = interaction.customId.split('-')[1]; // Event ID is now a string
        const name = interaction.fields.getTextInputValue('rewardName');
        const description = interaction.fields.getTextInputValue('rewardDescription') || null;
        const imageUrl = interaction.fields.getTextInputValue('rewardImageUrl') || null;
        const displayOrderStr = interaction.fields.getTextInputValue('rewardDisplayOrder');
        const displayOrder = displayOrderStr ? parseInt(displayOrderStr, 10) : 0;

        if (!name) {
          return interaction.reply({ content: 'Reward Name is required.', flags: MessageFlags.Ephemeral });
        }

        await linkStore.addEventReward(eventId, name, description, imageUrl, displayOrder || 0);

        const { ButtonBuilder, ActionRowBuilder } = require('discord.js'); // Ensure in scope
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Add Another Reward').setStyle(1),
            new ButtonBuilder().setCustomId(`reward-finish-${eventId}`).setLabel('Finish Adding Rewards').setStyle(2)
          );

        return interaction.reply({ content: `Reward "**${name}**" added. Add another or finish.`, components: [row], flags: MessageFlags.Ephemeral });
      } catch (rewardModalError) {
        console.error('Error processing eventRewardAddModal:', rewardModalError);
        return interaction.reply({ content: 'Error adding reward.', flags: MessageFlags.Ephemeral });
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    const { ISLAND_DATA } = require('./utils/gameData.js'); // Ensure ISLAND_DATA is available
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js'); // For follow-up messages

    const customIdParts = interaction.customId.split('-');
    const type = customIdParts[0]; // 'select'
    const entity = customIdParts[1]; // 'island' or 'area'
    const eventId = customIdParts[2]; // Event ID is now a string

    if (entity === 'island' && eventId) {
        try {
            await interaction.deferUpdate(); // Defer update for select menu
            const selectedIsland = interaction.values[0];
            await linkStore.updateEvent(eventId, { island_name: selectedIsland });

            const areas = ISLAND_DATA[selectedIsland]?.areas || [];
            let followupComponents = [];
            let followupMessage = `Island set to **${selectedIsland}** for Event #${eventId}.`;

            if (areas.length > 0) {
                const areaOptions = areas.map(area => ({ label: area, value: area }));
                const areaSelectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`select-area-${eventId}-${selectedIsland}`)
                    .setPlaceholder('Select an area...')
                    .addOptions(areaOptions);
                followupComponents.push(new ActionRowBuilder().addComponents(areaSelectMenu));
                followupMessage += '\nNow, please select the area for the event.';
            } else {
                followupMessage += '\nNo specific areas defined for this island. Location set.';
                // If no areas, we might offer custom fields/rewards buttons again, or just confirm.
                 const manageButtonsRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Manage Custom Fields').setStyle(2),
                        new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Manage Rewards').setStyle(2)
                    );
                followupComponents.push(manageButtonsRow);
            }
            // Update the message that contained the island select menu
            await interaction.editReply({ content: followupMessage, components: followupComponents });

        } catch (islandSelectError) {
            console.error(`Error processing island select for event ${eventId}:`, islandSelectError);
            // Avoid further interaction errors if the original interaction is already invalid.
            console.warn(`[INDEX_HANDLER] Could not send user-facing error for island select for event ${eventId} as interaction might be invalid.`);
        }
    } else if (entity === 'area' && eventId) {
        try {
            await interaction.deferUpdate(); // Defer update for select menu
            const selectedArea = interaction.values[0];
            // islandName might be part of customIdParts[3] if needed for context, e.g. customId: select-area-<eventId>-<islandName>
            // const islandName = customIdParts[3];
            await linkStore.updateEvent(eventId, { area_name: selectedArea });

            let finalMessage = `Location set to area **${selectedArea}** for Event #${eventId}. All main details set!`;

            // Offer custom fields/rewards buttons
            const manageButtonsRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Manage Custom Fields').setStyle(2),
                    new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Manage Rewards').setStyle(2)
                );

            await interaction.editReply({ content: finalMessage, components: [manageButtonsRow] });
        } catch (areaSelectError) {
            console.error(`Error processing area select for event ${eventId}:`, areaSelectError);
            // Avoid further interaction errors if the original interaction is already invalid.
            console.warn(`[INDEX_HANDLER] Could not send user-facing error for area select for event ${eventId} as interaction might be invalid.`);
        }
    } else if (interaction.customId.startsWith('select_discord_role_menu-')) {
        const configType = interaction.customId.split('-')[1];
        const selectedRoleId = interaction.values[0];
        await interaction.deferUpdate(); // Acknowledge select menu, will follow up

        try {
            await linkStore.setRoleConfig(interaction.guildId, configType, selectedRoleId, interaction.user.id);

            // Find display name for configType for the success message
             const manageableRoleTypes = [
                { type: 'VERIFIED_ROLE', name: 'Verified User Role' },
                { type: 'EVENT_RSVP_ROLE', name: 'Event RSVP "Going" Role' },
            ];
            const roleTypeInfo = manageableRoleTypes.find(rt => rt.type === configType);
            const roleTypeName = roleTypeInfo ? roleTypeInfo.name : configType;

            // Success message, possibly with a button to go back to the role config screen
            const successEmbed = new EmbedBuilder()
                .setColor(0x4CAF50)
                .setTitle('✅ Role Configured')
                .setDescription(`The **${roleTypeName}** has been set to <@&${selectedRoleId}> (\`${selectedRoleId}\`).`)
                .setFooter({text: "Ensure the bot has permissions to manage this role if applicable."})
                .setTimestamp();

            const backButton = new ButtonBuilder()
                .setCustomId('configure_bot_roles_btn') // Takes them back to the role config main screen
                .setLabel('Back to Role Configurations')
                .setStyle(ButtonStyle.Primary);

            await interaction.editReply({ embeds: [successEmbed], components: [new ActionRowBuilder().addComponents(backButton)], ephemeral: true });
            // interaction.followUp might be better if the original reply for select menu was complex or not from this interaction.
            // Since set_role_btn uses deferUpdate then followUp, this editReply to the original select menu interaction should be fine.

        } catch (error) {
            console.error(`Error setting role config for ${configType} to ${selectedRoleId}:`, error);
            await interaction.editReply({ content: 'An error occurred while saving the role configuration.', components:[], ephemeral: true });
        }


    } else if (customIdParts[0] === 'select' && customIdParts[1] === 'global' && customIdParts[2] === 'reward' && customIdParts[3]) {
        // customId: select-global-reward-for-linking-<eventId> (was select-global-reward-<eventId>)
        const eventId = customIdParts[3];
        const selectedGlobalRewardId = interaction.values[0].replace('gr-', '');
        // No deferUpdate needed here as we are showing a modal
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

        const modal = new ModalBuilder()
            .setCustomId(`setEventRewardQuantityModal-${eventId}-${selectedGlobalRewardId}`)
            .setTitle('Set Reward Quantity');

        const quantityInput = new TextInputBuilder()
            .setCustomId('eventRewardQuantityInput')
            .setLabel("Quantity for this reward")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue('1') // Default to 1
            .setPlaceholder('e.g., 1, 5, 10');

        modal.addComponents(new ActionRowBuilder().addComponents(quantityInput));
        await interaction.showModal(modal);
        // Modal submission will handle the rest.

    } else if (interaction.customId.startsWith('edit_event_reward_qty_btn-')) {
        const eventSpecificRewardId = interaction.customId.split('-')[1];
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        // We need to fetch the current quantity to pre-fill the modal.
        // This requires a method to get a single event_reward link by its ID.
        // Let's assume linkStore.getEventRewardLinkById(eventSpecificRewardId) exists or add it.
        // For now, let's proceed assuming we can get the quantity.
        // This part of the logic might need a new linkStore method: getSpecificEventReward(eventRewardId)
        // which returns the joined data like getEventRewards but for a single link.
        // Or, we can pass current quantity in customId if feasible, but that's messy.
        // Let's make a placeholder for current quantity.

        // Simplified: Assuming we can get the eventId from the eventSpecificRewardId if needed for title
        // For now, just use a generic title.
        // Fetch the specific reward to pre-fill quantity and potentially name in title
        const specificReward = await linkStore.getSpecificEventReward(eventSpecificRewardId);
        if (!specificReward) {
            return interaction.reply({ content: 'Could not find the specific reward link to edit.', ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId(`updateEventRewardQuantityModal-${eventSpecificRewardId}`)
            .setTitle(`Edit Qty: ${specificReward.name.substring(0,30)}`);

        const quantityInput = new TextInputBuilder()
            .setCustomId('eventRewardQuantityInput')
            .setLabel("New quantity for this reward")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(specificReward.quantity.toString()) // Pre-fill with current quantity
            .setPlaceholder('e.g., 1, 5, 10');

        modal.addComponents(new ActionRowBuilder().addComponents(quantityInput));
        await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('unlink_event_reward_btn-')) {
        const eventSpecificRewardId = interaction.customId.split('-')[1];
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        // Fetch details for confirmation message
        // This would ideally use a new linkStore.getSpecificEventReward(eventSpecificRewardId)
        // For now, a generic message.
        const confirmEmbed = new EmbedBuilder()
            .setColor(0xFFC107)
            .setTitle('🗑️ Confirm Unlink Reward')
            .setDescription(`Are you sure you want to unlink this reward from the event? (ID: \`${eventSpecificRewardId}\`)`)
            .setTimestamp();
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_unlink_event_reward-${eventSpecificRewardId}`)
                    .setLabel('Confirm Unlink')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('cancel_unlink_event_reward')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );
        await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true });

    } else if (interaction.customId.startsWith('confirm_unlink_event_reward-')) {
        const eventSpecificRewardId = interaction.customId.split('-')[1];
        await interaction.deferUpdate();
        try {
            await linkStore.deleteEventReward(eventSpecificRewardId); // deleteEventReward uses the PK of event_rewards
            await interaction.editReply({ content: 'Reward unlinked successfully.', embeds: [], components: [], ephemeral: true });
        } catch (error) {
            console.error(`Error unlinking event reward ${eventSpecificRewardId}:`, error);
            await interaction.editReply({ content: 'An error occurred while unlinking the reward.', embeds: [], components: [], ephemeral: true });
        }
    } else if (interaction.customId === 'cancel_unlink_event_reward') {
        await interaction.deferUpdate();
        await interaction.editReply({ content: 'Unlinking reward cancelled.', embeds: [], components: [], ephemeral: true });

    } else if (interaction.customId === 'select_event_to_publish') {
      try {
        await interaction.deferUpdate(); // Acknowledge the select menu interaction

        const selectedValue = interaction.values[0];
        // Value format: `${event.event_id}_channel_${targetChannel.id}`
        const parts = selectedValue.split('_channel_');
        const eventId = parts[0];
        const targetChannelId = parts[1];


        if (!eventId || !targetChannelId) {
          console.error(`Invalid value from select_event_to_publish: ${selectedValue}`);
          return interaction.editReply({ content: 'There was an error processing your selection. Invalid data received.', components: [], embeds: [] });
        }

        const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel || !targetChannel.isTextBased()) {
          return interaction.editReply({ content: 'The target channel for announcement could not be found or is not a text channel.', components: [], embeds: [] });
        }

        const event = await linkStore.getEventById(eventId); // eventId is already a string
        if (!event) {
            return interaction.editReply({ content: `Error: Event with ID #${eventId} not found.`, components: [], embeds: [] });
        }
        if (event.status === 'published') {
            return interaction.editReply({ content: `Event #${eventId} is already published.`, components: [], embeds: [] });
        }

        const now = Math.floor(Date.now() / 1000);
        // Fetch full event data again to ensure it's most up-to-date for the embed
        let eventToPublish = await linkStore.getEventById(eventId);
        if (!eventToPublish) { // Should not happen if first check passed
             console.error(`Event ${eventId} disappeared before publishing.`);
             return interaction.editReply({ content: `Error: Event with ID #${eventId} could not be re-fetched.`, components: [], embeds: [] });
        }


        await linkStore.updateEventStatus(eventId, 'published', now);
        eventToPublish.status = 'published'; // Update local copy for embed
        eventToPublish.updated_at = now;     // Update local copy for embed

        eventToPublish.custom_fields = await linkStore.getEventCustomFields(eventId);
        eventToPublish.rewards = await linkStore.getEventRewards(eventId);

        // Ensure buildEventEmbed is accessible
        // This assumes commands/events.js will export buildEventEmbed:
        // const { buildEventEmbed } = require('./commands/events.js');
        // If not, this line will fail and buildEventEmbed needs to be moved/exported.
        // For now, to proceed, we'll assume it's made available.
        // A more robust solution is to move buildEventEmbed to a shared util.
        // Let's try to require it directly for now.
        let buildEventEmbedFunction;
        try {
            const eventCmdModule = require('./commands/events.js');
            buildEventEmbedFunction = eventCmdModule.buildEventEmbed;
            if (typeof buildEventEmbedFunction !== 'function') throw new Error('buildEventEmbed not a function');
        } catch (e) {
            console.error("Failed to load buildEventEmbed from commands/events.js:", e);
            return interaction.editReply({ content: 'Internal error: Could not prepare event announcement (embed builder missing).', components: [], embeds: [] });
        }

        // Pass relevant parts of envConfig if buildEventEmbed needs it
        const envConfigForEmbed = { OWNER_ID, ADMIN_ROLES /* add other needed env vars */ };
        const announcementEmbed = buildEventEmbedFunction(eventToPublish, envConfigForEmbed);

        const { ActionRowBuilder, ButtonBuilder } = require('discord.js'); // Already imported at top, but good for clarity

        const rsvpRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId(`rsvp-going-${eventId}`).setLabel('Going').setStyle(3).setEmoji('✅'), // Using an actual number for style
                new ButtonBuilder().setCustomId(`rsvp-interested-${eventId}`).setLabel('Interested').setStyle(1).setEmoji('🤔'),
                new ButtonBuilder().setCustomId(`rsvp-cantgo-${eventId}`).setLabel('Can\'t Go').setStyle(4).setEmoji('❌')
            );

        const announcementMsg = await targetChannel.send({ embeds: [announcementEmbed], components: [rsvpRow] });

        await linkStore.updateEvent(eventId, {
            announcement_message_id: announcementMsg.id,
            announcement_channel_id: targetChannel.id,
            status: 'published', // Ensure status is explicitly set here too
            updated_at: now
        });

        return interaction.editReply({ content: `Event **${event.title}** (ID #${eventId}) has been successfully published to ${targetChannel}.`, components: [], embeds: [] });

      } catch (publishSelectError) {
        console.error(`Error processing select_event_to_publish for event:`, publishSelectError);
        console.warn(`[INDEX_HANDLER] Could not send user-facing error for event publish selection as interaction might be invalid.`);
      }
    }
  }


  // Slash Command Handling (ensure it's only for ChatInputCommands)
  if (!interaction.isChatInputCommand()) return;

  /* ─── Backend bereit? ─────────────────────────────── */
  if (!linkStore) {
    // 3-Sek-Timeout umgehen → direkt antworten
    return interaction.reply({
      content: '⏳ Bot initialisiert noch … bitte gleich noch einmal `/connect` ausführen.',
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
  }

  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  /* ─── simple 3-Sek-Cooldown pro User+Command ───────── */
  const key = `${interaction.user.id}:${cmd.data.name}`;
  if (client.cooldowns.has(key) &&
      Date.now() - client.cooldowns.get(key) < (cmd.cooldown || 3000)) {
    return interaction.reply({ content: '⏳ Cool-down … try again shortly.', flags: MessageFlags.Ephemeral });
  }
  client.cooldowns.set(key, Date.now());

  /* ─── eigentliche Command-Ausführung ──────────────── */
  try {
    await cmd.execute(interaction, linkStore, {
      // Pass all relevant env vars that commands might need
      DISCORD_TOKEN, // Though commands usually don't need this directly
      CLIENT_ID,
      GUILD_ID,
      OWNER_ID,
      VERIFIED_ROLE_ID,
      ADMIN_ROLES,
      UNIVERSE_ID,
      OC_KEY,
      // Include other necessary env vars from the top-level destructuring if commands need them
      // For example, EVENT_ASSET_CHANNEL_ID is used by events.js but not destructured at the top.
      // It's better to pass specific things needed by commands rather than everything.
      // For now, adding OWNER_ID and ensuring ADMIN_ROLES is passed.
      // EVENT_ASSET_CHANNEL_ID is handled by events.js directly from process.env for now.
      // We can refine this envConfig object later if more shared env vars are needed by multiple commands.
      EVENT_ASSET_CHANNEL_ID: process.env.EVENT_ASSET_CHANNEL_ID, // Example of explicitly passing one
    });
  } catch (err) {
    console.error('Cmd error', err);
    const respond = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    const errorEmbed = new EmbedBuilder()
      .setColor(0xE53935) // ERROR_COLOR
      .setTitle('⚠️ Internal Error')
      .setDescription('An unexpected error occurred while processing this command. Please try again later. If the issue persists, contact an administrator.');
    respond({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

//-------------------------------------------------------------------
// 7 · ✅ REACTION VERIFIER
//-------------------------------------------------------------------
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.author?.id !== client.user.id) return;
  const last = reactionCache.get(user.id) || 0;
  if (Date.now() - last < 1000) return;
  reactionCache.set(user.id, Date.now());
  try {
    const row = await linkStore.get(user.id);
    if (!row || row.verified) return;

    const attempts = (row.attempts || 0) + 1;
    const ts = Math.floor(Date.now() / 1000);
    await linkStore.setAttempts?.(user.id, attempts, ts).catch(()=>{});

    const { data: profile } = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
    if (!profile?.description?.includes(row.code))
      return user.send('❌ Code not found – paste into your Roblox bio and react again.');

    await linkStore.verify(user.id);
    await user.send('✅ Linked! You may remove the code.');

    // Determine Verified Role ID (DB config or .env fallback)
    let effectiveVerifiedRoleId = VERIFIED_ROLE_ID; // Fallback to .env
    if (linkStore && typeof linkStore.getRoleConfig === 'function' && GUILD_ID) {
        try {
            const dbRoleConf = await linkStore.getRoleConfig(GUILD_ID, 'VERIFIED_ROLE');
            if (dbRoleConf && dbRoleConf.role_id) {
                effectiveVerifiedRoleId = dbRoleConf.role_id;
                log(`ReactionVerifier: Using VERIFIED_ROLE from DB config: ${effectiveVerifiedRoleId}`);
            } else {
                log(`ReactionVerifier: VERIFIED_ROLE not in DB, using .env fallback: ${effectiveVerifiedRoleId}`);
            }
        } catch (e) {
            warn(`ReactionVerifier: Error fetching VERIFIED_ROLE from DB, using .env fallback. Error: ${e.message}`);
        }
    } else {
        warn('ReactionVerifier: linkStore.getRoleConfig not available or GUILD_ID missing. Using .env for VERIFIED_ROLE_ID.');
    }

    if (effectiveVerifiedRoleId && GUILD_ID) { // Check GUILD_ID again for safety
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(user.id).catch(()=>null);
        if (member) {
            await member.roles.add(effectiveVerifiedRoleId);
            log(`ReactionVerifier: Assigned role ${effectiveVerifiedRoleId} to ${user.id}`);
        } else {
            warn(`ReactionVerifier: Could not fetch member ${user.id} in guild ${GUILD_ID}.`);
        }
      } catch (roleError) {
          console.error(`ReactionVerifier: Failed to assign role ${effectiveVerifiedRoleId} to ${user.id}:`, roleError.message);
      }
    }

    if (UNIVERSE_ID && OC_KEY) {
      try {
        const entryKey = `Player_${row.roblox}`;
        const { data } = await axios.get(
          `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
          { params: { datastoreName: 'MainDataStore', entryKey }, headers: { 'x-api-key': OC_KEY } }
        );
        const js = JSON.parse(data?.data ?? '{}');
        const lvl = js?.PlayerData?.Progress?.Level ?? '?';
        const st  = js?.PlayerData?.Progress?.Statues ?? '?';
        await user.send(`📊 Level **${lvl}** · Statues **${st}/42**`);
      } catch (e) { warn('OpenCloud', e.response?.status); }
    }
  } catch (e) {
    console.error('Verify flow', e);
    user.send('⚠️ Verification failed.');
  }
});

//-------------------------------------------------------------------
// 8 · EXPRESS KEEP‑ALIVE
//-------------------------------------------------------------------
const app = express();
app.get('/',        (_, r) => r.send('OK'));
app.get('/healthz', (_, r) => r.json({ ok: true, ts: Date.now() }));
app.get('/stats',   (_, r) => {
  const m = process.memoryUsage();
  r.json({ rss: m.rss, heap: m.heapUsed, uptime: process.uptime() });
});
app.listen(PORT, () => console.log(`🌐 Express keep‑alive on :${PORT}`));
if (KEEPALIVE_URL) setInterval(() => axios.get(KEEPALIVE_URL).catch(()=>{}), 5*60_000);

//-------------------------------------------------------------------
// 9 · GLOBAL ERROR HANDLERS
//-------------------------------------------------------------------
process.on('unhandledRejection', e => console.error('UnhandledRejection', e));
process.on('uncaughtException' , e => console.error('UncaughtException', e));

//-------------------------------------------------------------------
// 10 · BOOTSTRAP
//-------------------------------------------------------------------
(async () => {
  try {
    // 1) Backend wählen und initialisieren
    const backend = await selectBackend(); // Returns { db, api, dbType } for SQLite, or { db: mongoDbObject, api, dbType: 'mongo'} for Mongo
    linkStore = backend.api; // The API for commands to use

    // 2) Run event migration if needed
    if (fs.existsSync(EVENTS_JSON_PATH)) {
      console.log('[Startup] Found events.json, attempting migration...');
      // For SQLite, backend.db is the sqlite3.Database instance
      // For MongoDB, backend.db is the MongoClient.Db instance
      await migrateEventsJsonToDb(backend.db, backend.dbType);
    } else {
      console.log('[Startup] events.json not found, skipping migration.');
    }

    // 3) Commands von der Disk laden → client.commands wird befüllt
    const cmdList = loadCommands();

    // 3) Nach Discord-Login: Slash-Commands registrieren
    client.once('ready', async () => {
      console.log(`🤖 Logged in as ${client.user.tag}`);
      try {
        await registerCommands(cmdList);
      } catch (e) {
        console.error('🔴 Failed to register commands', e);
      }
    });

    // 4) Discord-Login
    await client.login(DISCORD_TOKEN);
  } catch (fatal) {
    console.error('💀 Fatal startup error – shutting down', fatal);
    process.exit(1);
  }
})();
