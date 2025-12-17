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
    this.tasks = [];
  }

  /**
   * Démarre toutes les tâches planifiées
   */
  start() {
    logger.info('📅 Démarrage du scheduler...');

    // Kick des non-Exilés (23h42)
    this.scheduleNonExilesCleanup();

    logger.info(`${this.tasks.length} tâche(s) planifiée(s)`);
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
    const condamneRoleId = config.get('roles.condamneRoleId');
    
    if (!exilesRoleId || exilesRoleId.includes('REMPLACER')) {
      logger.warn('Role Exilés non configuré, skip du kick');
      return;
    }

    try {
      // Fetch les membres avec un try/catch pour éviter les rate limits
      try {
        await this.guild.members.fetch();
      } catch (fetchError) {
        logger.warn('Rate limit lors du fetch des membres, utilisation du cache');
      }
      
      const members = this.guild.members.cache;
      let kickCount = 0;
      let errorCount = 0;
      const kickedMembers = []; // Liste des victimes

      for (const [id, member] of members) {
        // Ne pas kicker les bots
        if (member.user.bot) continue;

        // Vérifier si le membre a le rôle Exilés
        const hasExilesRole = member.roles.cache.has(exilesRoleId);
        
        // Vérifier si le membre a le rôle Condamné (en attente de vote)
        const hasCondamneRole = condamneRoleId && member.roles.cache.has(condamneRoleId);

        // Ne pas kicker si le membre a le rôle Exilés OU Condamné
        if (!hasExilesRole && !hasCondamneRole) {
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
