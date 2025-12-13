import cron from 'node-cron';
import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';

/**
 * Scheduler pour les tâches automatiques
 */
class Scheduler {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;
    this.summaryManager = null;
    this.moderationGuard = null;

    this.tasks = [];
  }

  /**
   * Définit le SummaryManager
   */
  setSummaryManager(summaryManager) {
    this.summaryManager = summaryManager;
  }

  /**
   * Définit le ModerationGuard
   */
  setModerationGuard(moderationGuard) {
    this.moderationGuard = moderationGuard;
  }

  /**
   * Démarre toutes les tâches planifiées
   */
  start() {
    logger.info('📅 Démarrage du scheduler...');

    // Résumés planifiés
    this.scheduleAISummaries();

    // Purge des logs
    this.scheduleLogPurge();

    // Reset des quotas de modération
    this.scheduleQuotaReset();

    // Nettoyage des validations expirées
    this.scheduleValidationCleanup();

    // Kick des non-Exilés (23h42)
    this.scheduleNonExilesCleanup();

    logger.info(`${this.tasks.length} tâche(s) planifiée(s)`);
  }

  /**
   * Planifie les résumés IA automatiques
   */
  scheduleAISummaries() {
    if (!this.summaryManager || !config.get('summary.enabled')) {
      logger.info('Résumés automatiques désactivés');
      return;
    }

    const scheduledTimes = config.get('summary.scheduledTimes') || [];

    for (const time of scheduledTimes) {
      // Convertir le format "HH:mm" en cron
      const [hour, minute] = time.split(':');
      const cronExpression = `${minute} ${hour} * * *`;

      const task = cron.schedule(cronExpression, async () => {
        logger.info(`Exécution des résumés planifiés (${time})...`);
        
        try {
          if (this.summaryManager) {
            await this.summaryManager.generateScheduledSummaries();
          }
        } catch (error) {
          logger.error('Erreur lors des résumés planifiés:', error);
        }
      });

      this.tasks.push({
        name: `Résumés IA (${time})`,
        schedule: cronExpression,
        task: task
      });

      logger.info(`  ✓ Résumés planifiés à ${time}`);
    }
  }

  /**
   * Planifie la purge des anciens logs
   */
  scheduleLogPurge() {
    const retentionDays = config.get('logging.retentionDays') || 30;

    // Purge tous les jours à 3h du matin
    const task = cron.schedule('0 3 * * *', async () => {
      logger.info('🧹 Purge des anciens logs...');
      
      try {
        await logger.purgeOldLogs(retentionDays);
      } catch (error) {
        logger.error('Erreur lors de la purge des logs:', error);
      }
    });

    this.tasks.push({
      name: 'Purge des logs',
      schedule: '0 3 * * *',
      task: task
    });

    logger.info(`  ✓ Purge des logs planifiée (conservation: ${retentionDays} jours)`);
  }

  /**
   * Planifie le reset des quotas de modération
   */
  scheduleQuotaReset() {
    // Reset des quotas quotidiens à minuit
    const task = cron.schedule('0 0 * * *', async () => {
      logger.info('Reset des quotas de modération...');
      
      try {
        if (this.moderationGuard) {
          this.moderationGuard.resetQuotas();
        }
      } catch (error) {
        logger.error('Erreur lors du reset des quotas:', error);
      }
    });

    this.tasks.push({
      name: 'Reset quotas',
      schedule: '0 0 * * *',
      task: task
    });

    logger.info('  ✓ Reset quotas planifié (minuit)');
  }

  /**
   * Planifie le nettoyage des validations expirées
   */
  scheduleValidationCleanup() {
    // Nettoyage toutes les 5 minutes
    const task = cron.schedule('*/5 * * * *', async () => {
      try {
        if (this.moderationGuard && this.moderationGuard.validationSystem) {
          this.moderationGuard.validationSystem.cleanupExpiredValidations();
        }
      } catch (error) {
        logger.error('Erreur lors du nettoyage des validations:', error);
      }
    });

    this.tasks.push({
      name: 'Nettoyage validations',
      schedule: '*/5 * * * *',
      task: task
    });

    logger.info('  ✓ Nettoyage validations planifié (toutes les 5 min)');
  }

  /**
   * Planifie le kick des non-Exilés
   */
  scheduleNonExilesCleanup() {
    const cleanupConfig = config.get('cleanup');
    if (!cleanupConfig || !cleanupConfig.enabled || !cleanupConfig.kickNonExiles) {
      logger.info('Kick des non-Exilés désactivé');
      return;
    }

    const cronTime = cleanupConfig.cronTime || '42 23 * * *'; // Par défaut 23h42

    const task = cron.schedule(cronTime, async () => {
      logger.info('🧹 Nettoyage : Kick des non-Exilés...');
      
      try {
        await this.kickNonExiles();
      } catch (error) {
        logger.error('Erreur lors du kick des non-Exilés:', error);
      }
    });

    this.tasks.push({
      name: 'Kick non-Exilés',
      schedule: cronTime,
      task: task
    });

    logger.info(`  ✓ Kick des non-Exilés planifié (${cronTime})`);
  }

  /**
   * Kick tous les membres qui n'ont pas le rôle Exilés
   */
  async kickNonExiles() {
    const exilesRoleId = config.get('roles.exilesRoleId');
    if (!exilesRoleId || exilesRoleId.includes('REMPLACER')) {
      logger.warn('Role Exilés non configuré, skip du kick');
      return;
    }

    try {
      await this.guild.members.fetch();
      
      const members = this.guild.members.cache;
      let kickCount = 0;
      let errorCount = 0;
      const kickedMembers = []; // Liste des victimes

      for (const [id, member] of members) {
        // Ne pas kicker les bots
        if (member.user.bot) continue;

        // Vérifier si le membre a le rôle Exilés
        const hasExilesRole = member.roles.cache.has(exilesRoleId);

        if (!hasExilesRole) {
          try {
            await member.kick('🧹 Nettoyage automatique : Rôle Exilés requis');
            kickCount++;
            kickedMembers.push(member.user.tag);
            logger.info(`Kicked ${member.user.tag} (pas de rôle Exilés)`);
            
            // Attendre un peu entre chaque kick
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            errorCount++;
            logger.error(`Erreur lors du kick de ${member.user.tag}:`, error);
          }
        }
      }

      // Envoyer un message personnalisé dans le channel spécifique
      try {
        const notifChannel = this.guild.channels.cache.get('1449465985198330032');

        if (notifChannel) {
          let message;
          if (kickCount > 0) {
            const victimesList = kickedMembers.map(tag => `• ${tag}`).join('\n');
            message = `**La purge des Exilés a été lancée !**\n\n**Victimes (${kickCount}) :**\n${victimesList}`;
          } else {
            message = `**La purge des Exilés a été lancée !**\n\nAucune victime ce soir, tous les membres ont le rôle Exilés.`;
          }

          await notifChannel.send(message);
          logger.info(`Message de purge envoyé dans #${notifChannel.name}`);
        } else {
          logger.warn('Channel de notification de purge introuvable (ID: 1449465985198330032)');
        }
      } catch (error) {
        logger.error('Erreur lors de l\'envoi du message de purge:', error);
      }

      await logger.security('Nettoyage des non-Exilés terminé', {
        kickCount: kickCount,
        errorCount: errorCount,
        totalMembers: members.size
      }, kickCount > 0 ? 'medium' : 'low');

    } catch (error) {
      logger.error('Erreur lors du nettoyage des non-Exilés:', error);
    }
  }

  /**
   * Arrête toutes les tâches planifiées
   */
  stop() {
    logger.info('Arrêt du scheduler...');

    for (const scheduledTask of this.tasks) {
      scheduledTask.task.stop();
    }

    this.tasks = [];
    logger.info('Scheduler arrêté');
  }

  /**
   * Liste toutes les tâches planifiées
   */
  listTasks() {
    return this.tasks.map(t => ({
      name: t.name,
      schedule: t.schedule
    }));
  }
}

export default Scheduler;
