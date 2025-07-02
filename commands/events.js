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

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
// Removed fs, path, DB_PATH, loadEvents, saveEvents

const DEBUG = process.env.DEBUG_EVENTS === '1'; // opt‑in verbose logging
// ADMIN_ROLES are now passed via envConfig from index.js, or use interaction.member.permissions
// const ADMIN_ROLES = ['👆🏼 Admin', 'Community Manager', 'Admin']; // This will be removed

function log(...args) {
  if (DEBUG) console.log('[events]', ...args);
}

// Game-specific data (could be moved to a config file later)
const ISLAND_DATA = {
  "Desert": { areas: ["Area 1 (Desert)", "Area 2 (Desert)", "Area 3 (Desert)"], emoji: "🏜️" },
  "Tropical": { areas: ["Area A (Tropics)", "Area B (Tropics)", "Area C (Tropics)", "Area D (Tropics)"], emoji: "🏝️" },
  "Snow": { areas: ["Zone Alpha (Snow)", "Zone Beta (Snow)"], emoji: "❄️" },
  "Volcano": { areas: ["Crater Rim (Volcano)", "Lava Tubes (Volcano)", "Ash Fields (Volcano)"], emoji: "🌋" }
};

/**
 * Parses date and time strings into a Unix timestamp.
 * Example: date = "YYYY-MM-DD", time = "HH:MM" (assumed UTC for simplicity here)
 * @param {string} dateStr (YYYY-MM-DD)
 * @param {string} timeStr (HH:MM)
 * @returns {number} Unix timestamp in seconds
 */
function parseDateTimeToTimestamp(dateStr, timeStr) {
    if (!dateStr || !timeStr) return Math.floor(Date.now() / 1000); // Should be validated before calling
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hours, minutes] = timeStr.split(':').map(Number);
    // Create date as UTC
    const date = new Date(Date.UTC(year, month - 1, day, hours, minutes));
    return Math.floor(date.getTime() / 1000);
}


/* ─────────────────────────────── Permissions ─────────────────────────────── */
// Use envConfig.ADMIN_ROLES passed from index.js
const isEventAdmin = (interaction, adminRolesEnv) => {
  const member = interaction.member;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  const roles = adminRolesEnv ? adminRolesEnv.split(',').map(r => r.trim()) : [];
  return member.roles.cache.some(role => roles.includes(role.name) || roles.includes(role.id));
};

