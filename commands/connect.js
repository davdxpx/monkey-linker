// commands/connect.js – Slash-Befehl: /connect <RobloxUser>
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Link your Roblox account')
    .addStringOption(opt =>
      opt.setName('robloxuser')
        .setDescription('Exact Roblox username (case-sensitive)')
        .setRequired(true)
    ),

  async execute(i, db) {
    const rbxName = i.options.getString('robloxuser', true);
    await i.deferReply({ ephemeral: true });

    // Lookup Roblox userId
    let userId;
    try {
      const { data } = await axios.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [rbxName], excludeBannedUsers: true },
        { timeout: 5000 }
      );
      userId = data.data[0]?.id;
    } catch {
      return i.editReply('⚠️ Roblox API error – try again later.');
    }
    if (!userId) return i.editReply('🚫 Roblox user not found.');

    // Duplicate check
    const pending = await new Promise(r =>
      db.get('SELECT verified FROM links WHERE discord=?', [i.user.id], (_, row) => r(row))
    );
    if (pending && !pending.verified)
      return i.editReply('⚠️ You already have a pending link. Finish that first.');

    // Create code
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    db.run(
      'INSERT OR REPLACE INTO links (discord, roblox, code, verified, created) VALUES (?,?,?,?,strftime("%s","now"))',
      [i.user.id, userId, code, 0]
    );

    // DM instructions
    const dmEmbed = new EmbedBuilder()
      .setColor(0x00bcd4)
      .setTitle('Account Link – Final Step')
      .setDescription(
        `**1.** Paste \`${code}\` in your Roblox profile **About**.\n` +
        '**2.** React ✅ to this DM within 15 min.\n\n' +
        '_You can remove the code after verification._'
      );
    try {
      const dm = await i.user.send({ embeds: [dmEmbed] });
      await dm.react('✅');
      i.editReply('📩 Check your DMs for the verification code!');
    } catch {
      i.editReply('❌ Could not send DM. Please enable DMs and try again.');
    }
  }
};
