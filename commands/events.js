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

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
// Removed fs, path, DB_PATH, loadEvents, saveEvents

const DEBUG = process.env.DEBUG_EVENTS === '1'; // opt‑in verbose logging
// ADMIN_ROLES are now passed via envConfig from index.js, or use interaction.member.permissions
// const ADMIN_ROLES = ['👆🏼 Admin', 'Community Manager', 'Admin']; // This will be removed
const { isBotOwner, isBotAdmin } = require('../utils/permissions'); // Import new permission checkers

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
// Use envConfig.ADMIN_ROLES and envConfig.OWNER_ID passed from index.js
const isEventAdmin = (interaction, envConfig) => {
  if (!interaction.member) return false; // Should not happen in guild commands but good check
  // Check if Bot Owner or Bot Admin (which includes Owner check)
  return isBotAdmin(interaction.member, envConfig.ADMIN_ROLES, envConfig.OWNER_ID);
  // The isBotAdmin function already checks for Owner status.
  // If you also want to allow Discord Server Admins (PermissionFlagsBits.Administrator) regardless of roles/owner:
  // return interaction.member.permissions.has(PermissionFlagsBits.Administrator) || isBotAdmin(interaction.member, envConfig.ADMIN_ROLES, envConfig.OWNER_ID);
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
        .addStringOption(o => o.setName('use_template').setDescription('Name of an event template to use for pre-filling details.').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('publish')
        .setDescription('Publish a draft event and announce it.')
        .addStringOption(o => o.setName('event_id').setDescription('The ID (6-char alphanumeric) of the draft event to publish.').setRequired(true).setMinLength(6).setMaxLength(6))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to announce the event in.').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('view')
        .setDescription('View details of a specific event.')
        .addStringOption(o => o.setName('event_id').setDescription('The ID (6-char alphanumeric) of the event to view.').setRequired(true).setMinLength(6).setMaxLength(6))
    )
    .addSubcommand(sc =>
      sc.setName('delete')
        .setDescription('Delete an event.')
        .addStringOption(o => o.setName('event_id').setDescription('The ID (6-char alphanumeric) of the event to delete.').setRequired(true).setMinLength(6).setMaxLength(6))
    )
    .addSubcommand(sc =>
      sc.setName('edit')
        .setDescription('Edit an existing event (basic info, location, custom fields).')
        .addStringOption(o => o.setName('event_id').setDescription('The ID (6-char alphanumeric) of the event to edit.').setRequired(true).setMinLength(6).setMaxLength(6))
        // This will now primarily be a gateway to further actions via buttons/modals
    )
    .addSubcommand(subcommand =>
      subcommand.setName('edit_image')
        .setDescription('[Admin] Change or set the main image for an event.')
        .addStringOption(o => o.setName('event_id').setDescription('The ID (6-char alphanumeric) of the event to update.').setRequired(true).setMinLength(6).setMaxLength(6))
        .addAttachmentOption(o => o.setName('image_upload').setDescription('Upload a new image for the event.').setRequired(false))
        .addStringOption(o => o.setName('image_url').setDescription('Set a new image URL (or "none" to clear).').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('rsvps')
        .setDescription('[Admin] View RSVPs for an event.')
        .addStringOption(o => o.setName('event_id').setDescription('The ID (6-char alphanumeric) of the event.').setRequired(true).setMinLength(6).setMaxLength(6))
    )
    .addSubcommandGroup(group =>
      group.setName('template')
        .setDescription('[Admin] Manage event templates.')
        .addSubcommand(sub =>
          sub.setName('create')
            .setDescription('Create a new event template.')
            .addStringOption(o => o.setName('name').setDescription('Unique name for this template.').setRequired(true))
            .addStringOption(o => o.setName('from_event_id').setDescription('Optional: Event ID (6-char alphanumeric) to base this template on.').setRequired(false).setMinLength(6).setMaxLength(6))
            // Potentially add more direct options if not basing on from_event_id, or use a modal
        )
        .addSubcommand(sub => sub.setName('list').setDescription('List all available event templates.'))
        .addSubcommand(sub =>
          sub.setName('view')
            .setDescription('View a specific event template.')
            .addStringOption(o => o.setName('name').setDescription('Name of the template to view.').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('delete')
            .setDescription('Delete an event template.')
            .addStringOption(o => o.setName('name').setDescription('Name of the template to delete.').setRequired(true))
        )
    ),

  async execute(interaction, linkStore, envConfig) { // Added linkStore and envConfig
    console.log(`[EVENTS_COMMAND_HANDLER] Executing /events for interaction ID: ${interaction.id} at ${new Date().toISOString()}`);
    /* Global try/catch to avoid crashes */
    try {
      // Global deferReply removed. Each subcommand will handle its own deferral/reply.

      if (!interaction.inGuild()) {
        // Since global defer is removed, this needs to reply directly.
        const guildOnlyEmbed = new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Guild Only Command').setDescription('This command can only be used inside a server.');
        try {
            // Attempt to reply. If this is part of a flow that already replied/deferred, it might fail.
            // However, this check is very early, so direct reply should be fine.
            return await interaction.reply({ embeds: [guildOnlyEmbed], flags: MessageFlags.Ephemeral });
        } catch (e) {
            console.error("Failed to send guildOnlyEmbed reply:", e);
            // If reply fails, maybe it was already handled? Log and potentially followUp.
            try {
                return await interaction.followUp({ embeds: [guildOnlyEmbed], flags: MessageFlags.Ephemeral });
            } catch (fe) {
                console.error("Failed to send guildOnlyEmbed followUp:", fe);
                return; // Give up if followUp also fails
            }
        }
      }

      const sub = interaction.options.getSubcommand();
      const group = interaction.options.getSubcommandGroup(false); // false means it's optional
      log('Group:', group, 'Subcmd:', sub);

      // Permission check for admin-only commands
      // Template commands are also admin only.
      const adminSubcommands = ['create', 'publish', 'delete', 'edit', 'rsvps', 'edit_image']; // Added edit_image
      const adminGroups = ['template'];

      if ((adminSubcommands.includes(sub) && !group) || (group && adminGroups.includes(group))) {
          if (!isEventAdmin(interaction, envConfig)) { // Pass the whole envConfig
            const noPermsEmbed = new EmbedBuilder().setColor(0xE53935).setTitle('🚫 Permission Denied').setDescription('You do not have the required permissions to use this command/subcommand.');
            // Since global defer is removed, this needs to reply or defer then edit.
            // Given this is a direct response to a command, a direct reply is appropriate.
            return await interaction.reply({ embeds: [noPermsEmbed], flags: MessageFlags.Ephemeral });
          }
      }


      if (group === 'template') {
        // Handle template subcommands
        // All template subcommands will need deferral if they don't immediately reply.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (sub === 'create') {
            const templateName = interaction.options.getString('name');
            const fromEventId = interaction.options.getString('from_event_id'); // Changed to getString

            let eventDataForTemplate = {};

            if (fromEventId) {
                const sourceEvent = await linkStore.getEventById(fromEventId);
                if (!sourceEvent) {
                    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Source Event Not Found').setDescription(`Event with ID #${fromEventId} not found to create template from.`)] });
                }
                // Select fields to include in template
                eventDataForTemplate = {
                    title: sourceEvent.title,
                    description: sourceEvent.description,
                    island_name: sourceEvent.island_name,
                    area_name: sourceEvent.area_name,
                    image_main_url: sourceEvent.image_main_url,
                    capacity: sourceEvent.capacity,
                    // We might want to also template custom fields and rewards
                    // custom_fields: await linkStore.getEventCustomFields(fromEventId),
                    // rewards: await linkStore.getEventRewards(fromEventId),
                };
            } else {
                // If not from_event_id, admin needs to provide details.
                // For now, we'll require from_event_id or make a very basic template.
                // Or, this could trigger a modal to input template details.
                // For this phase, let's assume if no from_event_id, it's a minimal template or error.
                 return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('🚧 Under Development').setDescription('Creating templates without basing them on an existing event ID is not yet fully supported. Please provide a `from_event_id` for now.')] });
            }

            try {
                await linkStore.createEventTemplate(templateName, interaction.user.id, JSON.stringify(eventDataForTemplate));
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x4CAF50).setTitle('✅ Template Created').setDescription(`Event template "**${templateName}**" created successfully.`)] });
            } catch (e) {
                if (e.message.includes('UNIQUE constraint failed')) { // SQLite specific
                    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`A template with the name "**${templateName}**" already exists.`)] });
                }
                console.error("Error creating template:", e);
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription('Could not create the event template.')] });
            }
        } else if (sub === 'list') {
            const templates = await linkStore.getAllEventTemplates();
            const listEmbed = new EmbedBuilder().setColor(0x00BCD4).setTitle('📋 Event Templates');
            if (!templates || templates.length === 0) {
                listEmbed.setDescription('No event templates found.');
            } else {
                listEmbed.setDescription('Here are the available event templates:');
                templates.forEach(t => {
                    listEmbed.addFields({ name: t.template_name, value: `ID: ${t.template_id}\nCreated by: <@${t.creator_discord_id}> on <t:${t.created_at}:D>` });
                });
            }
            return interaction.editReply({ embeds: [listEmbed] });
        } else if (sub === 'view') {
            const templateName = interaction.options.getString('name');
            const template = await linkStore.getEventTemplateByName(templateName);
            if (!template) {
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('🔎 Template Not Found').setDescription(`Template "**${templateName}**" not found.`)]});
            }
            const templateData = JSON.parse(template.event_data); // Assuming event_data is JSON string
            const viewEmbed = new EmbedBuilder()
                .setColor(0x00BCD4)
                .setTitle(`📜 Template: ${template.template_name}`)
                .setDescription(templateData.description || '_No description_')
                .addFields(
                    { name: 'Title Prefix (Example)', value: templateData.title || '_Not set_', inline: true },
                    { name: 'Island', value: templateData.island_name || '_Not set_', inline: true },
                    { name: 'Area', value: templateData.area_name || '_Not set_', inline: true },
                    { name: 'Capacity', value: String(templateData.capacity || 0), inline: true },
                    { name: 'Image URL', value: templateData.image_main_url || '_Not set_', inline: false },
                    // Consider showing templated custom fields/rewards here too
                )
                .setFooter({ text: `Created by <@${template.creator_discord_id}> on <t:${template.created_at}:F>`});
            return interaction.editReply({ embeds: [viewEmbed] });
        } else if (sub === 'delete') {
            const templateName = interaction.options.getString('name');
            const result = await linkStore.deleteEventTemplateByName(templateName);
            if (result) { // Assumes delete returns truthy on success (e.g., changes > 0 for SQLite)
                 return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x4CAF50).setTitle('🗑️ Template Deleted').setDescription(`Template "**${templateName}**" deleted.`)]});
            } else {
                 return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Not Found').setDescription(`Template "**${templateName}**" not found or already deleted.`)]});
            }
        }
        return; // End of template group handling
      }


      /* ─────────── LIST (Events) ─────────── */
      if (sub === 'list') {
        await interaction.deferReply({ ephemeral: false }); // List is typically not ephemeral
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
        const templateName = interaction.options.getString('use_template');
        let uploadedImageUrl = null;
        let templateData = {};

        if (templateName) {
            const template = await linkStore.getEventTemplateByName(templateName);
            if (!template) {
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Template Not Found').setDescription(`Event template "**${templateName}**" was not found.`)] });
            }
            try {
                templateData = JSON.parse(template.event_data);
            } catch (e) {
                log(`Error parsing template data for ${templateName}:`, e);
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`Could not parse data for template "**${templateName}**".`)] });
            }
        }

        if (attachment) {
          if (!envConfig.EVENT_ASSET_CHANNEL_ID) {
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Configuration Error').setDescription('Event asset channel is not configured. Cannot process image uploads.')], flags: MessageFlags.Ephemeral });
          }
          if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Invalid File Type').setDescription('Please upload a valid image file (PNG, JPG, GIF).')], flags: MessageFlags.Ephemeral });
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
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Image Upload Failed').setDescription('There was an error processing your image upload. Please try providing a URL instead or try again later.')], flags: MessageFlags.Ephemeral });
          }
        }

        // Modal for event creation
        const modal = new ModalBuilder().setCustomId('eventCreateModal').setTitle('Create New Event (Draft)');

        const titleInput = new TextInputBuilder().setCustomId('eventTitle').setLabel("Event Title").setStyle(1).setRequired(true);
        if (templateData.title) titleInput.setValue(templateData.title);

        const descriptionInput = new TextInputBuilder().setCustomId('eventDescription').setLabel("Event Description").setStyle(2).setRequired(true);
        if (templateData.description) descriptionInput.setValue(templateData.description);

        // Date and Time might not be templated directly, or admin needs to confirm/change them.
        // For now, we won't pre-fill date/time from template as events are time-sensitive.
        const dateInput = new TextInputBuilder().setCustomId('eventDate').setLabel("Start Date (YYYY-MM-DD)").setStyle(1).setRequired(true).setPlaceholder('e.g., 2024-12-31');
        const timeInput = new TextInputBuilder().setCustomId('eventTime').setLabel("Start Time (HH:MM, 24hr format, UTC)").setStyle(1).setRequired(true).setPlaceholder('e.g., 17:30');

        const imageMainUrlInput = new TextInputBuilder().setCustomId('eventImageMainUrl').setLabel("Main Image URL (Optional)").setStyle(1).setRequired(false).setPlaceholder('https://example.com/image.png');
        if (templateData.image_main_url && !uploadedImageUrl) { // Don't prefill if image was uploaded
            imageMainUrlInput.setValue(templateData.image_main_url);
        }
        if (uploadedImageUrl) { // Inform user that uploaded image takes precedence
            imageMainUrlInput.setPlaceholder(`Uploaded image will be used. You can optionally provide a URL to override it if the upload fails or is incorrect.`);
        }


        // Note: Templated island_name, area_name, capacity will be handled by modal submission logic if passed via pendingEventCreations or similar
        // For now, the modal itself doesn't have these fields. They are placeholders in the modal handler.
        // If templateData contains these, they should be stored in client.pendingEventCreations alongside attachmentUrl.
        if (templateData.island_name || templateData.area_name || templateData.capacity) {
            const currentPending = interaction.client.pendingEventCreations.get(interaction.user.id) || {};
            interaction.client.pendingEventCreations.set(interaction.user.id, {
                ...currentPending, // Keep attachmentUrl if it was set
                templateIsland: templateData.island_name,
                templateArea: templateData.area_name,
                templateCapacity: templateData.capacity,
            });
        }


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
        const eventId = interaction.options.getString('event_id'); // Changed to getString
        // Defer reply ephemerally. The original logic for conditional ephemerality based on event.status
        // cannot be perfectly replicated with a single defer then edit, as ephemeral status cannot be removed by editReply.
        // For simplicity, all views will now be ephemeral via this deferral.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const event = await linkStore.getEventById(eventId);
        if (!event) {
          const notFoundEmbed = new EmbedBuilder().setColor(0xFFC107).setTitle('🔎 Event Not Found').setDescription(`Event with ID #${eventId} could not be found.`);
          return interaction.editReply({ embeds: [notFoundEmbed] }); // Will be ephemeral
        }
        // Fetch and attach custom fields
        event.custom_fields = await linkStore.getEventCustomFields(eventId);
        // Fetch and attach rewards
        event.rewards = await linkStore.getEventRewards(eventId);

        const viewEmbed = buildEventEmbed(event, envConfig);
        // The ephemeral: event.status === 'draft' is now redundant here as the reply is already ephemeral.
        return interaction.editReply({ embeds: [viewEmbed] }); // Will be ephemeral
      }

      /* ─────────── PUBLISH (was ANNOUNCE) ─────────── */
      if (sub === 'publish') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Publish confirmation is ephemeral
        const eventId = interaction.options.getString('event_id'); // Changed to getString
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
        // Fetch and attach rewards for the announcement
        eventToPublish.rewards = await linkStore.getEventRewards(eventId);

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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Delete confirmation is ephemeral
        const eventId = interaction.options.getString('event_id'); // Changed to getString
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Edit menu is ephemeral
        // For Phase 1, editing will be simplified. A full modal approach is better for Phase 2.
        // This will require specific sub-options for each field or a modal.
        // For now, let's make it a placeholder or very basic.
        // Example: /events edit event_id:X field:title value:NewTitle
        // This is complex with slash commands for many fields. A modal is the way.
        // For now, just acknowledge and state it's under development for full features.
         const eventId = interaction.options.getString('event_id'); // Changed to getString
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
                new ButtonBuilder().setCustomId(`edit-location-${eventId}`).setLabel('Change Location').setStyle(1), // Primary style for location
                new ButtonBuilder().setCustomId(`manage-custom-fields-${eventId}`).setLabel('Manage Custom Fields').setStyle(2),
                new ButtonBuilder().setCustomId(`manage-event-rewards-${eventId}`).setLabel('Manage Rewards').setStyle(2),
                new ButtonBuilder().setCustomId(`edit-event-image-${eventId}`).setLabel('Change Image').setStyle(2)
            );

        currentEventEmbed.setTitle(`✏️ Editing Event: ${eventToEdit.title} (ID #${eventId})`);
        currentEventEmbed.setDescription(`${eventToEdit.description}\n\nSelect an action below to modify the event.`);
        // The ephemeral flag here is redundant as the deferReply was already ephemeral.
        return interaction.editReply({ embeds: [currentEventEmbed], components: [editActionRow] });
      }

      /* ─────────── EDIT IMAGE ─────────── */
      if (sub === 'edit_image') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Edit image confirmation is ephemeral
        const eventId = interaction.options.getString('event_id'); // Changed to getString
        const attachment = interaction.options.getAttachment('image_upload');
        let imageUrl = interaction.options.getString('image_url'); // Can be null or "none"

        if (!attachment && !imageUrl) {
            // All editReply calls within this block will inherit the ephemeral status from deferReply.
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Missing Input').setDescription('Please provide either an image upload or an image URL.')] });
        }

        const eventToEdit = await linkStore.getEventById(eventId);
        if (!eventToEdit) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Error').setDescription(`Event with ID #${eventId} not found.`)] });
        }

        let finalImageUrl = eventToEdit.image_main_url; // Default to existing

        if (attachment) {
            if (!envConfig.EVENT_ASSET_CHANNEL_ID) {
              return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Configuration Error').setDescription('Event asset channel is not configured for uploads.')] });
            }
            if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
              return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Invalid File Type').setDescription('Please upload a valid image file.')] });
            }
            try {
              const assetChannel = await interaction.client.channels.fetch(envConfig.EVENT_ASSET_CHANNEL_ID);
              const sentMessage = await assetChannel.send({ files: [attachment] });
              finalImageUrl = sentMessage.attachments.first()?.url;
              if (!finalImageUrl) throw new Error('Failed to get URL from uploaded attachment.');
            } catch (uploadError) {
              console.error('Failed to upload event image for edit:', uploadError);
              return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xE53935).setTitle('❌ Image Upload Failed').setDescription('Error processing image upload.')] });
            }
        } else if (imageUrl) {
            if (imageUrl.toLowerCase() === 'none' || imageUrl.toLowerCase() === 'clear') {
                finalImageUrl = null;
            } else if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
                 return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFC107).setTitle('⚠️ Invalid URL').setDescription('Please provide a valid HTTP/HTTPS URL or "none" to clear the image.')] });
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // RSVPs view is ephemeral for admin
        const eventId = interaction.options.getString('event_id'); // Changed to getString
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
        // If the error itself is that the interaction is already acknowledged, don't try to send another reply.
        if (err.code === 40060) { // DiscordAPIError.Codes.InteractionAlreadyReplied is 40060
          console.warn('[EVENTS_COMMAND_HANDLER] Caught error "InteractionAlreadyReplied", not sending another error message.');
          return;
        }
        // If the error is "Unknown Interaction", it's possible we can't reply either.
        if (err.code === 10062) { // DiscordAPIError.Codes.UnknownInteraction is 10062
            console.warn('[EVENTS_COMMAND_HANDLER] Caught error "UnknownInteraction", attempting to log but likely cannot reply.');
            // Still proceed to try and reply/followUp, as sometimes a followUp might work if a deferral was lost.
        }

        const errorEmbed = new EmbedBuilder()
          .setColor(0xE53935) // ERROR_COLOR
          .setTitle('⚠️ Internal Error')
          .setDescription('An unexpected error occurred while processing the command. Please try again later or contact an administrator.');

        console.log(`[EVENTS_COMMAND_HANDLER] Error caught. Interaction state: replied=${interaction.replied}, deferred=${interaction.deferred}`);

        // Check if the interaction can be replied to or followed up
        if (interaction.replied || interaction.deferred) {
          console.log('[EVENTS_COMMAND_HANDLER] Attempting to followUp error message.');
          return await interaction.followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(e => {
            console.error('[EVENTS_COMMAND_HANDLER] Failed to followUp error message:', e);
          });
        } else {
          console.log('[EVENTS_COMMAND_HANDLER] Attempting to reply with error message.');
          return await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(e => {
            console.error('[EVENTS_COMMAND_HANDLER] Failed to reply with error message:', e);
          });
        }
      } catch (secondaryError) {
        console.error('💥 Error in /events command secondary error handler (likely failed to send error message):', secondaryError);
        /* ignore secondary failures, but log them */
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
      embed.addFields({ name: cf.field_name, value: cf.field_value, inline: true }); // Keep inline true for now, or make it configurable
    });
  }

  // Event Rewards display
  if (event.rewards && event.rewards.length > 0) {
    embed.addFields({ name: '\u200B', value: '**🎁 Event Rewards:**' }); // Separator
    event.rewards.forEach(reward => {
      let rewardValue = reward.description || '_No description_';
      if (reward.image_url) { // Simple link for now, not inline image in field
        rewardValue += `\n[View Image](${reward.image_url})`;
      }
      embed.addFields({ name: reward.name, value: rewardValue, inline: event.rewards.length > 1 }); // Inline if multiple rewards
    });
  }

  embed.setFooter({ text: `Created by: ${event.creator_discord_id} • Last updated: <t:${event.updated_at}:R>` })
       .setTimestamp(event.created_at * 1000); // Timestamp of original creation

  return embed;
}