/* ─────────────────────────────── Slash Command ───────────────────────────── */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('events')
    .setDescription('Manage scheduled events for Monkey Simulator V2')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents) // Or Administrator
    .addSubcommand(sc => sc.setName('list').setDescription('List all upcoming (published) events.'))
    .addSubcommand(sc =>
      sc.setName('create')
        .setDescription('Create a new event (starts as draft).')
        .addAttachmentOption(o => o.setName('image_upload').setDescription('Upload an image for the event banner.').setRequired(false))
        // Other details will be collected via a Modal.
    )
    .addSubcommand(sc =>
      sc.setName('publish')
        .setDescription('Publish a draft event and announce it.')
        .addIntegerOption(o => o.setName('event_id').setDescription('The ID of the draft event to publish.').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to announce the event in.').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('view')
        .setDescription('View details of a specific event.')
        .addIntegerOption(o => o.setName('event_id').setDescription('The ID of the event to view.').setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('delete')
        .setDescription('Delete an event.')
        .addIntegerOption(o => o.setName('event_id').setDescription('The ID of the event to delete.').setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('edit')
        .setDescription('Edit an existing event (basic info, location, custom fields).')
        .addIntegerOption(o => o.setName('event_id').setDescription('The ID of the event to edit.').setRequired(true))
        // This will now primarily be a gateway to further actions via buttons/modals
    )
    .addSubcommand(subcommand =>
      subcommand.setName('edit_image')
        .setDescription('[Admin] Change or set the main image for an event.')
        .addIntegerOption(o => o.setName('event_id').setDescription('The ID of the event to update.').setRequired(true))
        .addAttachmentOption(o => o.setName('image_upload').setDescription('Upload a new image for the event.').setRequired(false))
        .addStringOption(o => o.setName('image_url').setDescription('Set a new image URL (or "none" to clear).').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('rsvps')
        .setDescription('[Admin] View RSVPs for an event.')
        .addIntegerOption(o => o.setName('event_id').setDescription('The ID of the event.').setRequired(true))
    ),

  async execute(interaction, linkStore, envConfig) { // Added linkStore and envConfig
    /* Global try/catch to avoid crashes */
    try {
      await interaction.deferReply({ ephemeral: true }); // Defer all replies for consistency

      if (!interaction.inGuild()) {
        const guildOnlyEmbed = new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Guild Only Command').setDescription('This command can only be used inside a server.');
        return interaction.editReply({ embeds: [guildOnlyEmbed] }); // Already deferred
      }

      const sub = interaction.options.getSubcommand();
      log('Subcmd:', sub);

      // Permission check for admin-only commands
      const adminCommands = ['create', 'publish', 'delete', 'edit', 'rsvps']; // Added 'rsvps'
      if (adminCommands.includes(sub) && !isEventAdmin(interaction, envConfig.ADMIN_ROLES)) {
        const noPermsEmbed = new EmbedBuilder().setColor(0xE53935).setTitle('🚫 Permission Denied').setDescription('You do not have the required permissions to use this subcommand.');
        return interaction.editReply({ embeds: [noPermsEmbed] });
      }

      /* ─────────── LIST ─────────── */
      if (sub === 'list') {
        const publishedEvents = await linkStore.getPublishedEvents();
        const listEmbed = new EmbedBuilder().setTitle('📅 Upcoming Published Events').setColor(0x00bcd4).setTimestamp();

        if (!publishedEvents || publishedEvents.length === 0) {
          listEmbed.setDescription('There are currently no scheduled (published) events.');
        } else {
          // Sort events by start_at just in case DB didn't enforce it strictly for all event sources
          publishedEvents.sort((a, b) => a.start_at - b.start_at);
          publishedEvents.forEach(event => {
            listEmbed.addFields({
              name: `#${event.event_id} • ${event.title}`,
              value: `${event.description || 'No description.'}\n**Starts:** <t:${event.start_at}:F> (<t:${event.start_at}:R>)\n**Location:** ${ISLAND_DATA[event.island_name]?.emoji || ''} ${event.island_name || 'N/A'} - ${event.area_name || 'N/A'}`,
            });
          });
           if (listEmbed.data.fields && listEmbed.data.fields.length > 25) {
              listEmbed.spliceFields(24, listEmbed.data.fields.length - 24);
              listEmbed.addFields({ name: '...and more!', value: 'Too many events to list them all here.'});
           }
        }
        return interaction.editReply({ embeds: [listEmbed] });
      }

      /* ─────────── CREATE ─────────── */
      if (sub === 'create') {
        const attachment = interaction.options.getAttachment('image_upload');
        let uploadedImageUrl = null;

        if (attachment) {
          if (!envConfig.EVENT_ASSET_CHANNEL_ID) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Configuration Error').setDescription('Event asset channel is not configured. Cannot process image uploads.')], ephemeral: true });
          }
          if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Invalid File Type').setDescription('Please upload a valid image file (PNG, JPG, GIF).')], ephemeral: true });
          }

          try {
            const assetChannel = await interaction.client.channels.fetch(envConfig.EVENT_ASSET_CHANNEL_ID);
            if (!assetChannel || !assetChannel.isTextBased()) {
              throw new Error('Asset channel not found or not text-based.');
            }
            const sentMessage = await assetChannel.send({ files: [attachment] });
            uploadedImageUrl = sentMessage.attachments.first()?.url;
            if (!uploadedImageUrl) {
              throw new Error('Failed to get URL from uploaded attachment.');
            }
            // Store for modal handler
            interaction.client.pendingEventCreations.set(interaction.user.id, { attachmentUrl: uploadedImageUrl });
            log(`Uploaded event image for ${interaction.user.id}: ${uploadedImageUrl}`);
          } catch (uploadError) {
            console.error('Failed to upload event image to asset channel:', uploadError);
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Image Upload Failed').setDescription('There was an error processing your image upload. Please try providing a URL instead or try again later.')], ephemeral: true });
          }
        }

        // Modal for event creation
        const modal = new ModalBuilder().setCustomId('eventCreateModal').setTitle('Create New Event (Draft)');

        const titleInput = new TextInputBuilder().setCustomId('eventTitle').setLabel("Event Title").setStyle(1).setRequired(true); // Short
        const descriptionInput = new TextInputBuilder().setCustomId('eventDescription').setLabel("Event Description").setStyle(2).setRequired(true); // Long
        const dateInput = new TextInputBuilder().setCustomId('eventDate').setLabel("Start Date (YYYY-MM-DD)").setStyle(1).setRequired(true).setPlaceholder('e.g., 2024-12-31');
        const timeInput = new TextInputBuilder().setCustomId('eventTime').setLabel("Start Time (HH:MM, 24hr format, UTC)").setStyle(1).setRequired(true).setPlaceholder('e.g., 17:30');
        const imageMainUrlInput = new TextInputBuilder().setCustomId('eventImageMainUrl').setLabel("Main Image URL (Optional)").setStyle(1).setRequired(false).setPlaceholder('https://example.com/image.png');

        modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descriptionInput),
          new ActionRowBuilder().addComponents(dateInput),
          new ActionRowBuilder().addComponents(timeInput),
          new ActionRowBuilder().addComponents(imageMainUrlInput)
        );
        await interaction.showModal(modal);
        // Modal submission will be handled by 'interactionCreate' event listener filtering for customId 'eventCreateModal'
        // The deferred reply will be edited by the modal submission handler.
        return; // Do not edit reply here, modal handler will
      }

      /* ─────────── VIEW ─────────── */
      if (sub === 'view') {
        const eventId = interaction.options.getInteger('event_id');
        const event = await linkStore.getEventById(eventId);
        if (!event) {
          const notFoundEmbed = new EmbedBuilder().setColor(0xFFC107).setTitle('🔎 Event Not Found').setDescription(`Event with ID #${eventId} could not be found.`);
          return interaction.editReply({ embeds: [notFoundEmbed] });
        }
        // Fetch and attach custom fields
        event.custom_fields = await linkStore.getEventCustomFields(eventId);

        const viewEmbed = buildEventEmbed(event, envConfig);
        return interaction.editReply({ embeds: [viewEmbed], ephemeral: event.status === 'draft' }); // Ephemeral if draft
      }

      /* ─────────── PUBLISH (was ANNOUNCE) ─────────── */
      if (sub === 'publish') {
        const eventId = interaction.options.getInteger('event_id');
        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

        const event = await linkStore.getEventById(eventId);
        if (!event) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`Event with ID #${eventId} not found.`)] });
        }
        if (event.status === 'published') {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Already Published').setDescription(`Event #${eventId} is already published.`)] });
        }

        const now = Math.floor(Date.now() / 1000);

        // Fetch event data again to ensure it's fresh before building embed, or merge if updateEventStatus doesn't return it
        let eventToPublish = await linkStore.getEventById(eventId); // Get latest data including any prior edits
        if (!eventToPublish) { /* Should not happen if previous checks passed */ }

        await linkStore.updateEventStatus(eventId, 'published', now);
        eventToPublish.status = 'published'; // Reflect status change for embed
        eventToPublish.updated_at = now;

        // Fetch and attach custom fields for the announcement
        eventToPublish.custom_fields = await linkStore.getEventCustomFields(eventId);

        const announcementEmbed = buildEventEmbed(eventToPublish, envConfig);

        const rsvpRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`rsvp-going-${eventId}`)
                    .setLabel('Going')
                    .setStyle(3) // Green - Success
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId(`rsvp-interested-${eventId}`)
                    .setLabel('Interested')
                    .setStyle(1) // Blue - Primary
                    .setEmoji('🤔'),
                new ButtonBuilder()
                    .setCustomId(`rsvp-cantgo-${eventId}`)
                    .setLabel('Can\'t Go')
                    .setStyle(4) // Red - Danger
                    .setEmoji('❌')
            );

        const announcementMsg = await targetChannel.send({ embeds: [announcementEmbed], components: [rsvpRow] });

        // Store message ID for future updates (e.g., RSVP counts)
        // Also ensure the event object used for the embed has the latest status
        await linkStore.updateEvent(eventId, {
            announcement_message_id: announcementMsg.id,
            announcement_channel_id: targetChannel.id,
            status: 'published', // Ensure status is set here if updateEventStatus doesn't return the object
            updated_at: now
        });

        const successEmbed = new EmbedBuilder().setColor(0x4CAF50).setTitle('📢 Event Published').setDescription(`Event **${event.title}** (ID #${eventId}) has been successfully published to ${targetChannel}.`);
        return interaction.editReply({ embeds: [successEmbed] });
      }

      /* ─────────── DELETE ─────────── */
      if (sub === 'delete') {
        const eventId = interaction.options.getInteger('event_id');
        const eventToDelete = await linkStore.getEventById(eventId);
        if (!eventToDelete) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`Event with ID #${eventId} not found.`)] });
        }
        await linkStore.deleteEvent(eventId);
        // TODO: Optionally delete announcement message if it exists and is managed by bot
        const deletedEmbed = new EmbedBuilder().setColor(0x4CAF50).setTitle('🗑️ Event Deleted').setDescription(`Event **${eventToDelete.title}** (ID #${eventId}) has been successfully deleted.`);
        return interaction.editReply({ embeds: [deletedEmbed] });
      }

      /* ─────────── EDIT ─────────── */
      if (sub === 'edit') {
        // For Phase 1, editing will be simplified. A full modal approach is better for Phase 2.
        // This will require specific sub-options for each field or a modal.
        // For now, let's make it a placeholder or very basic.
        // Example: /events edit event_id:X field:title value:NewTitle
        // This is complex with slash commands for many fields. A modal is the way.
        // For now, just acknowledge and state it's under development for full features.
         const eventId = interaction.options.getInteger('event_id');
         const eventToEdit = await linkStore.getEventById(eventId);
         if (!eventToEdit) {
             return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`Event with ID #${eventId} not found.`)] });
         }

        // For now, the main /events edit command will show current details and offer buttons to edit parts.
        // One of those buttons will be "Manage Custom Fields".
        const currentEventEmbed = buildEventEmbed(eventToEdit, envConfig);
        const editActionRow = new ActionRowBuilder()
            .addComponents(
                // Button to trigger a modal for basic info (title, desc, date, time) - Future Step
                // new ButtonBuilder().setCustomId(`edit-event-basic-${eventId}`).setLabel('Edit Basic Info').setStyle(1),
                new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Manage Custom Fields').setStyle(2), // Secondary
                new ButtonBuilder().setCustomId(`edit-event-image-${eventId}`).setLabel('Change Image').setStyle(2) // Secondary (links to /events edit_image or similar modal)
            );

        currentEventEmbed.setTitle(`✏️ Editing Event: ${eventToEdit.title} (ID #${eventId})`);
        currentEventEmbed.setDescription(`${eventToEdit.description}\n\nSelect an action below to modify the event.`);

        return interaction.editReply({ embeds: [currentEventEmbed], components: [editActionRow], ephemeral: true });
      }

      /* ─────────── EDIT IMAGE ─────────── */
      if (sub === 'edit_image') {
        const eventId = interaction.options.getInteger('event_id');
        const attachment = interaction.options.getAttachment('image_upload');
        let imageUrl = interaction.options.getString('image_url'); // Can be null or "none"

        if (!attachment && !imageUrl) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Missing Input').setDescription('Please provide either an image upload or an image URL.')], ephemeral: true });
        }

        const eventToEdit = await linkStore.getEventById(eventId);
        if (!eventToEdit) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`Event with ID #${eventId} not found.`)] });
        }

        let finalImageUrl = eventToEdit.image_main_url; // Default to existing

        if (attachment) {
            if (!envConfig.EVENT_ASSET_CHANNEL_ID) {
              return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Configuration Error').setDescription('Event asset channel is not configured for uploads.')], ephemeral: true });
            }
            if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
              return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Invalid File Type').setDescription('Please upload a valid image file.')], ephemeral: true });
            }
            try {
              const assetChannel = await interaction.client.channels.fetch(envConfig.EVENT_ASSET_CHANNEL_ID);
              const sentMessage = await assetChannel.send({ files: [attachment] });
              finalImageUrl = sentMessage.attachments.first()?.url;
              if (!finalImageUrl) throw new Error('Failed to get URL from uploaded attachment.');
            } catch (uploadError) {
              console.error('Failed to upload event image for edit:', uploadError);
              return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Image Upload Failed').setDescription('Error processing image upload.')], ephemeral: true });
            }
        } else if (imageUrl) {
            if (imageUrl.toLowerCase() === 'none' || imageUrl.toLowerCase() === 'clear') {
                finalImageUrl = null;
            } else if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
                 return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Invalid URL').setDescription('Please provide a valid HTTP/HTTPS URL or "none" to clear the image.')], ephemeral: true });
            } else {
                finalImageUrl = imageUrl;
            }
        }

        await linkStore.updateEvent(eventId, { image_main_url: finalImageUrl });
        const successEmbed = new EmbedBuilder()
            .setColor(0x4CAF50)
            .setTitle('🖼️ Event Image Updated')
            .setDescription(`The main image for event **${eventToEdit.title}** (ID #${eventId}) has been updated.`)
            .setImage(finalImageUrl) // Show the new image if one is set
            .setTimestamp();
        return interaction.editReply({ embeds: [successEmbed] });
      }

      /* ─────────── RSVPS (Admin View) ─────────── */
      if (sub === 'rsvps') {
        const eventId = interaction.options.getInteger('event_id');
        const event = await linkStore.getEventById(eventId);

        if (!event) {
          return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('🔎 Event Not Found').setDescription(`Event with ID #${eventId} could not be found.`)] });
        }

        const rsvpsGoing = await linkStore.getRsvpsForEvent(eventId, 'going');
        const rsvpsInterested = await linkStore.getRsvpsForEvent(eventId, 'interested');
        // const rsvpsWaitlisted = await linkStore.getRsvpsForEvent(eventId, 'waitlisted'); // For future

        const rsvpEmbed = new EmbedBuilder()
            .setColor(0x00BCD4) // INFO_COLOR
            .setTitle(`🎟️ RSVPs for Event: ${event.title} (ID #${eventId})`)
            .setTimestamp();

        const formatRsvpList = (list) => {
            if (!list || list.length === 0) return 'None';
            return list.map(r => `<@${r.user_discord_id}> (<t:${r.rsvp_at}:R>)`).join('\n');
        };

        rsvpEmbed.addFields(
            { name: `✅ Going (${rsvpsGoing.length}/${event.capacity > 0 ? event.capacity : '∞'})`, value: formatRsvpList(rsvpsGoing).substring(0, 1024), inline: false },
            { name: `🤔 Interested (${rsvpsInterested.length})`, value: formatRsvpList(rsvpsInterested).substring(0, 1024), inline: false }
            // { name: `⏳ Waitlisted (${rsvpsWaitlisted.length})`, value: formatRsvpList(rsvpsWaitlisted).substring(0,1024), inline: false }
        );

        return interaction.editReply({ embeds: [rsvpEmbed] });
      }

    } catch (err) {
      console.error('💥 Error in /events command:', err);
      try {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE53935) // ERROR_COLOR
          .setTitle('⚠️ Internal Error')
          .setDescription('An unexpected error occurred while processing the command. Please try again later or contact an administrator.');
        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      } catch {
        /* ignore secondary failures */
      }
    }
  },
};

