// events/verify.js – Reaction handler for ✅ verification
// © StillBrokeStudios 2025 · @davdxpx

const { EmbedBuilder } = require('discord.js');
const axios = require('axios');

module.exports = async (reaction, user, client, db, config) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();

  db.get('SELECT * FROM links WHERE discord=?', [user.id], async (_, row) => {
    if (!row || row.verified) return;

    try {
      const { data: profile } = await axios.get(
        `https://users.roblox.com/v1/users/${row.roblox}`,
        { timeout: 5000 }
      );
      if (!profile.description?.includes(row.code))
        return user.send('❌ Code not found – save it in your profile and react again.');

      db.run('UPDATE links SET verified=1 WHERE discord=?', [user.id]);
      user.send('✅ Linked! You can delete the code from your profile.');

      // Optional: Role
      if (config.VERIFIED_ROLE_ID) {
        const guild  = await client.guilds.fetch(config.GUILD_ID);
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (member) member.roles.add(config.VERIFIED_ROLE_ID).catch(console.error);
      }

      // Optional: OpenCloud fetch
      if (config.UNIVERSE_ID && config.OC_KEY) {
        try {
          const entryKey = `Player_${row.roblox}`;
          const oc = await axios.get(
            `https://apis.roblox.com/datastores/v1/universes/${config.UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
            {
              params: { datastoreName: 'MainDataStore', entryKey },
              headers: { 'x-api-key': config.OC_KEY },
              timeout: 5000
            }
          );
          const data  = JSON.parse(oc.data.data);
          const lvl   = data?.PlayerData?.Progress?.Level ?? '?';
          const stat  = data?.PlayerData?.Progress?.Statues ?? '?';
          user.send(`📊 Monkey Level **${lvl}** · Statues **${stat}/42**`);
        } catch (e) {
          console.error(e);
          user.send('ℹ️ Linked, but stats could not be fetched.');
        }
      }

    } catch (e) {
      console.error(e);
      user.send('⚠️ Verification failed – try again later.');
    }
  });
};
