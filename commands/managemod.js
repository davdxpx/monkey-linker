'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { canManageModerators } = require('../utils/permissions'); // Assuming this path is correct

module.exports = {
  data: new SlashCommandBuilder()
    .setName('managemod')
    .setDescription('Manage bot moderators.')
    .setDefaultMemberPermissions(0) // Available to everyone by default, permissions checked in execute
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Grant bot moderator status to a user.')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to grant moderator status.')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Revoke bot moderator status from a user.')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to revoke moderator status from.')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all current bot moderators.')),
  async execute(interaction, linkStore, envConfig) {
    const subcommand = interaction.options.getSubcommand();

    if (!await canManageModerators(interaction, linkStore, envConfig)) {
      const noPermsEmbed = new EmbedBuilder()
        .setColor(0xE53935)
        .setTitle('🚫 Permission Denied')
        .setDescription('You do not have the required permissions to use this command.');
      return interaction.reply({ embeds: [noPermsEmbed], ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user'); // For add/remove

    if (subcommand === 'add') {
      if (!targetUser) {
        return interaction.reply({ content: 'You must specify a user to add as a moderator.', ephemeral: true });
      }
      try {
        await linkStore.grantModeratorRole(targetUser.id, interaction.user.id);
        const successEmbed = new EmbedBuilder()
          .setColor(0x4CAF50)
          .setTitle('✅ Moderator Added')
          .setDescription(`${targetUser.tag} (${targetUser.id}) has been granted bot moderator status.`);
        return interaction.reply({ embeds: [successEmbed], ephemeral: true });
      } catch (error) {
        console.error(`Error granting moderator role to ${targetUser.id}:`, error);
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE53935)
          .setTitle('❌ Error')
          .setDescription(`Could not grant moderator status to ${targetUser.tag}. Please check the logs.`);
        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    } else if (subcommand === 'remove') {
      if (!targetUser) {
        return interaction.reply({ content: 'You must specify a user to remove from moderators.', ephemeral: true });
      }
      try {
        await linkStore.revokeModeratorRole(targetUser.id);
        const successEmbed = new EmbedBuilder()
          .setColor(0x4CAF50)
          .setTitle('🗑️ Moderator Removed')
          .setDescription(`${targetUser.tag} (${targetUser.id}) has had their bot moderator status revoked.`);
        return interaction.reply({ embeds: [successEmbed], ephemeral: true });
      } catch (error) {
        console.error(`Error revoking moderator role from ${targetUser.id}:`, error);
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE53935)
          .setTitle('❌ Error')
          .setDescription(`Could not revoke moderator status from ${targetUser.tag}. Please check the logs.`);
        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    } else if (subcommand === 'list') {
      // Permission for 'list' could be different, e.g., existing moderators can also list.
      // For now, keeping it same as add/remove (Owner/Admin only).
      // If only Owner/Admin should list, the existing canManageModerators check is fine.

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
              const user = await interaction.client.users.fetch(mod.user_id);
              modUsers.push(`- ${user.tag} (ID: ${mod.user_id}, Granted by: <@${mod.granted_by_user_id}> on <t:${mod.granted_at}:D>)`);
            } catch (fetchError) {
              modUsers.push(`- Unknown User (ID: ${mod.user_id}, Granted by: <@${mod.granted_by_user_id}> on <t:${mod.granted_at}:D>) (Error fetching user details)`);
              console.warn(`Could not fetch user details for moderator ID ${mod.user_id}:`, fetchError.message);
            }
          }
          listEmbed.setDescription(modUsers.join('\n').substring(0, 4000)); // Limit description length
        }
        return interaction.reply({ embeds: [listEmbed], ephemeral: true });
      } catch (error) {
        console.error('Error listing moderators:', error);
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE53935)
          .setTitle('❌ Error')
          .setDescription('Could not retrieve the list of moderators. Please check the logs.');
        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  },
};
