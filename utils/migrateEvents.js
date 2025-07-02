const fs = require('node:fs');
const path = require('node:path');

const EVENTS_JSON_PATH = path.resolve('./events.json');

/**
 * Migrates events from events.json to the database.
 * This function needs a direct db connection object (e.g., from sqlite3.Database or a MongoDB collection object).
 * It's simplified here; in a real scenario, you'd pass the active `linkStore` or a dedicated DB service.
 * @param {object} db - The SQLite database object or an object with methods to interact with MongoDB collections.
 * @param {string} dbType - 'sqlite' or 'mongo'
 */
async function migrateEventsJsonToDb(db, dbType = 'sqlite') {
  if (!fs.existsSync(EVENTS_JSON_PATH)) {
    console.log('[MigrateEvents] events.json not found, no migration needed.');
    return { migrated: 0, skipped: 0, errors: 0 };
  }

  let oldEvents;
  try {
    oldEvents = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, 'utf8'));
  } catch (err) {
    console.error('[MigrateEvents] Error reading or parsing events.json:', err);
    return { migrated: 0, skipped: 0, errors: 1 };
  }

  if (!Array.isArray(oldEvents) || oldEvents.length === 0) {
    console.log('[MigrateEvents] No events found in events.json or invalid format.');
    // Optionally, rename or delete events.json after processing
    // fs.renameSync(EVENTS_JSON_PATH, EVENTS_JSON_PATH + '.migrated');
    return { migrated: 0, skipped: 0, errors: 0 };
  }

  console.log(`[MigrateEvents] Found ${oldEvents.length} events in events.json to migrate.`);
  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const now = Math.floor(Date.now() / 1000);

  for (const oldEvent of oldEvents) {
    try {
      // Basic data transformation
      const newEvent = {
        title: oldEvent.title,
        description: oldEvent.desc,
        creator_discord_id: oldEvent.createdBy || 'UNKNOWN_MIGRATED', // Assuming createdBy is discord ID
        status: 'published', // Assume old events were published
        created_at: oldEvent.createdAt ? Math.floor(oldEvent.createdAt / 1000) : now,
        updated_at: now,
        start_at: parseEventDate(oldEvent.date, oldEvent.time), // Helper to parse date/time string
        end_at: null, // No end date in old format
        island_name: oldEvent.world || null,
        area_name: oldEvent.area || null,
        image_main_url: oldEvent.image || null, // Assuming an 'image' field might exist
        capacity: parseInt(oldEvent.capacity, 10) || 0,
        rsvp_count_going: 0, // Cannot determine from old format
        rsvp_count_interested: 0, // Cannot determine from old format
        announcement_message_id: null, // Cannot determine
        announcement_channel_id: null, // Cannot determine
        is_recurring: 0,
        recurrence_rule: null,
        template_name: null,
      };

      if (dbType === 'sqlite') {
        const stmt = db.prepare(`INSERT INTO events (
          title, description, creator_discord_id, status, created_at, updated_at, start_at, end_at,
          island_name, area_name, image_main_url, capacity, rsvp_count_going, rsvp_count_interested,
          announcement_message_id, announcement_channel_id, is_recurring, recurrence_rule, template_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        await new Promise((resolve, reject) => {
          stmt.run(
            newEvent.title, newEvent.description, newEvent.creator_discord_id, newEvent.status,
            newEvent.created_at, newEvent.updated_at, newEvent.start_at, newEvent.end_at,
            newEvent.island_name, newEvent.area_name, newEvent.image_main_url, newEvent.capacity,
            newEvent.rsvp_count_going, newEvent.rsvp_count_interested, newEvent.announcement_message_id,
            newEvent.announcement_channel_id, newEvent.is_recurring, newEvent.recurrence_rule, newEvent.template_name,
            (err) => {
              if (err) reject(err); else resolve();
            }
          );
          stmt.finalize();
        });
      } else if (dbType === 'mongo') {
        // Assumes `db` is the MongoDB `Db` object, and we get the collection
        await db.collection('events').insertOne(newEvent);
      }
      migratedCount++;
    } catch (err) {
      console.error(`[MigrateEvents] Error migrating event "${oldEvent.title}":`, err);
      errorCount++;
    }
  }

  if (errorCount === 0 && migratedCount > 0) {
    console.log('[MigrateEvents] Successfully migrated all events. Renaming events.json to events.json.migrated');
    try {
      fs.renameSync(EVENTS_JSON_PATH, EVENTS_JSON_PATH + '.migrated');
    } catch (renameError) {
      console.error('[MigrateEvents] Could not rename events.json:', renameError);
    }
  } else if (errorCount > 0) {
     console.warn(`[MigrateEvents] Migration completed with ${errorCount} errors. Please check events.json manually.`);
  }


  console.log(`[MigrateEvents] Migration complete. Migrated: ${migratedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
  return { migrated: migratedCount, skipped: skippedCount, errors: errorCount };
}

/**
 * Parses date and time strings into a Unix timestamp.
 * Example: date = "YYYY-MM-DD", time = "HH:MM UTC" or "HH:MM"
 * Assumes time is UTC if specified, otherwise local to the bot's server.
 * This is a simplified parser. Robust parsing might need a library like date-fns or moment.
 * @param {string} dateStr
 * @param {string} timeStr
 * @returns {number} Unix timestamp in seconds
 */
function parseEventDate(dateStr, timeStr) {
  if (!dateStr) return Math.floor(Date.now() / 1000); // Default to now if no date

  let date;
  if (timeStr) {
    const timeParts = timeStr.replace(/UTC/i, '').trim().split(':');
    const hours = parseInt(timeParts[0], 10) || 0;
    const minutes = parseInt(timeParts[1], 10) || 0;

    // If time includes UTC, parse as UTC. Otherwise, it's local.
    if (timeStr.toLowerCase().includes('utc')) {
      date = new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`);
    } else {
      // This creates date in local timezone of server
      const [year, month, day] = dateStr.split('-').map(Number);
      date = new Date(year, month - 1, day, hours, minutes);
    }
  } else {
    // If no time, assume start of day in local timezone
    const [year, month, day] = dateStr.split('-').map(Number);
    date = new Date(year, month - 1, day);
  }
  return Math.floor(date.getTime() / 1000);
}

module.exports = { migrateEventsJsonToDb, EVENTS_JSON_PATH };
