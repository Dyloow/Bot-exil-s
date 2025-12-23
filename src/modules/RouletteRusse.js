import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';

/**
 * Système de roulette russe - chance d'être renommé de façon dégradante
 */
class RouletteRusse {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;
    
    // Map pour stocker les membres avec nicknames temporaires: userId -> { originalNickname, degradingName }
    this.temporaryNicknames = new Map();
  }

  /**
   * Lance la roulette russe pour un membre
   */
  async play(member, channel) {
    // Vérifier si le membre a déjà un nickname temporaire
    if (this.temporaryNicknames.has(member.id)) {
      await channel.send(`❌ ${member} a déjà un surnom temporaire en cours.`);
      return;
    }

    const chanceOfLosing = config.get('rouletteRusse.chanceOfLosing') || 6;
    const durationHours = config.get('rouletteRusse.durationHours') || 24;

    // Générer un nombre aléatoire entre 1 et chanceOfLosing
    const roll = Math.floor(Math.random() * chanceOfLosing) + 1;

    // Créer un embed de suspense
    await channel.send(`🔫 ${member} tire la gâchette...`);

    // Attendre 2 secondes pour le suspense
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (roll === 1) {
      // PERDU ! Le membre doit être renommé
      const degradingNames = config.get('rouletteRusse.degradingNames') || ['La pute à JR'];
      const randomName = degradingNames[Math.floor(Math.random() * degradingNames.length)];

      try {
        // Sauvegarder le nickname original et le nom dégradant
        const originalNickname = member.nickname || member.user.username;
        this.temporaryNicknames.set(member.id, {
          originalNickname: originalNickname,
          degradingName: randomName
        });

        // Appliquer le nouveau nickname
        await member.setNickname(randomName, 'Roulette russe - PERDU');

        await channel.send(
          `💥 **BANG !** ${member} a perdu à la roulette russe !\n\n` +
          `Nouveau surnom : **${randomName}**\n` +
          `Durée : ${durationHours}h (impossible de le changer)\n\n` +
          `🪦 RIP`
        );

        logger.info(`${member.user.tag} a perdu à la roulette russe - Renommé: ${randomName}`);

        // Programmer la restauration du nickname après 24h
        const durationMs = durationHours * 60 * 60 * 1000;
        setTimeout(async () => {
          await this.restoreNickname(member.id);
        }, durationMs);

      } catch (error) {
        logger.error('Erreur lors du renommage (roulette russe):', error);
        await channel.send(`❌ Erreur lors du renommage. Vous avez de la chance... pour cette fois.`);
      }

    } else {
      // GAGNÉ ! Le membre survit
      await channel.send(
        `✅ **CLIC !** ${member} a survécu à la roulette russe !\n\n` +
        `Le barillet était vide... cette fois. 😌`
      );

      logger.info(`${member.user.tag} a survécu à la roulette russe`);
    }
  }

  /**
   * Restaure le nickname original d'un membre
   */
  async restoreNickname(memberId) {
    if (!this.temporaryNicknames.has(memberId)) {
      return;
    }

    const nicknameData = this.temporaryNicknames.get(memberId);
    const originalNickname = nicknameData.originalNickname;

    try {
      const member = await this.guild.members.fetch(memberId);
      
      // Restaurer le nickname original (null si c'était le username)
      const nicknameToRestore = originalNickname === member.user.username ? null : originalNickname;
      await member.setNickname(nicknameToRestore, 'Roulette russe - Restauration');

      // Envoyer un message dans le channel de logs si disponible
      const logChannelId = config.get('server.logChannelId');
      if (logChannelId) {
        const logChannel = this.guild.channels.cache.get(logChannelId);
        if (logChannel) {
          await logChannel.send(
            `✅ Le surnom de ${member} a été restauré après 24h de punition (roulette russe).`
          );
        }
      }

      logger.info(`Nickname restauré pour ${member.user.tag}: ${originalNickname}`);

    } catch (error) {
      logger.error(`Erreur lors de la restauration du nickname pour ${memberId}:`, error);
    }

    // Retirer de la map
    this.temporaryNicknames.delete(memberId);
  }

  /**
   * Vérifie si un membre peut changer son nickname (bloque si roulette russe active)
   */
  canChangeNickname(memberId) {
    return !this.temporaryNicknames.has(memberId);
  }

  /**
   * Retourne le nom dégradant actuel d'un membre (si en cours de punition)
   */
  getDegradingName(memberId) {
    if (!this.temporaryNicknames.has(memberId)) {
      return null;
    }
    return this.temporaryNicknames.get(memberId).degradingName;
  }

  /**
   * Retourne la liste des membres avec nickname temporaire
   */
  getActiveTemporaryNicknames() {
    return Array.from(this.temporaryNicknames.entries()).map(([userId, data]) => ({
      userId,
      originalName: data.originalNickname,
      degradingName: data.degradingName
    }));
  }
}

export default RouletteRusse;
