/*─────────────────────────────────────────────────────────────────────────
  📦  Monkey Simulator Discord Bot – CONNECTION COMMAND
  ╭──────────────────────────────────────────────────────────────────────╮
  │ /connection status –  shows quick link status                      │
  │ /connection info   –  shows full link + game‑stats (OC)            │
  │                                                                    │
  │  © StillBrokeStudios 2025  –  Utility‑Handler  –  @davdxpx          │
  ╰──────────────────────────────────────────────────────────────────────╯
─────────────────────────────────────────────────────────────────────────*/

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

// ───────────────────────── CONSTANTS ──────────────────────────
const DEFAULT_AVATAR =
  'https://tr.rbxcdn.com/e2489cf32bdd1e909018aff4bfe0b9a7/150/150/AvatarHeadshot/Png';

const COLOR = {
  UNLINKED: 0x757575,  // grey
  PENDING:  0xffc107,  // amber
  VERIFIED: 0x43a047,  // green
};

// ──────────────────────── HELPERS ─────────────────────────────
/** Fetch Roblox profile & circular avatar (returns fallback on error) */
async function fetchRobloxProfile(userId, debug = false) {
  try {
    const [{ data: prof }, { data: thumb }] = await Promise.all([
      axios.get(`https://users.roblox.com/v1/users/${userId}`),
      axios.get('https://thumbnails.roblox.com/v1/users/avatar', {
        params: {
          userIds: userId,
          size: '150x150',
          isCircular: true,
          format: 'Png',
        },
      }),
    ]);
    const imgUrl = thumb?.data?.[0]?.imageUrl || DEFAULT_AVATAR;
    if (debug) console.log('[CONNECTION] Roblox profile fetched:', prof.name);
    return {
      name: prof.name,
      displayName: prof.displayName,
      avatar: imgUrl,
    };
  } catch (e) {
    console.error('[CONNECTION] Roblox profile error:', e?.message || e);
    return { name: `User ${userId}`, displayName: `User ${userId}`, avatar: DEFAULT_AVATAR };
  }
}

/** Fetch basic player stats from OpenCloud (MainDataStore) */
async function fetchOpenCloudStats(robloxId, env, debug = false) {
  if (!env.UNIVERSE_ID || !env.OC_KEY) return null;
  try {
    const res = await axios.get(
      `https://apis.roblox.com/datastores/v1/universes/${env.UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
      {
        params: { datastoreName: 'MainDataStore', entryKey: `Player_${robloxId}` },
        headers: { 'x-api-key': env.OC_KEY },
      },
    );
    const data = JSON.parse(res.data.data);
    if (debug) console.log('[CONNECTION] OC‑stats:', robloxId, data.PlayerData?.Progress);
    return {
      level:    data?.PlayerData?.Progress?.Level            ?? '—',
      statues:  data?.PlayerData?.Progress?.Statues          ?? '—',
      coinanas: data?.Stats?.TotalCoinanas                   ?? '—',
      playtime: data?.PlayerData?.Meta?.TotalPlayTime        ?? '—',
    };
  } catch (e) {
    console.error('[CONNECTION] OC‑stats error:', e?.response?.status || e);
    return null;
  }
}

/** seconds → "Xd Xh Xm" */
const fmtSeconds = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
};

// ──────────────────── SLASH COMMAND DEF ──────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('connection')
    .setDescription('Show link status or detailed info')
    .addSubcommand((s) =>
      s.setName('status')
        .setDescription('Quick link status')
        .addUserOption((o) =>
          o.setName('user').setDescription('Check another user (admin‑only)')
        ),
    )
    .addSubcommand((s) =>
      s.setName('info')
        .setDescription('Full link details & game stats')
        .addUserOption((o) =>
          o.setName('user').setDescription('Check another user (admin‑only)')
        ),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} linkStore – API with get(), upsert(), … (see backend chooser)
   * @param {object} env       – { VERIFIED_ROLE_ID, UNIVERSE_ID, OC_KEY, GUILD_ID }
   */
  async execute(interaction, linkStore, env) {
    const sub      = interaction.options.getSubcommand();
    const target   = interaction.options.getUser('user') || interaction.user;
    const member   = await interaction.guild.members.fetch(interaction.user.id);
    const isAdmin  = member.permissions.has(PermissionFlagsBits.Administrator);

    if (target.id !== interaction.user.id && !isAdmin) {
      return interaction.reply({ content: '🚫 Only admins can query other users.', ephemeral: true });
    }

    const DEBUG = !!process.env.DEBUG_STATUS;

    /*──── DB Lookup (via linkStore API) ────*/
    const row = await linkStore.get(target.id);
    const now = Math.floor(Date.now() / 1000);

    const state = !row ? 'UNLINKED' : row.verified ? 'VERIFIED' : 'PENDING';

    /*────────────── /status ──────────────*/
    if (sub === 'status') {
      const embed = new EmbedBuilder()
        .setColor(COLOR[state])
        .setTitle(`🔗 Connection Status – ${target.tag}`)
        .setThumbnail(target.displayAvatarURL({ size: 128 }));

      if (!row) {
        embed.setDescription('❌ Not linked');
      } else if (!row.verified) {
        const ttl = 900 - (now - row.created);
        embed.setDescription(`⏳ Pending – verify with ✅ reaction\nExpires in **${Math.max(ttl, 0)} s**`)
             .addFields({ name: 'Roblox ID', value: String(row.roblox), inline: true });
      } else {
        embed.setDescription('✅ Linked & verified')
             .addFields({ name: 'Roblox ID', value: String(row.roblox), inline: true });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    /*────────────── /info ───────────────*/
    if (sub === 'info') {
      if (!row) {
        return interaction.reply({ content: '⚠️ User is not linked.', ephemeral: true });
      }

      const roblox = await fetchRobloxProfile(row.roblox, DEBUG);
      const stats  = row.verified ? await fetchOpenCloudStats(row.roblox, env, DEBUG) : null;

      const embed = new EmbedBuilder()
        .setColor(COLOR[state])
        .setTitle(`🛂 Connection Info – ${target.tag}`)
        .setThumbnail(roblox.avatar)
        .setFooter({ text: `Data as of ${new Date().toLocaleString('de-DE')}` });

      embed.addFields(
        { name: 'Roblox', value: `**${roblox.displayName}** (\`${roblox.name}\`)`, inline: true },
        { name: 'Roblox ID', value: String(row.roblox), inline: true },
        { name: 'Status', value: row.verified ? '✅ Verified' : '⏳ Pending', inline: true },
        { name: 'Linked since', value: `<t:${row.created}:F>\n(${fmtSeconds(now - row.created)} ago)`, inline: true },
      );

      if (!row.verified) {
        embed.addFields({ name: 'Verification code', value: row.code || '—', inline: true });
      }

      if (stats) {
        embed.addFields(
          { name: 'Level', value: String(stats.level), inline: true },
          { name: 'Statues', value: String(stats.statues), inline: true },
          { name: 'Coinanas (total)', value: String(stats.coinanas), inline: true },
          { name: 'Playtime', value: fmtSeconds(stats.playtime), inline: true },
        );
      }

      if (env.VERIFIED_ROLE_ID) {
        const verRole = interaction.guild.roles.cache.get(env.VERIFIED_ROLE_ID);
        if (verRole) {
          embed.addFields({ name: 'Discord Role', value: `<@&${verRole.id}>`, inline: true });
        }
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
