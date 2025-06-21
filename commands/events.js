// ╔══════════════════════════════════════════════════════════════════════╗
// ║  EVENTS COMMAND – Advanced Event Manager v3                          ║
// ║  Monkey Simulator Discord Bot                                        ║
// ║                                                                      ║
// ║  • /events list                            – list upcoming events    ║
// ║  • /events create <args...>                – create new event        ║
// ║  • /events delete <id>                     – delete event by id      ║
// ║  • /events edit <id> <field> <value>       – quick edit              ║
// ║  • /events announce <id>                   – announce existing event ║
// ║                                                                      ║
// ║  Dependencies: discord.js v14+, node >= 18                           ║
// ║                                                                      ║
// ║  © StillBrokeStudios 2025 · Author: @davdxpx                          ║
// ╚══════════════════════════════════════════════════════════════════════╝

'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.resolve('./events.json');
const DEBUG   = process.env.DEBUG_EVENTS === '1';               // opt‑in verbose logging
const ADMIN_ROLES = ['👆🏼 Admin', 'Community Manager', 'Admin'];

function log(...args) {
  if (DEBUG) console.log('[events]', ...args);
}

/* ─────────────────────────────── JSON Helpers ─────────────────────────────── */
const loadEvents = () => {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    console.error('✖ Failed to load events.json:', err);
    return [];
  }
};

const saveEvents = (arr) => {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(arr, null, 2));
    log('💾 Saved events →', arr.length);
  } catch (err) {
    console.error('✖ Failed to save events.json:', err);
  }
};

/* ─────────────────────────────── Permissions ─────────────────────────────── */
const isEventAdmin = (member) =>
  member.permissions.has(PermissionFlagsBits.Administrator) ||
  member.roles.cache.some((r) => ADMIN_ROLES.includes(r.name));

