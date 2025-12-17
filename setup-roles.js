import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

/**
 * Script de configuration automatique des rôles Discord
 * Crée tous les rôles nécessaires avec les bonnes permissions
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

/**
 * Calcule la similarité entre deux noms de rôle
 * Favorise "Exilés" (avec accent) comme meilleur match
 */
function getNameSimilarity(name1, name2) {
  // Match exact = score maximum
  if (name1 === name2) return 100;
  
  const n1 = name1.toLowerCase();
  const n2 = name2.toLowerCase();
  
  // Match case-insensitive
  if (n1 === n2) return 90;
  
  // Bonus si contient un accent (é)
  const hasAccent = name1.includes('é') || name1.includes('É');
  let score = 0;
  
  // Calculer la longueur de la sous-chaîne commune
  const shorter = n1.length < n2.length ? n1 : n2;
  const longer = n1.length >= n2.length ? n1 : n2;
  
  if (longer.includes(shorter)) {
    score = (shorter.length / longer.length) * 80;
  }
  
  return score + (hasAccent ? 10 : 0);
}

async function setupRoles() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     🚀 Configuration Automatique des Rôles Discord        ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Vérifier le token
  if (!process.env.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN manquant dans .env');
    process.exit(1);
  }

  if (!process.env.GUILD_ID) {
    console.error('❌ GUILD_ID manquant dans .env');
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

  console.log(`📍 Serveur: ${guild.name}\n`);
  console.log('─────────────────────────────────────────────────────────────\n');

  // Configuration des rôles à créer
  const rolesToCreate = [
    {
      name: 'Éxilés',
      alternativeNames: ['Exilé', 'Exilés', 'Exiles', 'Exile', 'exilé'],
      color: 0xFF0000, // Rouge
      permissions: [
        PermissionFlagsBits.Administrator // Tous les droits
      ],
      reason: 'Rôle principal des membres de la Table des Exilés - Admins avec tous les droits',
      envVar: 'EXILES_ROLE_ID'
    },
    {
      name: 'Condamné à l\'Exil',
      color: 0xFFA500, // Orange
      permissions: [], // Aucun droit spécial, juste résiste à la purge
      reason: 'Rôle temporaire pendant le vote (24h) - Résiste à la purge',
      envVar: 'CONDAMNE_ROLE_ID'
    },
    {
      name: 'Rapatrié',
      color: 0x808080, // Gris
      permissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.Connect // Peut rejoindre les vocaux
      ],
      reason: 'Rôle pour les exclus (lecture seule - voit tout mais ne peut rien faire)',
      envVar: 'RAPATRI_ROLE_ID'
    }
  ];

  console.log('🎨 Rôles à créer:\n');
  rolesToCreate.forEach((role, index) => {
    const colorHex = '#' + role.color.toString(16).padStart(6, '0');
    console.log(`  ${index + 1}. ${role.name} (${colorHex})`);
  });
  console.log('\n─────────────────────────────────────────────────────────────\n');

  const answer = await question('Voulez-vous continuer ? (o/n): ');

  if (answer.toLowerCase() !== 'o' && answer.toLowerCase() !== 'oui') {
    console.log('\n❌ Annulé');
    process.exit(0);
  }

  console.log('\n🔨 Création des rôles...\n');

  const createdRoles = {};

  for (const roleConfig of rolesToCreate) {
    try {
      // Vérifier si le rôle existe déjà (nom exact ou variantes)
      const possibleNames = [roleConfig.name, ...(roleConfig.alternativeNames || [])];
      const matchingRoles = guild.roles.cache.filter(r => 
        possibleNames.some(name => r.name.toLowerCase() === name.toLowerCase())
      );

      if (matchingRoles.size > 0) {
        // Si plusieurs rôles similaires existent
        if (matchingRoles.size > 1) {
          console.log(`⚠️  ${matchingRoles.size} rôles similaires trouvés:`);
          matchingRoles.forEach((role, i) => {
            console.log(`   ${i + 1}. "${role.name}" (ID: ${role.id})`);
          });
          console.log();
          
          // Trouver le rôle le plus proche de "Exilés" (avec accent)
          const bestMatch = matchingRoles.reduce((best, current) => {
            const bestScore = getNameSimilarity(best.name, roleConfig.name);
            const currentScore = getNameSimilarity(current.name, roleConfig.name);
            return currentScore > bestScore ? current : best;
          });
          
          console.log(`✅ Meilleur match: "${bestMatch.name}" (ID: ${bestMatch.id})`);
          
          const deleteOthers = await question(`   Voulez-vous supprimer les autres doublons ? (o/n): `);
          
          if (deleteOthers.toLowerCase() === 'o' || deleteOthers.toLowerCase() === 'oui') {
            for (const [roleId, role] of matchingRoles) {
              if (roleId !== bestMatch.id) {
                try {
                  await role.delete('Suppression de doublon');
                  console.log(`   🗑️  Rôle "${role.name}" supprimé`);
                } catch (err) {
                  console.log(`   ❌ Impossible de supprimer "${role.name}": ${err.message}`);
                }
              }
            }
            console.log();
          }
          
          createdRoles[roleConfig.envVar] = bestMatch.id;
          
          const update = await question(`   Mettre à jour les permissions/couleur de "${bestMatch.name}" ? (o/n): `);
          if (update.toLowerCase() === 'o' || update.toLowerCase() === 'oui') {
            await bestMatch.edit({
              color: roleConfig.color,
              permissions: roleConfig.permissions,
              reason: roleConfig.reason
            });
            console.log(`   ✅ Permissions et couleur mises à jour\n`);
          }
          
          continue;
        }
        
        // Un seul rôle trouvé
        const existingRole = matchingRoles.first();
        console.log(`✅ Rôle trouvé: "${existingRole.name}" (ID: ${existingRole.id})`);
        
        if (existingRole.name !== roleConfig.name) {
          console.log(`   ℹ️  Note: Le rôle s'appelle "${existingRole.name}" et pas "${roleConfig.name}"`);
        }
        
        const update = await question(`   Voulez-vous mettre à jour ses permissions/couleur ? (o/n): `);
        
        if (update.toLowerCase() === 'o' || update.toLowerCase() === 'oui') {
          await existingRole.edit({
            color: roleConfig.color,
            permissions: roleConfig.permissions,
            reason: roleConfig.reason
          });
          console.log(`   ✅ Permissions et couleur mises à jour\n`);
        } else {
          console.log(`   ⏭️  Rôle conservé tel quel\n`);
        }
        
        createdRoles[roleConfig.envVar] = existingRole.id;
        continue;
      }

      // Créer le rôle
      const newRole = await guild.roles.create({
        name: roleConfig.name,
        color: roleConfig.color,
        permissions: roleConfig.permissions,
        reason: roleConfig.reason,
        mentionable: true
      });

      console.log(`✅ Rôle "${roleConfig.name}" créé (ID: ${newRole.id})`);
      createdRoles[roleConfig.envVar] = newRole.id;

    } catch (error) {
      console.error(`❌ Erreur lors de la création du rôle "${roleConfig.name}":`, error.message);
    }
  }

  console.log('\n─────────────────────────────────────────────────────────────\n');
  console.log('📝 IDs des rôles créés:\n');

  // Afficher les IDs à ajouter dans .env
  let envContent = '';
  for (const [envVar, roleId] of Object.entries(createdRoles)) {
    console.log(`${envVar}=${roleId}`);
    envContent += `${envVar}=${roleId}\n`;
  }

  console.log('\n─────────────────────────────────────────────────────────────\n');
  console.log('📋 Copiez ces lignes dans votre fichier .env\n');

  const saveToFile = await question('Voulez-vous que je mette à jour automatiquement .env ? (o/n): ');

  if (saveToFile.toLowerCase() === 'o' || saveToFile.toLowerCase() === 'oui') {
    const fs = await import('fs');
    
    let currentEnv = '';
    if (fs.existsSync('.env')) {
      currentEnv = fs.readFileSync('.env', 'utf-8');
    }

    // Mettre à jour ou ajouter les variables
    for (const [envVar, roleId] of Object.entries(createdRoles)) {
      const regex = new RegExp(`^${envVar}=.*$`, 'm');
      if (regex.test(currentEnv)) {
        currentEnv = currentEnv.replace(regex, `${envVar}=${roleId}`);
      } else {
        currentEnv += `\n${envVar}=${roleId}`;
      }
    }

    fs.writeFileSync('.env', currentEnv.trim() + '\n');
    console.log('\n✅ Fichier .env mis à jour !\n');
  }

  console.log('─────────────────────────────────────────────────────────────\n');  console.log('📢 Création du channel de commandes...\n');

  // Créer le channel pour les commandes du bot
  let commandsChannel = guild.channels.cache.find(ch => ch.name === '🤖│commandes-jr');
  
  if (commandsChannel) {
    console.log(`✅ Channel trouvé: #${commandsChannel.name} (ID: ${commandsChannel.id})`);
  } else {
    try {
      commandsChannel = await guild.channels.create({
        name: '🤖│commandes-jr',
        type: ChannelType.GuildText,
        topic: 'Channel dédié aux commandes du bot JR (!vote, !roulette-russe, etc.)',
        reason: 'Channel pour les interactions avec le bot'
      });
      console.log(`✅ Channel créé: #${commandsChannel.name} (ID: ${commandsChannel.id})\n`);
    } catch (error) {
      console.error('❌ Erreur lors de la création du channel:', error.message);
    }
  }

  if (commandsChannel) {
    // Configurer les permissions : seuls les Éxilés peuvent voir ce channel
    const exilesRoleId = createdRoles['EXILES_ROLE_ID'];
    
    if (exilesRoleId) {
      try {
        // Bloquer @everyone
        await commandsChannel.permissionOverwrites.edit(guild.roles.everyone, {
          ViewChannel: false
        });
        
        // Autoriser uniquement les Éxilés
        await commandsChannel.permissionOverwrites.edit(exilesRoleId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AddReactions: true
        });
        
        console.log('✅ Permissions configurées : seuls les Éxilés peuvent accéder au channel\n');
      } catch (error) {
        console.error('❌ Erreur lors de la configuration des permissions:', error.message);
      }
    }
    
    // Ajouter l'ID au .env
    const fs = await import('fs');
    let currentEnv = fs.readFileSync('.env', 'utf-8');
    const regex = new RegExp(`^COMMANDS_CHANNEL_ID=.*$`, 'm');
    if (regex.test(currentEnv)) {
      currentEnv = currentEnv.replace(regex, `COMMANDS_CHANNEL_ID=${commandsChannel.id}`);
    } else {
      currentEnv += `\nCOMMANDS_CHANNEL_ID=${commandsChannel.id}`;
    }
    fs.writeFileSync('.env', currentEnv.trim() + '\n');
    console.log('✅ COMMANDS_CHANNEL_ID ajouté au .env\n');
  }

  console.log('─────────────────────────────────────────────────────────────\n');  console.log('📚 Configuration des permissions par channel:\n');
  console.log('Pour le rôle "Rapatrié", pensez à :\n');
  console.log('1. Aller dans les paramètres de chaque channel privé');
  console.log('2. Ajouter le rôle "Rapatrié"');
  console.log('3. Désactiver ces permissions :');
  console.log('   - ❌ Envoyer des messages');
  console.log('   - ❌ Ajouter des réactions');
  console.log('   - ❌ Utiliser les commandes slash');
  console.log('\n─────────────────────────────────────────────────────────────\n');

  console.log('✅ Configuration terminée !\n');
  console.log('🚀 Vous pouvez maintenant lancer le bot avec: npm start\n');

  rl.close();
  await client.destroy();
  process.exit(0);
}

// Gestion des erreurs
setupRoles().catch(error => {
  console.error('\n❌ Erreur:', error);
  rl.close();
  process.exit(1);
});
