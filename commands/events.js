// commands/events.js – Advanced Event Manager (v2)
// Allows multiple admin roles to create / delete rich events stored in events.json
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const DB = path.resolve('./events.json');

/*───── Helpers ─────*/
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : []);
const save = arr => fs.writeFileSync(DB, JSON.stringify(arr, null, 2));
const adminRoles = ['👆🏼 Admin', 'Community Manager', 'Admin']; // beliebig erweitern

function isEventAdmin(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(r => adminRoles.includes(r.name))
  );
}

/*───── Command Definition ─────*/
module.exports = {
  data: new SlashCommandBuilder()
    .setName('events')
    .setDescription('List, create or delete Monkey Simulator events')

    // /events list
    .addSubcommand(sc => sc.setName('list').setDescription('List all upcoming events'))

    // /events create ...
    .addSubcommand(sc => sc.setName('create').setDescription('Create a new event')
      .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('Date (YYYY-MM-DD)').setRequired(true))
      .addStringOption(o => o.setName('desc').setDescription('Short description').setRequired(true))   // ← nach oben!
      // ab hier NUR noch optionale Felder
      .addStringOption(o => o.setName('time').setDescription('Start time (e.g. 18:00 UTC)'))
      .addStringOption(o => o.setName('world').setDescription('Which game world / island?'))
      .addStringOption(o => o.setName('area').setDescription('Specific area / zone'))
      .addStringOption(o => o.setName('reward').setDescription('Reward overview'))
      .addRoleOption(  o => o.setName('pingrole').setDescription('Role to ping when announcing'))
      .addIntegerOption(o => o.setName('capacity').setDescription('Max participants (0 = unlimited)')))
    // /events delete <id>
    .addSubcommand(sc => sc.setName('delete').setDescription('Delete an event by its ID')
      .addIntegerOption(o => o.setName('id').setDescription('ID from /events list').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const evList = load();

    /*──────── LIST ────────*/
    if (sub === 'list') {
      const embed = new EmbedBuilder()
        .setTitle('📅 Upcoming Events')
        .setColor(0x00bcd4);

      if (!evList.length) {
        embed.setDescription('There are currently **no scheduled events**.');
      } else {
        evList.forEach((ev, i) => {
          embed.addFields({
            name: `#${i} • ${ev.title}  (${ev.date}${ev.time ? ' ' + ev.time : ''})`,
            value: `${ev.desc}
🏝️ **World:** ${ev.world ?? '—'} | 🌄 **Area:** ${ev.area ?? '—'} | 🎁 **Reward:** ${ev.reward ?? '—'} | 👥 **Cap:** ${ev.capacity || '∞'}`,
            inline: false
          });
        });
      }
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    /*──── permission check for create / delete ────*/
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!isEventAdmin(member)) {
      return interaction.reply({ content: '🚫 You need the Event‑Admin role to do that.', ephemeral: true });
    }

    /*──────── CREATE ────────*/
    if (sub === 'create') {
      const newEvent = {
        title: interaction.options.getString('title'),
        date:  interaction.options.getString('date'),
        time:  interaction.options.getString('time') ?? '',
        desc:  interaction.options.getString('desc'),
        world: interaction.options.getString('world') ?? '',
        area:  interaction.options.getString('area')  ?? '',
        reward:interaction.options.getString('reward')?? '',
        ping:  interaction.options.getRole('pingrole')?.id || '',
        capacity: interaction.options.getInteger('capacity') || 0
      };
      evList.push(newEvent); save(evList);

      // optional announcement
      if (newEvent.ping) {
        const role = interaction.guild.roles.cache.get(newEvent.ping);
        const announceCh = interaction.channel; // announce in current channel
        if (announceCh) {
          const announceEmbed = new EmbedBuilder()
            .setColor(0x43a047)
            .setTitle('✅ New Event Created!')
            .setDescription(`${newEvent.desc}`)
            .addFields(
              { name: 'Date', value: `${newEvent.date}${newEvent.time ? ' ' + newEvent.time : ''}`, inline: true },
              { name: 'World', value: newEvent.world || '—', inline: true },
              { name: 'Reward', value: newEvent.reward || '—', inline: true }
            );
          announceCh.send({ content: role ? `${role}` : null, embeds: [announceEmbed] });
        }
      }

      return interaction.reply({ content: `🎉 Event **${newEvent.title}** added (#${evList.length - 1}).`, ephemeral: true });
    }

    /*──────── DELETE ────────*/
    if (sub === 'delete') {
      const id = interaction.options.getInteger('id');
      if (id < 0 || id >= evList.length)
        return interaction.reply({ content: '❌ Invalid ID.', ephemeral: true });
      const [removed] = evList.splice(id, 1); save(evList);
      return interaction.reply({ content: `🗑️ Event **${removed.title}** deleted.`, ephemeral: true });
    }
  }
};