/* ─────────────────────────────── Helper Embeds ───────────────────────────── */
// Updated to use new event structure from database
function buildEventEmbed(event, envConfig) { // envConfig might be useful for global settings/URLs later
  const embed = new EmbedBuilder()
    .setColor(event.status === 'draft' ? 0xFFC107 : 0x009688) // Amber for draft, Teal for published/other
    .setTitle(`${ISLAND_DATA[event.island_name]?.emoji || '📍'} Event #${event.event_id} – ${event.title}`)
    .setDescription(event.description || 'No description provided.');

  if (event.image_main_url) {
    embed.setImage(event.image_main_url);
  }

  embed.addFields(
    { name: 'Starts At', value: `<t:${event.start_at}:F> (<t:${event.start_at}:R>)`, inline: true },
    { name: 'Location', value: `${event.island_name || 'N/A'} – ${event.area_name || 'N/A'}`, inline: true },
    { name: 'Status', value: event.status.charAt(0).toUpperCase() + event.status.slice(1), inline: true }
  );

  if (event.capacity > 0) {
    embed.addFields({ name: 'Capacity', value: `${event.rsvp_count_going || 0}/${event.capacity}`, inline: true });
  } else {
    embed.addFields({ name: 'Capacity', value: 'Unlimited', inline: true });
  }

  // Custom Fields display
  if (event.custom_fields && event.custom_fields.length > 0) {
    embed.addFields({ name: '\u200B', value: '**Additional Details:**' }); // Separator
    event.custom_fields.forEach(cf => {
      embed.addFields({ name: cf.field_name, value: cf.field_value, inline: true });
    });
  }

  embed.setFooter({ text: `Created by: ${event.creator_discord_id} • Last updated: <t:${event.updated_at}:R>` })
       .setTimestamp(event.created_at * 1000); // Timestamp of original creation

  return embed;
}
