// commands/progress.js
const { SlashCommandBuilder } = require('discord.js');
const db = require('../db');
const { fetchProgress } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Show your current Monkey Simulator progress'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const row = await db.getVerified(interaction.user.id);
    if (!row) return interaction.editReply('❌ You have not linked a Roblox account.');

    const progress = await fetchProgress(row.roblox);
    if (!progress) return interaction.editReply('⚠️ Unable to fetch progress. Try again later.');

    return interaction.editReply(`📊 Monkey Level **${progress.level}** · Statues **${progress.statues}/42**`);
  }
};
