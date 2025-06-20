// commands/checklink.js const { SlashCommandBuilder } = require('discord.js'); const db = require('../db');

module.exports = { data: new SlashCommandBuilder() .setName('checklink') .setDescription('Check your linked Roblox account'),

async execute(interaction) { await interaction.deferReply({ ephemeral: true }); const row = await db.getVerified(interaction.user.id); if (!row) return interaction.editReply('❌ No verified account linked.');

return interaction.editReply(`🔗 You are linked to **Roblox ID: ${row.roblox}**`);

} };

