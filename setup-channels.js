import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

/**
 * Script de configuration automatique des permissions des channels
 * Configure les permissions du rôle "Rapatrié" pour qu'il soit en lecture seule
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function setupChannelPermissions() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   🔒 Configuration des Permissions des Channels          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Vérifier les variables
  if (!process.env.DISCORD_TOKEN || !process.env.GUILD_ID || !process.env.RAPATRI_ROLE_ID) {
    console.error('❌ Variables manquantes dans .env:');
    if (!process.env.DISCORD_TOKEN) console.error('   - DISCORD_TOKEN');
    if (!process.env.GUILD_ID) console.error('   - GUILD_ID');
    if (!process.env.RAPATRI_ROLE_ID) console.error('   - RAPATRI_ROLE_ID');
    console.error('\n💡 Lancez d\'abord: node setup-roles.js\n');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers
    ]
  });

  console.log('📡 Connexion au bot Discord...\n');

  await client.login(process.env.DISCORD_TOKEN);
  await new Promise(resolve => client.once('ready', resolve));

  console.log(`✅ Connecté en tant que ${client.user.tag}\n`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);

  if (!guild) {
    console.error('❌ Serveur introuvable');
    process.exit(1);
  }

  const rapatriRole = guild.roles.cache.get(process.env.RAPATRI_ROLE_ID);

  if (!rapatriRole) {
    console.error('❌ Rôle "Rapatrié" introuvable');
    console.error('💡 Vérifiez RAPATRI_ROLE_ID dans .env ou relancez: node setup-roles.js\n');
    process.exit(1);
  }

  console.log(`📍 Serveur: ${guild.name}`);
  console.log(`👤 Rôle: ${rapatriRole.name} (${rapatriRole.id})\n`);
  console.log('─────────────────────────────────────────────────────────────\n');

  // Récupérer tous les channels texte
  const textChannels = guild.channels.cache.filter(
    channel => channel.type === ChannelType.GuildText
  );

  console.log(`📝 ${textChannels.size} channels texte trouvés:\n`);

  textChannels.forEach((channel, index) => {
    const hasPermissions = channel.permissionOverwrites.cache.has(rapatriRole.id);
    console.log(`  ${index + 1}. #${channel.name} ${hasPermissions ? '✅' : '❌'}`);
  });

  console.log('\n─────────────────────────────────────────────────────────────\n');
  console.log('🔒 Configuration pour le rôle "Rapatrié":\n');
  console.log('  ✅ Voir le channel');
  console.log('  ✅ Lire les messages');
  console.log('  ✅ Lire l\'historique');
  console.log('  ❌ Envoyer des messages');
  console.log('  ❌ Ajouter des réactions');
  console.log('  ❌ Utiliser les commandes slash');
  console.log('\n─────────────────────────────────────────────────────────────\n');

  const answer = await question('Voulez-vous configurer TOUS les channels ? (o/n): ');

  if (answer.toLowerCase() !== 'o' && answer.toLowerCase() !== 'oui') {
    console.log('\n⚠️  Configuration manuelle sélectionnée\n');
    
    // Configuration manuelle channel par channel
    for (const [channelId, channel] of textChannels) {
      const configure = await question(`\nConfigurer #${channel.name} ? (o/n): `);
      
      if (configure.toLowerCase() === 'o' || configure.toLowerCase() === 'oui') {
        try {
          await channel.permissionOverwrites.edit(rapatriRole, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: false,
            AddReactions: false,
            UseApplicationCommands: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false
          });
          console.log(`✅ #${channel.name} configuré`);
        } catch (error) {
          console.error(`❌ Erreur sur #${channel.name}:`, error.message);
        }
      } else {
        console.log(`⏭️  #${channel.name} ignoré`);
      }
    }
  } else {
    console.log('\n🔨 Configuration de tous les channels...\n');

    let success = 0;
    let failed = 0;

    for (const [channelId, channel] of textChannels) {
      try {
        await channel.permissionOverwrites.edit(rapatriRole, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
          AddReactions: false,
          UseApplicationCommands: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false
        });
        console.log(`✅ #${channel.name}`);
        success++;
      } catch (error) {
        console.error(`❌ #${channel.name}: ${error.message}`);
        failed++;
      }
    }

    console.log('\n─────────────────────────────────────────────────────────────\n');
    console.log(`📊 Résultats: ${success} réussis, ${failed} échecs\n`);
  }

  console.log('─────────────────────────────────────────────────────────────\n');
  console.log('✅ Configuration terminée !\n');

  rl.close();
  await client.destroy();
  process.exit(0);
}

setupChannelPermissions().catch(error => {
  console.error('\n❌ Erreur:', error);
  rl.close();
  process.exit(1);
});
