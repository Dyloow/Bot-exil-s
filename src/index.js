import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import dotenv from 'dotenv';
import config from './config/ConfigManager.js';
import logger from './utils/Logger.js';
import ModerationGuard from './modules/ModerationGuard.js';
import SummaryManager from './modules/SummaryManager.js';
import Scheduler from './modules/Scheduler.js';
import VoteSystem from './modules/VoteSystem.js';
import SalaryChecker from './modules/SalaryChecker.js';
import RouletteRusse from './modules/RouletteRusse.js';
import RandomIntervention from './modules/RandomIntervention.js';

// Charger les variables d'environnement
dotenv.config();

/**
 * Classe principale du bot Discord
 */
class DiscordBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages
      ],
      partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
      ]
    });

    // Collections pour stocker les commandes et les cooldowns
    this.client.commands = new Collection();
    this.client.cooldowns = new Collection();

    // Modules du bot
    this.moderationGuard = null;
    this.summaryManager = null;
    this.scheduler = null;
    this.voteSystem = null;
    this.salaryChecker = null;
    this.rouletteRusse = null;
    this.randomIntervention = null;

    // État du bot
    this.ready = false;
    this.guild = null;
    this.logChannel = null;
  }

  /**
   * Initialise le bot
   */
  async start() {
    try {
      // Valider la configuration
      if (!config.validate()) {
        logger.error('Configuration invalide. Arrêt du bot.');
        process.exit(1);
      }

      // Vérifier le token Discord
      if (!process.env.DISCORD_TOKEN) {
        logger.error('DISCORD_TOKEN manquant dans .env');
        process.exit(1);
      }

      // Vérifier la clé OpenAI
      if (!process.env.OPENAI_API_KEY) {
        logger.warn('OPENAI_API_KEY manquant - Les résumés IA seront désactivés');
      }

      // Configurer les événements
      this.setupEvents();

      // Connexion à Discord
      logger.info('🚀 Connexion au bot Discord...');
      await this.client.login(process.env.DISCORD_TOKEN);

    } catch (error) {
      logger.error('Erreur lors du démarrage du bot:', error);
      process.exit(1);
    }
  }

  /**
   * Configure tous les événements du bot
   */
  setupEvents() {
    // Événement: Bot prêt
    this.client.once('clientReady', () => this.onReady());

    // Événement: Erreur
    this.client.on('error', error => {
      logger.error('Erreur Discord.js:', error);
    });

    // Événement: Avertissement
    this.client.on('warn', warning => {
      logger.warn('Avertissement Discord.js:', { warning });
    });

    // Événement: Message
    this.client.on('messageCreate', message => this.onMessage(message));

    // Événement: Interactions (boutons)
    this.client.on('interactionCreate', interaction => this.onInteraction(interaction));

    // Événements de modération
    this.client.on('guildBanAdd', ban => this.onBanAdd(ban));
    this.client.on('guildBanRemove', ban => this.onBanRemove(ban));
    this.client.on('guildMemberRemove', member => this.onMemberRemove(member));
    this.client.on('guildMemberAdd', member => this.onMemberAdd(member));
    this.client.on('messageDelete', message => this.onMessageDelete(message));
    this.client.on('messageDeleteBulk', messages => this.onMessageBulkDelete(messages));
    this.client.on('guildMemberUpdate', (oldMember, newMember) => 
      this.onMemberUpdate(oldMember, newMember)
    );
  }

  /**
   * Événement: Bot prêt
   */
  async onReady() {
    logger.info(`Bot connecté en tant que ${this.client.user.tag}`);

    // Récupérer le serveur
    const guildId = config.get('server.guildId');
    this.guild = this.client.guilds.cache.get(guildId);

    if (!this.guild) {
      logger.error(`Serveur ${guildId} introuvable`);
      process.exit(1);
    }

    logger.info(`Serveur: ${this.guild.name}`);

    // Fetch les membres pour remplir le cache (évite les rate limits plus tard)
    try {
      await this.guild.members.fetch();
      logger.info(`${this.guild.memberCount} membres en cache`);
    } catch (error) {
      logger.warn('Impossible de fetch tous les membres:', error.message);
    }

    // Récupérer le channel de logs
    const logTalkId = config.get('server.logTalkId');
    if (logTalkId && !logTalkId.includes('REMPLACER')) {
      this.logChannel = this.guild.channels.cache.get(logTalkId);

      if (this.logChannel) {
        logger.setLogChannel(this.logChannel);
        logger.info(`📝 Channel de logs configuré: #${this.logChannel.name}`);
      } else {
        logger.warn(`Channel de logs ${logTalkId} introuvable - Logs Discord désactivés`);
      }
    } else {
      logger.warn('Channel de logs non configuré - Logs Discord désactivés');
    }

    // Initialiser les modules
    await this.initializeModules();

    // Définir le statut
    this.client.user.setPresence({
      activities: [{ name: 'Protection du serveur' }],
      status: 'online'
    });

    this.ready = true;
    logger.info('Bot opérationnel');

    // Log de sécurité
    await logger.security('Bot démarré', {
      guild: this.guild.name,
      memberCount: this.guild.memberCount
    }, 'low');
  }

  /**
   * Initialise tous les modules du bot
   */
  async initializeModules() {
    try {
      // Module de protection contre les abus
      this.moderationGuard = new ModerationGuard(this.client, this.guild);
      logger.info('Module ModerationGuard initialisé');

      // Module de résumés IA
      if (process.env.OPENAI_API_KEY) {
        this.summaryManager = new SummaryManager(this.client, this.guild);
        logger.info('Module SummaryManager initialisé');
      }

      // Scheduler pour tâches automatiques
      this.scheduler = new Scheduler(this.client, this.guild);
      this.scheduler.start();
      logger.info('Scheduler initialisé');

      // Système de vote pour attribution du rôle Exilé
      this.voteSystem = new VoteSystem(this.client, this.guild);
      logger.info('Module VoteSystem initialisé');

      // Système de comparaison de salaires
      this.salaryChecker = new SalaryChecker(logger, config);
      await this.salaryChecker.initialize(this.client);
      logger.info('Module SalaryChecker initialisé');
      // Système de roulette russe
      this.rouletteRusse = new RouletteRusse(this.client, this.guild);
      logger.info('Module RouletteRusse initialisé');

      // Interventions aléatoires du bot dans les conversations
      this.randomIntervention = new RandomIntervention(this.client);
      logger.info('Module RandomIntervention initialisé');

    } catch (error) {
      logger.error('Erreur lors de l\'initialisation des modules:', error);
    }
  }

  /**
   * Gestion des messages
   */
  async onMessage(message) {
    // Ignorer les messages du bot
    if (message.author.bot) return;

    // Gérer les messages privés (DMs)
    if (!message.guild) {
      await this.handleDirectMessage(message);
      return;
    }

    // Ignorer les messages hors du serveur
    if (message.guild.id !== this.guild.id) return;

    // Intervention aléatoire du bot (ne se déclenche que rarement)
    if (this.randomIntervention) {
      await this.randomIntervention.handleMessage(message);
    }

    // Vérifier si le message contient @everyone
    if (message.mentions.everyone && this.voteSystem) {
      logger.info(`@everyone détecté de ${message.author.tag}`);
      
      // Vérifier si on est dans le bon channel
      const commandsChannelId = config.get('server.commandsChannelId');
      if (commandsChannelId && message.channel.id !== commandsChannelId) {
        const commandsChannel = this.guild.channels.cache.get(commandsChannelId);
        await message.reply(`🚨 T'as @everyone tout le monde connard, un vote kick a été lancé dans ${commandsChannel}.`);
        
        // Lancer le vote kick automatique (définitif) dans le bon channel
        await this.voteSystem.startVoteKickEveryone(message.member, commandsChannel, message);
      } else {
        // Lancer un vote kick automatique (définitif) dans le channel actuel
        await this.voteSystem.startVoteKickEveryone(message.member, message.channel, message);
      }
      return; // Ne pas traiter d'autres commandes
    }

    // Mettre en cache le message pour restauration éventuelle
    if (this.moderationGuard) {
      this.moderationGuard.cacheMessage(message);
    }

    // Commandes
    if (message.content.startsWith('!')) {
      await this.handleCommand(message);
    }

    // Vérifier le seuil automatique pour les résumés
    if (this.summaryManager) {
      await this.summaryManager.checkAutoTrigger(message.channel);
    }
  }

  /**
   * Gestion des messages privés (DMs)
   */
  async handleDirectMessage(message) {
    logger.info(`Message privé reçu de ${message.author.tag} (${message.author.id}): "${message.content}"`);
    
    // Vérifier que c'est l'utilisateur autorisé
    const authorizedUserId = '266314146470035456';
    if (message.author.id !== authorizedUserId) {
      logger.warn(`Utilisateur non autorisé: ${message.author.tag}`);
      await message.reply('❌ Vous n\'êtes pas autorisé à utiliser les commandes privées.');
      return;
    }

    // Vérifier si c'est une commande
    if (!message.content.startsWith('!')) {
      logger.info('Message sans commande, ignoré');
      return;
    }

    const args = message.content.slice(1).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    if (commandName === 'prompt') {
      // Extraire le message avec format: !prompt [messageId] "message"
      const fullMessage = message.content.slice(1).trim(); // Retirer le !
      
      // Tenter de matcher avec ID de message: prompt MESSAGE_ID "text" ou prompt MESSAGE_ID text
      let messageIdMatch = fullMessage.match(/^prompt\s+(\d+)\s+["'](.+)["']$/s);
      if (!messageIdMatch) {
        messageIdMatch = fullMessage.match(/^prompt\s+(\d+)\s+(.+)$/s);
      }
      
      // Ou sans ID: prompt "text" ou prompt text
      let simpleMatch = fullMessage.match(/^prompt\s+["'](.+)["']$/s) || fullMessage.match(/^prompt\s+(.+)$/s);
      
      let messageId = null;
      let messageToSend = null;
      
      if (messageIdMatch && messageIdMatch[1] && messageIdMatch[2]) {
        // Format avec ID de message
        messageId = messageIdMatch[1];
        messageToSend = messageIdMatch[2];
      } else if (simpleMatch && simpleMatch[1]) {
        // Format simple sans ID
        messageToSend = simpleMatch[1];
      } else {
        await message.reply('❌ Format invalide.\nUtilisez: `!prompt "votre message"` ou `!prompt MESSAGE_ID "votre message"`');
        return;
      }

      try {
        // Récupérer le channel de log (on l'utilise comme channel général)
        const logTalkId = config.get('server.logTalkId');
        logger.info(`logTalkId configuré: ${logTalkId}`);
        
        if (!logTalkId || logTalkId === 'FROM_ENV') {
          await message.reply('❌ Channel général non configuré dans .env (LOG_TALK_ID).');
          return;
        }

        const targetChannel = this.guild.channels.cache.get(logTalkId);
        logger.info(`Channel trouvé: ${targetChannel ? targetChannel.name : 'NULL'}`);
        
        if (!targetChannel) {
          await message.reply(`❌ Channel général introuvable. ID: ${logTalkId}\nVérifiez que l'ID est correct et que le bot a accès à ce channel.`);
          return;
        }

        // Convertir les @username en vraies mentions <@ID>
        messageToSend = await this.convertMentions(messageToSend);

        // Si un ID de message est fourni, répondre à ce message
        if (messageId) {
          try {
            const targetMessage = await targetChannel.messages.fetch(messageId);
            await targetMessage.reply(messageToSend);
            await message.reply(`✅ Réponse envoyée au message ID ${messageId}.`);
          } catch (error) {
            logger.error(`Erreur lors de la récupération du message ${messageId}:`, error);
            await message.reply(`❌ Message avec l'ID ${messageId} introuvable.`);
            return;
          }
        } else {
          // Sinon, envoyer un message normal
          await targetChannel.send(messageToSend);
          await message.reply('✅ Message envoyé avec succès dans le channel général.');
        }

        logger.info(`Message prompt envoyé par ${message.author.tag}: "${messageToSend}"${messageId ? ` (réponse à ${messageId})` : ''}`);

      } catch (error) {
        logger.error('Erreur lors de l\'envoi du prompt:', error);
        await message.reply('❌ Erreur lors de l\'envoi du message.');
      }
    }
  }

  /**
   * Convertit les @username en vraies mentions <@ID>
   */
  async convertMentions(text) {
    // Regex pour détecter @username (sans espace dans le username)
    const mentionRegex = /@(\w+)/g;
    let result = text;
    const matches = [...text.matchAll(mentionRegex)];

    for (const match of matches) {
      const username = match[1];
      
      // Chercher le membre dans le serveur par username (case insensitive)
      const member = this.guild.members.cache.find(
        m => m.user.username.toLowerCase() === username.toLowerCase()
      );

      if (member) {
        // Remplacer @username par <@ID>
        result = result.replace(match[0], `<@${member.id}>`);
        logger.info(`Mention convertie: @${username} -> <@${member.id}>`);
      }
    }

    return result;
  }

  /**
   * Gestion des interactions (boutons, menus, etc.)
   */
  async onInteraction(interaction) {
    try {
      if (interaction.isButton()) {
        // Gérer les votes (admission et kick)
        if (this.voteSystem && (interaction.customId.startsWith('vote_') || interaction.customId.startsWith('votekick_'))) {
          await this.voteSystem.handleVote(interaction);
        }
      }
    } catch (error) {
      logger.error('Erreur lors de la gestion de l\'interaction:', error);
    }
  }

  /**
   * Gestion des commandes
   */
  async handleCommand(message) {
    const args = message.content.slice(1).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    try {
      switch (commandName) {
        case 'resume':
        case 'résumé':
        case 'summary':
          if (this.summaryManager) {
            await this.summaryManager.generateSummaryCommand(message, args);
          } else {
            await message.reply('Les résumés IA ne sont pas disponibles (clé API manquante).');
          }
          break;

        case 'help':
        case 'aide':
          await this.showHelp(message);
          break;

        case 'status':
          await this.showStatus(message);
          break;

        case 'config':
          await this.showConfig(message);
          break;

        case 'test-kick':
          // Vérifier si l'auteur a le rôle Exilés
          const exilesRoleId = config.get('roles.exilesRoleId');
          const member = message.member;
          
          if (!member.roles.cache.has(exilesRoleId)) {
            await message.reply('Vous devez avoir le rôle Exilés pour utiliser cette commande.');
            return;
          }

          await message.reply('🧪 **Test du kick des non-Exilés...**\n\nExécution en cours...');
          
          try {
            await this.scheduler.kickNonExiles();
            await message.reply('**Test terminé !** Vérifiez les logs de la console pour les détails.');
          } catch (error) {
            logger.error('Erreur test-kick:', error);
            await message.reply('Erreur lors du test : ' + error.message);
          }
          break;

        case 'vote':
          if (!this.voteSystem) {
            await message.reply('❌ Système de vote non disponible.');
            return;
          }

          // Récupérer le membre mentionné
          const mentionedMember = message.mentions.members.first();

          if (!mentionedMember) {
            await message.reply('❌ Vous devez mentionner un membre. Exemple: `!vote @pseudo`');
            return;
          }

          // Vérifier que ce n'est pas un bot
          if (mentionedMember.user.bot) {
            await message.reply('❌ Impossible de voter pour un bot.');
            return;
          }

          // Rediriger vers le channel des commandes si configuré
          const commandsChannelId = config.get('server.commandsChannelId');
          if (commandsChannelId) {
            const commandsChannel = this.guild.channels.cache.get(commandsChannelId);
            if (commandsChannel && message.channel.id !== commandsChannelId) {
              await message.reply(`✅ Le vote se déroulera dans ${commandsChannel}.`);
              await this.voteSystem.startVote(message.member, mentionedMember, commandsChannel);
              return;
            }
          }

          // Lancer le vote dans le channel actuel si pas de channel dédié
          await this.voteSystem.startVote(message.member, mentionedMember, message.channel);
          break;

        case 'vote-kick':
          if (!this.voteSystem) {
            await message.reply('❌ Système de vote non disponible.');
            return;
          }

          // Récupérer le membre mentionné
          const kickTarget = message.mentions.members.first();

          if (!kickTarget) {
            await message.reply('❌ Vous devez mentionner un membre. Exemple: `!vote-kick @pseudo`');
            return;
          }

          // Vérifier que ce n'est pas un bot
          if (kickTarget.user.bot) {
            await message.reply('❌ Impossible de lancer un vote-kick pour un bot.');
            return;
          }

          // Vérifier que ce n'est pas soi-même
          if (kickTarget.id === message.author.id) {
            await message.reply('❌ Impossible de lancer un vote-kick contre soi-même.');
            return;
          }

          // Rediriger vers le channel des commandes si configuré
          const vkCommandsChannelId = config.get('server.commandsChannelId');
          if (vkCommandsChannelId) {
            const vkCommandsChannel = this.guild.channels.cache.get(vkCommandsChannelId);
            if (vkCommandsChannel && message.channel.id !== vkCommandsChannelId) {
              await message.reply(`✅ Le vote-kick se déroulera dans ${vkCommandsChannel}.`);
              await this.voteSystem.startVoteKickManual(message.member, kickTarget, vkCommandsChannel);
              return;
            }
          }

          // Lancer le vote kick manuel (temporaire) dans le channel actuel si pas de channel dédié
          await this.voteSystem.startVoteKickManual(message.member, kickTarget, message.channel);
          break;

        case 'check_hess':
          if (this.salaryChecker) {
            await this.salaryChecker.handleCheckHessCommand(message, args);
          } else {
            await message.reply('❌ Le système de comparaison de salaires n\'est pas disponible.');
          }
          break;

        case 'add_salary':
          if (this.salaryChecker) {
            await this.salaryChecker.handleAddSalaryCommand(message, args);
          } else {
            await message.reply('❌ Le système de comparaison de salaires n\'est pas disponible.');
          }
          break;

        case 'list_salaries':
          if (this.salaryChecker) {
            await this.salaryChecker.handleListSalariesCommand(message);
          } else {
            await message.reply('❌ Le système de comparaison de salaires n\'est pas disponible.');
          }
          break;

        case 'roulette-russe':
        case 'roulette':
        case 'rr':
          if (!this.rouletteRusse) {
            await message.reply('❌ Système de roulette russe non disponible.');
            return;
          }

          // Lancer la roulette russe pour le membre qui utilise la commande
          await this.rouletteRusse.play(message.member, message.channel);
          break;

        case 'remind':
          if (this.salaryChecker) {
            await this.salaryChecker.handleRemindCommand(message, args);
          } else {
            await message.reply('❌ Le système de comparaison de salaires n\'est pas disponible.');
          }
          break;

        default:
          // Commande inconnue - ignorer silencieusement
          break;
      }
    } catch (error) {
      logger.error(`Erreur lors de l'exécution de la commande ${commandName}:`, error);
      await message.reply('Une erreur est survenue lors de l\'exécution de la commande.');
    }
  }

  /**
   * Affiche l'aide
   */
  async showHelp(message) {
    const embed = {
      color: 0xFF0000,
      title: '📚 Commandes JR - La Table des Éxilés',
      description: 'Voici toutes les commandes disponibles. Les commandes peuvent être utilisées partout, les votes se dérouleront automatiquement dans le channel dédié.',
      fields: [
        {
          name: '🗳️ **Système de Vote**',
          value: '`!vote @membre` - Lance un vote pour admettre quelqu\'un parmi les Éxilés (majorité >50%, 24h)\n' +
                '`!vote-kick @membre` - Lance un vote kick temporaire → Rapatrié pendant 1h (majorité >50%, 5min)\n' +
                '⚠️ Abus de @everyone → Vote kick automatique = exclusion DÉFINITIVE',
          inline: false
        },
        {
          name: '🎲 **Roulette Russe**',
          value: '`!roulette-russe` ou `!rr` - 1 chance sur 6 d\'être renommé avec un nom dégradant pendant 24h',
          inline: false
        },
        {
          name: '💬 **Résumés IA**',
          value: '`!résumé` - Résume les 100 derniers messages, par sujets\n' +
                '`!résumé 200` - Résume les 200 derniers messages (de 10 à 1000)\n' +
                '`!résumé 2h` ou `!résumé 1j` - Résume une durée (jusqu\'à 48h)',
          inline: false
        },
        {
          name: '💰 **Comparateur de Salaires**',
          value: '`!check_hess [pseudo]` - Compare combien un membre aurait gagné avec le salaire de référence\n' +
                '`!add_salary [montant]` - Définit ton salaire annuel\n' +
                '`!list_salaries` - Affiche tous les salaires enregistrés',
          inline: false
        },
        {
          name: '⚙️ **Informations**',
          value: '`!status` - État du bot et statistiques\n' +
                '`!config` - Configuration actuelle (Éxilés uniquement)\n' +
                '`!help` - Affiche cette aide',
          inline: false
        },
        {
          name: '🤖 **Fonctionnalités Automatiques**',
          value:'• Purge automatique quotidienne à 23h42 (kick des non-Éxilés)',
          inline: false
        }
      ],
      footer: { text: 'JR - Bot de La Table des Éxilés | Système de votes, roulette russe et résumés IA' },
      timestamp: new Date()
    };

    await message.reply({ embeds: [embed] });
  }

  /**
   * Affiche le statut
   */
  async showStatus(message) {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const embed = {
      color: 0x2ecc71,
      title: 'Statut du bot',
      fields: [
        {
          name: 'État',
          value: this.ready ? 'Opérationnel' : 'Initialisation',
          inline: true
        },
        {
          name: 'Uptime',
          value: `${hours}h ${minutes}m`,
          inline: true
        },
        {
          name: 'Serveur',
          value: this.guild ? this.guild.name : 'N/A',
          inline: true
        },
        {
          name: 'Modules actifs',
          value: [
            `${this.moderationGuard ? '✅' : '❌'} Protection`,
            `${this.summaryManager ? '✅' : '❌'} Résumés IA`,
            `${this.scheduler ? '✅' : '❌'} Scheduler`,
            `${this.voteSystem ? '✅' : '❌'} Vote`,
            `${this.salaryChecker ? '✅' : '❌'} Comparateur de salaires`,
            `${this.rouletteRusse ? '✅' : '❌'} Roulette russe`,
            `${this.randomIntervention ? '✅' : '❌'} Intervention aléatoire`
          ].join('\n'),
          inline: false
        }
      ],
      timestamp: new Date()
    };

    await message.reply({ embeds: [embed] });
  }

  /**
   * Affiche la configuration (modérateurs uniquement)
   */
  async showConfig(message) {
    // Vérifier les permissions
    const member = message.guild.members.cache.get(message.author.id);
    if (!config.hasModerationPermissions(member)) {
      await message.reply('Vous n\'avez pas la permission d\'utiliser cette commande.');
      return;
    }

    const moderationConfig = config.get('moderation');
    const summaryConfig = config.get('summary');

    const embed = {
      color: 0x9b59b6,
      title: 'Configuration actuelle',
      fields: [
        {
          name: 'Modération',
          value: [
            `Actions/heure: ${moderationConfig.maxActionsPerHour}`,
            `Bans/jour: ${moderationConfig.maxBansPerDay}`,
            `Kicks/jour: ${moderationConfig.maxKicksPerDay}`,
            `Mode panique: ${moderationConfig.panicModeThreshold} actions`
          ].join('\n'),
          inline: true
        },
        {
          name: 'Résumés IA',
          value: [
            `Messages max: ${summaryConfig.maxMessages}`,
            `Cooldown: ${summaryConfig.cooldownSeconds}s`,
            `Images max: ${summaryConfig.maxImages}`,
            `Seuil auto: ${summaryConfig.autoTriggerThreshold}`
          ].join('\n'),
          inline: true
        }
      ],
      footer: { text: 'Modifiez src/config.json pour changer ces paramètres' },
      timestamp: new Date()
    };

    await message.reply({ embeds: [embed] });
  }

  // Événements de modération (délégués aux modules)
  async onBanAdd(ban) {
    if (this.moderationGuard) {
      await this.moderationGuard.handleBan(ban);
    }
  }

  async onBanRemove(ban) {
    if (this.moderationGuard) {
      await this.moderationGuard.handleUnban(ban);
    }
  }

  async onMemberRemove(member) {
    if (this.moderationGuard) {
      await this.moderationGuard.handleMemberRemove(member);
    }
  }

  async onMemberAdd(member) {
    // Déléguer au ModerationGuard pour gérer les retours d'Exilés
    if (this.moderationGuard) {
      await this.moderationGuard.handleMemberAdd(member);
    }
  }

  async onMessageDelete(message) {
    if (this.moderationGuard) {
      await this.moderationGuard.handleMessageDelete(message);
    }
  }

  async onMessageBulkDelete(messages) {
    if (this.moderationGuard) {
      await this.moderationGuard.handleBulkDelete(messages);
    }
  }

  async onMemberUpdate(oldMember, newMember) {
    // Bloquer les changements de nickname pendant la roulette russe
    if (this.rouletteRusse && oldMember.nickname !== newMember.nickname) {
      if (!this.rouletteRusse.canChangeNickname(newMember.id)) {
        // Obtenir le nom dégradant imposé
        const degradingName = this.rouletteRusse.getDegradingName(newMember.id);
        
        // Si le nouveau nom n'est PAS le nom dégradant, c'est une tentative de changement
        if (newMember.nickname !== degradingName) {
          try {
            // Restaurer le nom dégradant
            await newMember.setNickname(degradingName, 'Roulette russe - Changement bloqué');
            logger.info(`Changement de nickname bloqué pour ${newMember.user.tag} (roulette russe active)`);
          } catch (error) {
            logger.error('Erreur lors du blocage du changement de nickname:', error);
          }
        }
        // Sinon, c'est le bot qui vient de mettre le nom dégradant, on ignore
      }
    }

    if (this.moderationGuard) {
      await this.moderationGuard.handleMemberUpdate(oldMember, newMember);
    }
  }
}

// Créer et démarrer le bot
const bot = new DiscordBot();
bot.start();

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  logger.info('🛑 Arrêt du bot...');
  if (bot.salaryChecker) {
    bot.salaryChecker.destroy();
  }
  bot.client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('🛑 Arrêt du bot...');
  if (bot.salaryChecker) {
    bot.salaryChecker.destroy();
  }
  bot.client.destroy();
  process.exit(0);
});

export default bot;
