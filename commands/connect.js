// commands/connect.js
// © StillBrokeStudios 2025 — @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const crypto = require('crypto');
const db = require('../db');
const { getUserId } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Link your Roblox account')
    .addStringOption(opt =>
      opt.setName('robloxuser')
        .setDescription('Exact Roblox username (case-sensitive)')
        .setRequired(true)),

  async execute(interaction) {
    const rbxName = interaction.options.getString('robloxuser', true);
    await interaction.deferReply({ ephemeral: true });

    const userId = await getUserId(rbxName);
    if (!userId) return interaction.editReply('🚫 Roblox user not found.');

    const existing = await db.getPending(interaction.user.id);
    if (existing) return interaction.editReply('⚠️ You already have a pending link.');

    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    await db.insertPending(interaction.user.id, userId, code);

    const embed = new EmbedBuilder()
      .setColor(0x00bcd4)
      .setTitle('Account Link – Final Step')
      .setDescription(`**1.** Paste \`${code}\` in your Roblox profile **About**.\n**2.** React ✅ to this DM within 15 min.`);

    const dm = await interaction.user.send({ embeds: [embed] });
    await dm.react('✅');

    return interaction.editReply('📩 Check your DMs to complete linking.');
  }
};
