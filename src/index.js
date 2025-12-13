import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import dotenv from 'dotenv';
import config from './config/ConfigManager.js';
import logger from './utils/Logger.js';
import ModerationGuard from './modules/ModerationGuard.js';
import SummaryManager from './modules/SummaryManager.js';
import Scheduler from './modules/Scheduler.js';

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
        GatewayIntentBits.GuildMessageReactions
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
    this.client.once('ready', () => this.onReady());

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

    // Récupérer le channel de logs
    const logChannelId = config.get('server.logChannelId');
    if (logChannelId && !logChannelId.includes('REMPLACER')) {
      this.logChannel = this.guild.channels.cache.get(logChannelId);

      if (this.logChannel) {
        logger.setLogChannel(this.logChannel);
        logger.info(`📝 Channel de logs configuré: #${this.logChannel.name}`);
      } else {
        logger.warn(`Channel de logs ${logChannelId} introuvable - Logs Discord désactivés`);
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
      
      // Ajouter le summaryManager au scheduler si disponible
      if (this.summaryManager) {
        this.scheduler.setSummaryManager(this.summaryManager);
      }
      
      this.scheduler.start();
      logger.info('Scheduler initialisé');

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

    // Ignorer les messages hors du serveur
    if (!message.guild || message.guild.id !== this.guild.id) return;

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
      color: 0x3498db,
      title: '📚 Commandes disponibles',
      fields: [
        {
          name: '!résumé [nombre]',
          value: 'Génère un résumé des derniers messages du channel (par défaut: 100)',
          inline: false
        },
        {
          name: '!status',
          value: 'Affiche l\'état du bot et les statistiques',
          inline: false
        },
        {
          name: '!config',
          value: 'Affiche la configuration actuelle (modérateurs uniquement)',
          inline: false
        },
        {
          name: '!help',
          value: 'Affiche cette aide',
          inline: false
        }
      ],
      footer: { text: 'Bot Guardian - Protection et résumés IA' },
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
            this.moderationGuard ? 'Protection' : 'Protection',
            this.summaryManager ? 'Résumés IA' : 'Résumés IA',
            this.scheduler ? 'Scheduler' : 'Scheduler'
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
            `Activé: ${summaryConfig.enabled ? 'Oui' : 'Non'}`,
            `Messages max: ${summaryConfig.maxMessages}`,
            `Seuil auto: ${summaryConfig.autoTriggerThreshold}`,
            `Planifications: ${summaryConfig.scheduledTimes.length}/jour`
          ].join('\n'),
          inline: true
        }
      ],
      footer: { text: 'Modifiez config.json pour changer ces paramètres' },
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
  bot.client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('🛑 Arrêt du bot...');
  bot.client.destroy();
  process.exit(0);
});

export default bot;