/* ─────────────────────────────── Slash Command ───────────────────────────── */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('events')
    .setDescription('Manage scheduled events for Monkey Simulator')
    .addSubcommand((sc) => sc.setName('list').setDescription('List all upcoming events'))
    .addSubcommand((sc) =>
      sc
        .setName('create')
        .setDescription('Create a new event')
        .addStringOption((o) =>
          o.setName('title').setDescription('Event title').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('date').setDescription('Date (YYYY-MM-DD)').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('desc').setDescription('Short description').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('time').setDescription('Start time (e.g. 18:00 UTC)'),
        )
        .addStringOption((o) => o.setName('world').setDescription('Game world / island'))
        .addStringOption((o) => o.setName('area').setDescription('Specific area / zone'))
        .addStringOption((o) => o.setName('reward').setDescription('Reward overview'))
        .addRoleOption((o) =>
          o.setName('pingrole').setDescription('Role to ping upon creation'),
        )
        .addIntegerOption((o) =>
          o.setName('capacity').setDescription('Max participants (0 = unlimited)'),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('delete')
        .setDescription('Delete an event by its ID')
        .addIntegerOption((o) =>
          o.setName('id').setDescription('ID from /events list').setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('edit')
        .setDescription('Edit a single field of an event')
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Event ID').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('field')
            .setDescription(
              'Field to edit (title, date, time, desc, world, area, reward, capacity)',
            )
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('value').setDescription('New value').setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('announce')
        .setDescription('Announce an existing event in this channel')
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Event ID').setRequired(true),
        ),
    ),

  async execute(interaction) {
    /* Global try/catch to avoid crashes */
    try {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: '⚠️ This command is only available in servers.',
          ephemeral: true,
        });
      }

      const sub = interaction.options.getSubcommand();
      const events = loadEvents();
      log('Subcmd:', sub);

      /* ─────────── LIST ─────────── */
      if (sub === 'list') {
        const embed = new EmbedBuilder()
          .setTitle('📅 Upcoming Events')
          .setColor(0x00bcd4)
          .setTimestamp();

        if (!events.length) {
          embed.setDescription('There are currently **no scheduled events**.');
        } else {
          events.forEach((ev, i) => {
            embed.addFields({
              name: `#${i} • ${ev.title}  (${ev.date}${ev.time ? ' ' + ev.time : ''})`,
              value: `${ev.desc}
🏝️ **World:** ${ev.world || '—'} | 🌄 **Area:** ${ev.area || '—'} | 🎁 **Reward:** ${
                ev.reward || '—'
              } | 👥 **Cap:** ${ev.capacity || '∞'}`,
            });
          });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      /* ────────── Permission Check for mutating ops ────────── */
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isEventAdmin(member)) {
        return interaction.reply({
          content: '🚫 You need the **Event‑Admin** role to do that.',
          ephemeral: true,
        });
      }

      /* ─────────── CREATE ─────────── */
      if (sub === 'create') {
        const newEv = {
          title: interaction.options.getString('title'),
          date: interaction.options.getString('date'),
          time: interaction.options.getString('time') || '',
          desc: interaction.options.getString('desc'),
          world: interaction.options.getString('world') || '',
          area: interaction.options.getString('area') || '',
          reward: interaction.options.getString('reward') || '',
          ping: interaction.options.getRole('pingrole')?.id || '',
          capacity: interaction.options.getInteger('capacity') || 0,
          createdBy: interaction.user.id,
          createdAt: Date.now(),
        };

        events.push(newEv);
        saveEvents(events);
        log('Created event', newEv);

        /* Optional announce immediately */
        if (newEv.ping) {
          const pingRole = interaction.guild.roles.cache.get(newEv.ping);
          const announceEmbed = buildEventEmbed(newEv, events.length - 1);
          interaction.channel.send({
            content: pingRole ? `<@&${pingRole.id}>` : null,
            embeds: [announceEmbed],
          });
        }

        return interaction.reply({
          content: `🎉 Event **${newEv.title}** added (#${events.length - 1}).`,
          ephemeral: true,
        });
      }

      /* ─────────── DELETE ─────────── */
      if (sub === 'delete') {
        const id = interaction.options.getInteger('id');
        if (id < 0 || id >= events.length) {
          return interaction.reply({ content: '❌ Invalid ID.', ephemeral: true });
        }
        const [removed] = events.splice(id, 1);
        saveEvents(events);
        log('Deleted event', removed);
        return interaction.reply({
          content: `🗑️ Event **${removed.title}** deleted.`,
          ephemeral: true,
        });
      }

      /* ─────────── EDIT ─────────── */
      if (sub === 'edit') {
        const id = interaction.options.getInteger('id');
        const field = interaction.options.getString('field');
        const value = interaction.options.getString('value');

        if (id < 0 || id >= events.length) {
          return interaction.reply({ content: '❌ Invalid ID.', ephemeral: true });
        }
        const target = events[id];

        const editable = [
          'title',
          'date',
          'time',
          'desc',
          'world',
          'area',
          'reward',
          'capacity',
        ];
        if (!editable.includes(field))
          return interaction.reply({
            content: `❌ Editable fields: ${editable.join(', ')}`,
            ephemeral: true,
          });

        if (field === 'capacity') {
          const capNum = parseInt(value, 10);
          if (Number.isNaN(capNum) || capNum < 0)
            return interaction.reply({
              content: '❌ Capacity must be a positive integer.',
              ephemeral: true,
            });
          target.capacity = capNum;
        } else {
          target[field] = value;
        }

        saveEvents(events);
        log('Edited event', id, field, '→', value);
        return interaction.reply({
          content: `✏️ Event **${target.title}** updated (${field}).`,
          ephemeral: true,
        });
      }

      /* ─────────── ANNOUNCE ─────────── */
      if (sub === 'announce') {
        const id = interaction.options.getInteger('id');
        if (id < 0 || id >= events.length) {
          return interaction.reply({ content: '❌ Invalid ID.', ephemeral: true });
        }
        const ev = events[id];
        const embed = buildEventEmbed(ev, id);
        await interaction.channel.send({ embeds: [embed] });
        log('Announced event', id);
        return interaction.reply({ content: '📢 Event announced!', ephemeral: true });
      }
    } catch (err) {
      console.error('💥 Error in /events command:', err);
      try {
        return interaction.reply({
          content: '⚠️ Internal error occurred while processing the command.',
          ephemeral: true,
        });
      } catch {
        /* ignore secondary failures */
      }
    }
  },
};

/* ─────────────────────────────── Helper Embeds ───────────────────────────── */
function buildEventEmbed(ev, id) {
  return new EmbedBuilder()
    .setColor(0x009688)
    .setTitle(`📌 Event #${id} – ${ev.title}`)
    .setDescription(ev.desc)
    .addFields(
      { name: 'Date', value: `${ev.date}${ev.time ? ' ' + ev.time : ''}`, inline: true },
      { name: 'World', value: ev.world || '—', inline: true },
      { name: 'Area', value: ev.area || '—', inline: true },
      { name: 'Reward', value: ev.reward || '—', inline: true },
      { name: 'Capacity', value: ev.capacity ? ev.capacity.toString() : '∞', inline: true },
    )
    .setTimestamp();
}
