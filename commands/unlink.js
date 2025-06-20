// commands/unlink.js
const { SlashCommandBuilder } = require('discord.js');
const db = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove the link to your Roblox account'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const row = await db.getVerified(interaction.user.id);
    if (!row) return interaction.editReply('⚠️ You have no verified link.');

    await db.removeLink(interaction.user.id);
    return interaction.editReply('✅ Link removed. You can /connect again anytime.');
  }
};
