const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { isBotAdmin } = require('../utils/permissions'); // Assuming this path is correct

module.exports = {
  data: new SlashCommandBuilder()
    .setName('manage')
    .setDescription('Access the management panel for bot settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Default for admins, but will also check custom isBotAdmin

  async execute(interaction, linkStore, envConfig) {
    // Check if the user is a bot admin (includes owner)
    if (!isBotAdmin(interaction.member, envConfig.ADMIN_ROLES, envConfig.OWNER_ID)) {
      const noPermsEmbed = new EmbedBuilder()
        .setColor(0xE53935) // ERROR_COLOR
        .setTitle('🚫 Permission Denied')
        .setDescription('You do not have the required permissions (Bot Admin or Owner) to use this command.');
      return interaction.reply({ embeds: [noPermsEmbed], ephemeral: true });
    }

    const manageEmbed = new EmbedBuilder()
      .setColor(0x0099FF) // INFO_COLOR or a custom one
      .setTitle('🛠️ Bot Management Panel')
      .setDescription('Welcome to the Bot Management Panel. Please choose an option below to configure settings.')
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('manage_bot_moderators')
          .setLabel('Manage Bot Moderators')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🛡️'),
        new ButtonBuilder()
          .setCustomId('manage_event_reward_types')
          .setLabel('Manage Event Reward Types')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎁'),
        new ButtonBuilder()
          .setCustomId('manage_rsvp_role')
          .setLabel('Manage RSVP Role')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎟️')
      );

    await interaction.reply({ embeds: [manageEmbed], components: [row], ephemeral: true });
  },
};
