import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';

/**
 * Système simplifié de protection des Exilés
 * - Restauration des messages supprimés
 * - Remise du rôle Exilés après ban/kick
 */
class ModerationGuard {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;

    // Cache des messages récents pour restauration
    this.messageCache = new Map();

    // Tracking des invitations pour Exilés ban/kick
    // Map: userId -> { inviteCode, wasExile, timestamp, username }
    this.exileInviteTracking = new Map();

    // Initialiser le nettoyage périodique
    this.startCleanupInterval();
  }

  /**
   * Met en cache un message pour restauration éventuelle
   */
  cacheMessage(message) {
    if (!message || !message.content) return;
    
    this.messageCache.set(message.id, {
      content: message.content,
      author: message.author,
      channel: message.channel,
      timestamp: Date.now(),
      attachments: Array.from(message.attachments.values()),
      embeds: message.embeds
    });

    logger.info(`📝 Message mis en cache: ${message.id} (${message.author.tag})`);

    // Limiter la taille du cache (derniers 1000 messages)
    if (this.messageCache.size > 1000) {
      const firstKey = this.messageCache.keys().next().value;
      this.messageCache.delete(firstKey);
    }
  }

  /**
   * Vérifie si un membre a le rôle Exilés
   */
  isExile(member) {
    const exilesRoleId = config.get('roles.exilesRoleId');
    if (!exilesRoleId) return false;
    return member.roles.cache.has(exilesRoleId);
  }

  /**
   * Vérifie si un utilisateur a le rôle Exilés (par ID)
   */
  async isExileById(userId) {
    try {
      const member = await this.guild.members.fetch(userId);
      return this.isExile(member);
    } catch (error) {
      return false;
    }
  }

  /**
   * Nettoyage périodique des données de tracking
   */
  startCleanupInterval() {
    setInterval(() => {
      this.cleanupOldTracking();
    }, 300000); // Toutes les 5 minutes
  }

  /**
   * Nettoie les anciennes données de tracking
   */
  cleanupOldTracking() {
    const now = Date.now();
    const hourAgo = now - 3600000;

    // Nettoyer les vieux messages du cache
    for (const [id, data] of this.messageCache) {
      if (data.timestamp < hourAgo) {
        this.messageCache.delete(id);
      }
    }

    // Nettoyer les vieilles invitations (plus de 24h)
    const oneDayAgo = now - 86400000;
    for (const [userId, data] of this.exileInviteTracking) {
      if (data.timestamp < oneDayAgo) {
        this.exileInviteTracking.delete(userId);
        logger.info(`Tracking expiré pour ${data.username}`);
      }
    }
  }

  /**
   * Récupère l'exécuteur d'une action via les audit logs
   */
  async getActionExecutor(actionType, targetId = null) {
    try {
      console.log('  📋 Récupération audit logs, type:', actionType);
      
      const auditLogs = await this.guild.fetchAuditLogs({
        limit: 5,
        type: actionType
      });

      console.log('  📋 Audit logs récupérés:', auditLogs.entries.size, 'entrées');

      const entry = auditLogs.entries.first();
      
      if (!entry) {
        console.log('  Aucune entrée audit log trouvée');
        return null;
      }

      console.log('  📋 Première entrée:');
      console.log('    - Executor:', entry.executor.tag);
      console.log('    - Created:', new Date(entry.createdTimestamp).toISOString());
      console.log('    - Target:', entry.target ? entry.target.id : 'N/A');

      // Vérifier que l'action est récente (moins de 5 secondes)
      const now = Date.now();
      const age = now - entry.createdTimestamp;
      console.log('    - Age:', age, 'ms');
      
      if (age > 5000) {
        console.log('  Audit log trop ancien');
        logger.warn(`Audit log trop ancien: ${age}ms`);
        return null;
      }

      // Pour les suppressions de messages, on ne vérifie pas le targetId
      // car Discord ne le fournit pas toujours de manière fiable
      if (actionType === 72 || actionType === 73) {
        console.log('  Suppression de message, on accepte');
        // MESSAGE_DELETE ou MESSAGE_BULK_DELETE
        return {
          executor: entry.executor,
          reason: entry.reason || 'Aucune raison fournie',
          timestamp: entry.createdTimestamp
        };
      }

      // Vérifier la cible si spécifiée (pour les autres actions)
      if (targetId && entry.target && entry.target.id !== targetId) {
        console.log('  Target mismatch');
        logger.warn(`Target mismatch: expected ${targetId}, got ${entry.target.id}`);
        return null;
      }

      console.log('  Audit log valide');
      return {
        executor: entry.executor,
        reason: entry.reason || 'Aucune raison fournie',
        timestamp: entry.createdTimestamp
      };

    } catch (error) {
      console.log('  ERREUR audit logs:', error.message);
      logger.error('Erreur lors de la récupération des audit logs:', error);
      return null;
    }
  }

  /**
   * Gère un ban - Unban automatique si c'est un Exilé
   */
  async handleBan(ban) {
    const auditInfo = await this.getActionExecutor(22, ban.user.id); // MEMBER_BAN_ADD
    if (!auditInfo) return;

    const { executor, reason } = auditInfo;

    // Vérifier si la cible était un Exilé
    const targetWasExile = await this.isExileById(ban.user.id);

    // Log
    await logger.moderation(
      'Ban',
      executor,
      `${ban.user.tag} (${ban.user.id})`,
      reason
    );

    // PROTECTION EXILÉS : Si la cible était un Exilé, on unban + réinvite
    if (targetWasExile) {
      try {
        // Unban
        await this.guild.members.unban(ban.user.id, 'Protection Exilés : Rollback automatique');
        logger.info(`Exilé ${ban.user.tag} débanni automatiquement`);
        
        // Créer une invitation
        const inviteChannel = this.guild.channels.cache.find(ch => ch.isTextBased() && ch.permissionsFor(this.guild.members.me).has('CreateInstantInvite'));
        if (inviteChannel) {
          const invite = await inviteChannel.createInvite({
            maxUses: 1,
            maxAge: 86400, // 24h
            reason: `Réinvitation de ${ban.user.tag} (protection Exilés)`
          });

          // Tracker cette invitation pour remettre le rôle à son retour
          this.exileInviteTracking.set(ban.user.id, {
            inviteCode: invite.code,
            wasExile: true,
            timestamp: Date.now(),
            username: ban.user.tag
          });
          logger.info(`🎫 Tracking invitation ${invite.code} pour ${ban.user.tag}`);

          // Envoyer l'invitation en DM
          let dmSent = false;
          try {
            await ban.user.send(`**Protection Exilés activée**\n\nVous avez été banni par un autre Exilé, mais le bot vous a automatiquement débanni.\n\nVoici votre invitation de retour :\n${invite.url}\n\n**Votre rôle Exilé sera automatiquement restauré dès votre retour.**`);
            dmSent = true;
            logger.info(`DM envoyé à ${ban.user.tag}`);
          } catch (error) {
            logger.warn(`Impossible d'envoyer le DM à ${ban.user.tag}: ${error.message}`);
            
            // Fallback: Envoyer dans un channel du serveur
            try {
              const notifChannel = inviteChannel;
              if (notifChannel) {
                await notifChannel.send(`**Protection Exilés - Notification**\n\n<@${ban.user.id}> (${ban.user.tag}) : Vous avez été débanni automatiquement !\n\nInvitation de retour : ${invite.url}\n\n*Je n'ai pas pu vous envoyer de DM. Activez les DMs depuis les membres du serveur dans vos paramètres.*`);
                logger.info(`Message de fallback envoyé dans #${notifChannel.name}`);
              }
            } catch (fallbackError) {
              logger.error(`Impossible d'envoyer le message de fallback: ${fallbackError.message}`);
            }
          }
        }

        await logger.abuse('Ban d\'un Exilé annulé', {
          executor: { id: executor.id, tag: executor.tag },
          target: ban.user.tag,
          reason: 'Protection du rôle Exilés',
          rollback: 'Débanni + invitation envoyée'
        });
      } catch (error) {
        logger.error('Erreur lors du rollback du ban Exilé:', error);
      }
    }
  }

  /**
   * Gère un unban
   */
  async handleUnban(ban) {
    const auditInfo = await this.getActionExecutor(23, ban.user.id); // MEMBER_BAN_REMOVE
    if (!auditInfo) return;

    const { executor, reason } = auditInfo;

    await logger.moderation(
      'Unban',
      executor,
      `${ban.user.tag} (${ban.user.id})`,
      reason
    );
  }

  /**
   * Gère un membre qui quitte (kick ou départ volontaire)
   */
  async handleMemberRemove(member) {
    const auditInfo = await this.getActionExecutor(20, member.id); // MEMBER_KICK
    if (!auditInfo) return; // Départ volontaire

    const { executor, reason } = auditInfo;

    // Vérifier si la cible était un Exilé
    const targetWasExile = this.isExile(member);

    // Log
    await logger.moderation(
      'Kick',
      executor,
      `${member.user.tag} (${member.id})`,
      reason
    );

    // PROTECTION EXILÉS : Si la cible était un Exilé, on réinvite
    if (targetWasExile) {
      try {
        // Créer une invitation
        const inviteChannel = this.guild.channels.cache.find(ch => ch.isTextBased() && ch.permissionsFor(this.guild.members.me).has('CreateInstantInvite'));
        if (inviteChannel) {
          const invite = await inviteChannel.createInvite({
            maxUses: 1,
            maxAge: 86400,
            reason: `Réinvitation de ${member.user.tag} (kick d'un Exilé)`
          });

          // Tracker cette invitation pour remettre le rôle à son retour
          this.exileInviteTracking.set(member.user.id, {
            inviteCode: invite.code,
            wasExile: true,
            timestamp: Date.now(),
            username: member.user.tag
          });
          logger.info(`Tracking invitation ${invite.code} pour ${member.user.tag}`);

          // Envoyer l'invitation en DM
          let dmSent = false;
          try {
            await member.user.send(`**Protection Exilés activée**\n\nVous avez été expulsé par un autre Exilé, mais le bot vous a envoyé une invitation de retour.\n\nVoici votre invitation :\n${invite.url}\n\n**Votre rôle Exilé sera automatiquement restauré dès votre retour.**`);
            dmSent = true;
            logger.info(`DM envoyé à ${member.user.tag}`);
          } catch (error) {
            logger.warn(`Impossible d'envoyer le DM à ${member.user.tag}: ${error.message}`);
            
            // Fallback: Envoyer dans un channel du serveur (impossible car déjà kick)
            // On log juste l'invitation pour que l'admin puisse la transmettre
            logger.info(`📋 Invitation pour ${member.user.tag}: ${invite.url}`);
            console.log(`\n${member.user.tag} ne peut pas recevoir de DM !`);
            console.log(`📋 Invitation à transmettre manuellement: ${invite.url}\n`);
          }
        }

        await logger.abuse('Kick d\'un Exilé détecté', {
          executor: { id: executor.id, tag: executor.tag },
          target: member.user.tag,
          reason: 'Protection du rôle Exilés',
          rollback: 'Invitation envoyée'
        });
      } catch (error) {
        logger.error('Erreur lors de la réinvitation après kick:', error);
      }
    }
  }

  /**
   * Gère la suppression d'un message
   */
  async handleMessageDelete(message) {
    console.log('\n=== SUPPRESSION DÉTECTÉE ===');
    console.log('Message ID:', message.id);
    console.log('Message author:', message.author ? message.author.tag : 'NULL');
    console.log('Message content:', message.content || 'VIDE');
    
    if (!message.author) {
      logger.warn('Message partiel supprimé (pas d\'auteur)');
      console.log('Arrêt: pas d\'auteur\n');
      return;
    }

    // Vérifier d'abord si l'auteur est un Exilé
    let messageAuthor;
    try {
      messageAuthor = await this.guild.members.fetch(message.author.id);
      console.log('Auteur récupéré:', messageAuthor.user.tag);
    } catch (error) {
      logger.warn(`Impossible de récupérer l'auteur du message: ${message.author.tag}`);
      console.log('Erreur récupération auteur\n');
      return;
    }

    const authorIsExile = this.isExile(messageAuthor);
    console.log('Est un Exilé?', authorIsExile);
    
    // Si l'auteur n'est pas un Exilé, on ne protège pas
    if (!authorIsExile) {
      console.log('Pas un Exilé, pas de protection\n');
      return;
    }

    console.log('Auteur est Exilé, vérification audit logs...');

    // L'auteur est un Exilé, récupérer qui a supprimé
    const auditInfo = await this.getActionExecutor(72, message.id);
    console.log('Audit info:', auditInfo);
    
    if (!auditInfo) {
      // Pas d'audit log = suppression par l'auteur lui-même
      logger.info(`Exilé ${message.author.tag} a supprimé son propre message - OK`);
      console.log('Pas d\'audit log (auto-suppression)\n');
      return;
    }

    const { executor } = auditInfo;
    console.log('Supprimé par:', executor.tag, '(ID:', executor.id, ')');
    console.log('Auteur message:', message.author.tag, '(ID:', message.author.id, ')');
    
    // Vérifier si c'est l'auteur qui a supprimé son propre message
    if (executor.id === message.author.id) {
      logger.info(`Exilé ${message.author.tag} a supprimé son propre message - OK`);
      console.log('Auto-suppression détectée\n');
      return;
    }

    // Un autre membre (Exilé ou non) a supprimé le message d'un Exilé
    console.log('PROTECTION ACTIVÉE !');
    logger.warn(`Message d'Exilé ${message.author.tag} supprimé par ${executor.tag}`);

    // PROTECTION EXILÉS : Restaurer le message
    try {
      const cachedMessage = this.messageCache.get(message.id);
      console.log('Message en cache?', !!cachedMessage);
      console.log('Contenu en cache?', cachedMessage ? !!cachedMessage.content : false);
      
      if (cachedMessage && cachedMessage.content) {
        console.log('📝 Reposting message...');
        
        // Reposter le message
        const restored = await message.channel.send({
          content: `**Message restauré (Protection Exilés)**\n**Auteur :** ${message.author}\n**Supprimé par :** ${executor}\n\n${cachedMessage.content}`,
          embeds: cachedMessage.embeds
        });

        console.log('Message restauré avec ID:', restored.id);
        logger.info(`Message restauré avec succès: ${restored.id}`);

        await logger.abuse('Message d\'un Exilé supprimé et restauré', {
          executor: { id: executor.id, tag: executor.tag },
          author: message.author.tag,
          channel: message.channel.name,
          rollback: 'Message reposté'
        });
      } else {
        console.log('Pas de contenu en cache');
        logger.error(`Message d'un Exilé supprimé mais pas en cache: ${message.id}`);
        
        // Au moins notifier
        await message.channel.send({
          content: `**Protection Exilés**\n**Auteur :** ${message.author}\n**Supprimé par :** ${executor}\n\nMessage supprimé mais contenu non disponible (pas en cache).`
        });
      }
    } catch (error) {
      console.log('ERREUR lors de la restauration:', error.message);
      logger.error('Erreur lors de la restauration du message:', error);
    }

    console.log('=== FIN SUPPRESSION ===\n');
  }

  /**
   * Gère la suppression en masse de messages
   */
  async handleBulkDelete(messages) {
    const auditInfo = await this.getActionExecutor(73); // MESSAGE_BULK_DELETE
    if (!auditInfo) return;

    const { executor, reason } = auditInfo;

    // Log
    await logger.moderation(
      'Suppression en masse',
      executor,
      `${messages.size} messages`,
      reason
    );
  }

  /**
   * Gère la modification d'un membre (protection du rôle Exilés uniquement)
   */
  async handleMemberUpdate(oldMember, newMember) {
    // Vérifier changements de rôles
    const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));

    // PROTECTION EXILÉS : Vérifier si le rôle Exilés a été retiré
    const exilesRoleId = config.get('roles.exilesRoleId');
    if (removedRoles.has(exilesRoleId)) {
      const auditInfo = await this.getActionExecutor(25, newMember.id); // MEMBER_ROLE_UPDATE
      if (auditInfo && auditInfo.executor.id !== this.client.user.id) {
        // Le rôle Exilés a été retiré par quelqu'un
        try {
          // Remettre le rôle immédiatement
          await newMember.roles.add(exilesRoleId, 'Protection Exilés : Rollback automatique');
          
          await logger.security('Rôle Exilés retiré et restauré', {
            executor: { id: auditInfo.executor.id, tag: auditInfo.executor.tag },
            target: newMember.user.tag,
            rollback: 'Rôle Exilés restauré automatiquement'
          });
        } catch (error) {
          logger.error('Erreur lors de la restauration du rôle Exilés:', error);
        }
      }
    }

    // Vérifier si le rôle protégé a été retiré (protection du bot)
    const protectedRoleId = config.get('roles.protectedRoleId');
    if (removedRoles.has(protectedRoleId) && protectedRoleId !== exilesRoleId) {
      const auditInfo = await this.getActionExecutor(25, newMember.id);
      if (auditInfo) {
        await logger.abuse('Rôle protégé retiré', {
          executor: { id: auditInfo.executor.id, tag: auditInfo.executor.tag },
          target: newMember.user.tag,
          roleId: protectedRoleId
        });

        // Rollback: remettre le rôle
        if (config.get('security.rollbackAbusiveActions')) {
          try {
            await newMember.roles.add(protectedRoleId, 'Rollback: rôle protégé');
            logger.info(`Rôle protégé restauré pour ${newMember.user.tag}`);
          } catch (error) {
            logger.error('Erreur lors du rollback du rôle:', error);
          }
        }
      }
    }
  }

  /**
   * Sanctionne un utilisateur abusif
   */
  async sanctionAbuser(executor, reason) {
    try {
      const member = await this.guild.members.fetch(executor.id);
      
      // Retirer les permissions de modération
      const moderatorRoles = config.get('roles.moderatorRoles') || [];
      for (const roleId of moderatorRoles) {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, `Sanction: ${reason}`);
        }
      }

      // Timeout temporaire (10 minutes)
      await member.timeout(600000, `Abus détecté: ${reason}`);

      await logger.security('Sanctions appliquées', {
        target: executor.tag,
        reason: reason,
        actions: ['Retrait des rôles de modération', 'Timeout 10 minutes']
      }, 'high');

    } catch (error) {
      logger.error('Erreur lors de la sanction:', error);
    }
  }

  /**
   * Gère l'arrivée d'un nouveau membre ou le retour d'un membre
   */
  async handleMemberAdd(member) {
    logger.info(`Membre arrivé: ${member.user.tag}`);

    // Vérifier si c'est un Exilé qui revient après un ban/kick
    const tracking = this.exileInviteTracking.get(member.user.id);
    
    if (tracking && tracking.wasExile) {
      logger.info(`🎯 Exilé de retour détecté: ${member.user.tag}`);
      
      try {
        // Attendre un peu que Discord finisse de traiter l'arrivée
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Remettre le rôle Exilés
        const exilesRoleId = config.get('roles.exilesRoleId');
        if (exilesRoleId) {
          await member.roles.add(exilesRoleId, 'Restauration automatique du rôle Exilés après ban/kick');
          logger.info(`Rôle Exilés restauré pour ${member.user.tag}`);

          // Envoyer un message de bienvenue
          try {
            await member.user.send(`**Bienvenue de retour !**\n\nVotre rôle Exilé a été automatiquement restauré.\n\nVous êtes de nouveau protégé par le système de protection du serveur.`);
            logger.info(`DM de confirmation envoyé à ${member.user.tag}`);
          } catch (error) {
            logger.warn(`Impossible d'envoyer le DM de confirmation à ${member.user.tag}: ${error.message}`);
            // Pas grave, le rôle a quand même été restauré
          }

          await logger.security('Rôle Exilés restauré automatiquement', {
            member: member.user.tag,
            memberId: member.user.id,
            inviteCode: tracking.inviteCode
          }, 'low');
        }

        // Supprimer le tracking
        this.exileInviteTracking.delete(member.user.id);
        logger.info(`Tracking supprimé pour ${member.user.tag}`);

      } catch (error) {
        logger.error(`Erreur lors de la restauration du rôle Exilés pour ${member.user.tag}:`, error);
      }
    }
  }
}

export default ModerationGuard;
