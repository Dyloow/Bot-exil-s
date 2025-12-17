import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';

/**
 * Système de vote anonyme pour l'attribution du rôle Exilé
 */
class VoteSystem {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;
    
    // Map pour stocker les votes actifs: voteId -> voteData
    this.activeVotes = new Map();
  }

  /**
   * Démarre un vote pour attribuer le rôle Exilé à un membre
   */
  async startVote(initiator, targetMember, channel) {
    // Vérifications préalables
    const exilesRoleId = config.get('roles.exilesRoleId');
    const condamneRoleId = config.get('roles.condamneRoleId');
    
    // Vérifier que l'initiateur a le rôle Exilé
    if (!initiator.roles.cache.has(exilesRoleId)) {
      await channel.send(`❌ Seuls les Exilés peuvent lancer un vote.`);
      return;
    }

    // Vérifier que la cible n'a pas déjà le rôle Exilé ou Condamné
    if (targetMember.roles.cache.has(exilesRoleId)) {
      await channel.send(`❌ ${targetMember.user.tag} a déjà le rôle Exilé.`);
      return;
    }

    if (targetMember.roles.cache.has(condamneRoleId)) {
      await channel.send(`❌ ${targetMember.user.tag} est déjà condamné à l'exil (vote en cours).`);
      return;
    }

    // Vérifier qu'il n'y a pas déjà un vote en cours pour ce membre
    for (const [voteId, voteData] of this.activeVotes.entries()) {
      if (voteData.targetMember.id === targetMember.id) {
        await channel.send(`❌ Un vote est déjà en cours pour ${targetMember.user.tag}.`);
        return;
      }
    }

    // Récupérer tous les membres avec le rôle Exilé (sauf bots)
    // Utiliser le cache pour éviter les rate limits
    const exiledMembers = this.guild.members.cache.filter(
      member => member.roles.cache.has(exilesRoleId) && !member.user.bot
    );

    if (exiledMembers.size === 0) {
      await channel.send(`❌ Aucun Exilé trouvé pour voter.`);
      return;
    }

    // Attribuer le rôle "Condamné à l'Exil" temporairement
    try {
      await targetMember.roles.add(condamneRoleId);
      logger.info(`Rôle "Condamné à l'Exil" attribué à ${targetMember.user.tag}`);
    } catch (error) {
      logger.error('Erreur lors de l\'attribution du rôle Condamné:', error);
      await channel.send(`❌ Erreur lors de l'attribution du rôle temporaire.`);
      return;
    }

    // Créer l'ID du vote
    const voteId = `vote_${Date.now()}_${targetMember.id}`;

    // Récupérer la durée du vote depuis la config
    const durationHours = config.get('vote.durationHours') || 24;

    // Créer l'embed du vote
    const voteEmbed = new EmbedBuilder()
      .setTitle('🗳️ Vote pour définitivement rejoindre La Table des Exilés')
      .setDescription(
        `**Candidat :** ${targetMember}\n\n` +
        `Un vote est lancé pour décider si cette personne peut **rejoindre définitivement** La Table des Exilés à **effet permanent**.\n\n` +
        `⚠️ **Le candidat a reçu le rôle "Condamné à l'Exil" pendant ${durationHours}h**\n\n` +
        `**Règles :**\n` +
        `• Vote anonyme\n` +
        `• Tous les Exilés doivent voter dans les ${durationHours}h\n` +
        `• Le vote doit être unanime (un seul "Non" = refus)\n` +
        `• Les votes manquants après ${durationHours}h comptent comme "Oui"\n` +
        `• Si refusé : le rôle Condamné sera retiré\n\n` +
        `**Votes : 0/${exiledMembers.size}**`
      )
      .setColor('#FFA500')
      .setTimestamp();

    // Créer les boutons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('✅ Oui')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('❌ Non')
          .setStyle(ButtonStyle.Danger)
      );

    // Envoyer le message de vote avec ping du rôle
    const voteMessage = await channel.send({
      content: `<@&${exilesRoleId}> Un nouveau vote est lancé !`,
      embeds: [voteEmbed],
      components: [row]
    });

    // Stocker les données du vote
    this.activeVotes.set(voteId, {
      voteId: voteId,
      targetMember: targetMember,
      initiator: initiator,
      message: voteMessage,
      channel: channel,
      exiledMembers: exiledMembers,
      votes: new Map(), // userId -> 'yes' | 'no'
      totalVoters: exiledMembers.size,
      startTime: Date.now()
    });

    logger.info(`Vote lancé pour ${targetMember.user.tag} par ${initiator.user.tag}`);

    // Timeout configurable
    const durationMs = durationHours * 60 * 60 * 1000;
    setTimeout(() => {
      if (this.activeVotes.has(voteId)) {
        this.concludeVoteWithTimeout(voteId);
      }
    }, durationMs);
  }

  /**
   * Gère un vote d'un membre
   */
  async handleVote(interaction) {
    const customId = interaction.customId;
    
    // Parser l'ID du vote (vote_... ou votekick_everyone_... ou votekick_manual_...)
    const match = customId.match(/^(vote(?:kick_(?:everyone|manual))?_\d+_\d+)_(yes|no)$/);
    if (!match) {
      logger.warn(`ID de vote non reconnu: ${customId}`);
      return;
    }

    const [, voteId, voteChoice] = match;

    // Vérifier que le vote existe
    if (!this.activeVotes.has(voteId)) {
      await interaction.reply({
        content: '❌ Ce vote n\'est plus actif.',
        ephemeral: true
      });
      return;
    }

    const voteData = this.activeVotes.get(voteId);

    // Vérifier que le votant a le rôle Exilé
    const exilesRoleId = config.get('roles.exilesRoleId');
    const rapatriRoleId = config.get('roles.rapatriRoleId');
    
    // Bloquer les Rapatriés de voter
    if (rapatriRoleId && interaction.member.roles.cache.has(rapatriRoleId)) {
      await interaction.reply({
        content: '❌ Les Rapatriés ne peuvent pas voter.',
        ephemeral: true
      });
      return;
    }
    
    if (!interaction.member.roles.cache.has(exilesRoleId)) {
      await interaction.reply({
        content: '❌ Seuls les Exilés peuvent voter.',
        ephemeral: true
      });
      return;
    }

    // Pour un vote kick, le coupable ne peut pas voter
    if (voteData.type === 'kick' && interaction.user.id === voteData.targetMember.id) {
      await interaction.reply({
        content: '❌ Vous ne pouvez pas voter pour votre propre exclusion.',
        ephemeral: true
      });
      return;
    }

    // Vérifier que le votant n'a pas déjà voté
    if (voteData.votes.has(interaction.user.id)) {
      await interaction.reply({
        content: '❌ Vous avez déjà voté.',
        ephemeral: true
      });
      return;
    }

    // Enregistrer le vote
    voteData.votes.set(interaction.user.id, voteChoice);

    await interaction.reply({
      content: `✅ Votre vote a été enregistré de manière anonyme.`,
      ephemeral: true
    });

    logger.info(`Vote enregistré pour ${voteData.targetMember.user.tag} (${voteData.votes.size}/${voteData.totalVoters})`);

    // Mettre à jour l'embed
    await this.updateVoteEmbed(voteId);

    // Le vote continue jusqu'au timeout, même si tout le monde a voté
  }

  /**
   * Met à jour l'embed du vote
   */
  async updateVoteEmbed(voteId) {
    const voteData = this.activeVotes.get(voteId);
    if (!voteData) return;

    let voteEmbed;
    
    if (voteData.type === 'kick') {
      // Vote kick - Différencier entre everyone et manual
      const isManual = voteData.subtype === 'manual';
      
      // Lister les votants publiquement (non anonyme)
      let kickVoters = [];
      let pardonVoters = [];
      
      for (const [userId, vote] of voteData.votes) {
        const member = this.guild.members.cache.get(userId);
        const username = member ? member.user.username : 'Inconnu';
        
        if (vote === 'yes') {
          kickVoters.push(username);
        } else {
          pardonVoters.push(username);
        }
      }
      
      const kickCount = kickVoters.length;
      const pardonCount = pardonVoters.length;
      
      // Formater les listes de votants
      const kickList = kickVoters.length > 0 ? kickVoters.join(', ') : '_Aucun_';
      const pardonList = pardonVoters.length > 0 ? pardonVoters.join(', ') : '_Aucun_';
      
      if (isManual) {
        const durationMinutes = config.get('voteKick.durationMinutes') || 10;
        const rapatriDurationHours = config.get('voteKick.rapatriDurationHours') || 24;
        
        voteEmbed = new EmbedBuilder()
          .setTitle('⚖️ Vote Kick Manuel')
          .setDescription(
            `**Cible :** ${voteData.targetMember}\n\n` +
            `Un vote est lancé pour punir temporairement ce membre.\n\n` +
            `**Règles :**\n` +
            `• Vote PUBLIC (non anonyme)\n` +
            `• Majorité simple (>50% des votes exprimés) requise\n` +
            `• Les votes manquants après ${durationMinutes} minutes NE COMPTENT PAS\n` +
            `• Si oui : retrait du rôle Éxilés + ajout du rôle Rapatrié (lecture seule) pendant ${rapatriDurationHours}h\n` +
            `• Après ${rapatriDurationHours}h : le rôle Rapatrié est retiré automatiquement et le rôle Éxilés est rendu\n\n` +
            `**Votes : ${voteData.votes.size}/${voteData.totalVoters}**\n\n` +
            `**👍 Oui (${kickCount}) :** ${kickList}\n` +
            `**👎 Non (${pardonCount}) :** ${pardonList}`
          )
          .setColor('#FFA500')
          .setTimestamp();
      } else {
        const durationHours = config.get('voteKickEveryone.durationHours') || 24;
        
        voteEmbed = new EmbedBuilder()
          .setTitle('🚨 Vote Kick - Abus de @everyone')
          .setDescription(
            `**Coupable :** ${voteData.targetMember}\n\n` +
            `${voteData.targetMember.user.tag} a utilisé @everyone.\n\n` +
            `Un vote est lancé pour décider de son EXCLUSION DÉFINITIVE du serveur.\n\n` +
            `**Règles :**\n` +
            `• Vote PUBLIC (non anonyme)\n` +
            `• Majorité ABSOLUE (>50% de TOUS les Éxilés) requise pour kick\n` +
            `• Les votes manquants après ${durationHours}h comptent comme "Pardon"\n` +
            `• Si kick : EXPULSION du serveur Discord (pas de retour)\n\n` +
            `**Votes : ${voteData.votes.size}/${voteData.totalVoters}**\n\n` +
            `**👍 Kick (${kickCount}) :** ${kickList}\n` +
            `**🙏 Pardon (${pardonCount}) :** ${pardonList}`
          )
          .setColor('#FF0000')
          .setTimestamp();
      }
    } else {
      // Vote admission - ANONYME
      const durationHours = config.get('vote.durationHours') || 24;
      
      voteEmbed = new EmbedBuilder()
        .setTitle('🗳️ Vote pour définitivement rejoindre La Table des Exilés')
        .setDescription(
          `**Candidat :** ${voteData.targetMember}\n\n` +
          `Un vote est lancé pour décider si cette personne peut **rejoindre définitivement** La Table des Exilés à **effet permanent**.\n\n` +
          `**Règles :**\n` +
          `• Vote anonyme\n` +
          `• Tous les Exilés doivent voter dans les ${durationHours}h\n` +
          `• La majorité l'emporte (>50%)\n` +
          `• Les votes manquants ne comptent PAS\n\n` +
          `**Votes : ${voteData.votes.size}/${voteData.totalVoters}**`
        )
        .setColor('#FFA500')
        .setTimestamp();
    }

    try {
      await voteData.message.edit({ embeds: [voteEmbed] });
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de l\'embed du vote:', error);
    }
  }

  /**
   * Conclut le vote et attribue le rôle si unanime
   */
  async concludeVote(voteId) {
    const voteData = this.activeVotes.get(voteId);
    if (!voteData) return;

    // Compter les votes
    let yesCount = 0;
    let noCount = 0;

    for (const [userId, vote] of voteData.votes) {
      if (vote === 'yes') yesCount++;
      else if (vote === 'no') noCount++;
    }

    // Vérifier la majorité (>50%)
    const totalVotes = yesCount + noCount;
    const hasMajority = totalVotes > 0 && yesCount > (totalVotes / 2);

    // Désactiver les boutons
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('✅ Oui')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('❌ Non')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      );

    if (hasMajority) {
      // Majorité : attribuer le rôle Exilé et retirer Condamné
      const exilesRoleId = config.get('roles.exilesRoleId');
      const condamneRoleId = config.get('roles.condamneRoleId');
      
      try {
        // Retirer le rôle Condamné
        await voteData.targetMember.roles.remove(condamneRoleId);
        
        // Ajouter le rôle Exilé
        await voteData.targetMember.roles.add(exilesRoleId);

        const successEmbed = new EmbedBuilder()
          .setTitle('✅ Vote réussi')
          .setDescription(
            `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
            `La majorité a voté oui ! ${voteData.targetMember.user.tag} rejoint les Exilés.\n\n` +
            `**Résultats :**\n` +
            `✅ Oui : ${yesCount}\n` +
            `❌ Non : ${noCount}\n` +
            `Abstentions : ${voteData.totalVoters - totalVotes}\n\n` +
            `Bienvenue parmi les Exilés ! 🎉`
          )
          .setColor('#00FF00')
          .setTimestamp();

        await voteData.message.edit({
          embeds: [successEmbed],
          components: [disabledRow]
        });

        await voteData.channel.send(
          `🎉 ${voteData.targetMember} a été accepté(e) parmi les Exilés !`
        );

        logger.security('Vote majorité réussi', {
          target: voteData.targetMember.user.tag,
          initiator: voteData.initiator.user.tag,
          votes: `${yesCount}/${totalVotes}`
        }, 'low');

      } catch (error) {
        logger.error('Erreur lors de l\'attribution du rôle:', error);
        await voteData.channel.send(
          `❌ Erreur lors de l'attribution du rôle à ${voteData.targetMember.user.tag}.`
        );
      }

    } else {
      // Pas de majorité : refus - RETIRER le rôle Condamné
      const condamneRoleId = config.get('roles.condamneRoleId');
      
      try {
        await voteData.targetMember.roles.remove(condamneRoleId);
        logger.info(`Rôle Condamné retiré de ${voteData.targetMember.user.tag} (vote refusé)`);
      } catch (error) {
        logger.error('Erreur lors du retrait du rôle Condamné:', error);
      }
      
      const failEmbed = new EmbedBuilder()
        .setTitle('❌ Vote échoué')
        .setDescription(
          `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
          `La majorité n'a pas voté oui. ${voteData.targetMember.user.tag} ne peut pas rejoindre les Exilés.\n\n` +
          `**Résultats :**\n` +
          `✅ Oui : ${yesCount}\n` +
          `❌ Non : ${noCount}\n` +
          `Abstentions : ${voteData.totalVoters - totalVotes}\n\n` +
          `La majorité (>50%) est requise pour accepter un nouveau membre.\n` +
          `Le rôle "Condamné à l'Exil" a été retiré.`
        )
        .setColor('#FF0000')
        .setTimestamp();

      await voteData.message.edit({
        embeds: [failEmbed],
        components: [disabledRow]
      });

      logger.info(`Vote échoué pour ${voteData.targetMember.user.tag} (${yesCount}/${totalVotes})`);
    }

    // Supprimer le vote actif
    this.activeVotes.delete(voteId);
  }

  /**
   * Conclut le vote après timeout (votes manquants = oui)
   */
  async concludeVoteWithTimeout(voteId) {
    const voteData = this.activeVotes.get(voteId);
    if (!voteData) return;

    const missingVotesCountAsYes = config.get('vote.missingVotesCountAsYes') !== false;

    // Compter les votes
    let yesCount = 0;
    let noCount = 0;
    let missingCount = 0;

    // Compter les votes explicites
    for (const [userId, vote] of voteData.votes) {
      if (vote === 'yes') yesCount++;
      else if (vote === 'no') noCount++;
    }

    // Calculer les votes manquants
    missingCount = voteData.totalVoters - voteData.votes.size;

    // Si les votes manquants comptent comme "oui"
    if (missingVotesCountAsYes && missingCount > 0) {
      yesCount += missingCount;
    }

    // Vérifier l'unanimité (aucun "non")
    const isUnanimous = noCount === 0;

    // Désactiver les boutons du message original
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('✅ Oui')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('❌ Non')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      );

    // Désactiver les boutons du message de vote
    try {
      await voteData.message.edit({
        components: [disabledRow]
      });
    } catch (error) {
      logger.error('Erreur lors de la désactivation des boutons:', error);
    }

    if (isUnanimous) {
      // Vote unanime : attribuer le rôle Exilé et retirer Condamné
      const exilesRoleId = config.get('roles.exilesRoleId');
      const condamneRoleId = config.get('roles.condamneRoleId');
      
      try {
        // Retirer le rôle Condamné
        await voteData.targetMember.roles.remove(condamneRoleId);
        
        // Ajouter le rôle Exilé
        await voteData.targetMember.roles.add(exilesRoleId);

        const successEmbed = new EmbedBuilder()
          .setTitle('✅ Vote réussi')
          .setDescription(
            `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
            `Le vote est unanime ! ${voteData.targetMember.user.tag} rejoint définitivement La Table des Exilés.\n\n` +
            `Bienvenue parmi les Exilés ! 🎉`
          )
          .setColor('#00FF00')
          .setTimestamp();

        await voteData.channel.send({
          content: `🎉 ${voteData.targetMember} a été accepté(e) parmi les Exilés !`,
          embeds: [successEmbed]
        });

        logger.security('Vote unanime réussi (timeout)', {
          target: voteData.targetMember.user.tag,
          initiator: voteData.initiator.user.tag,
          votes: `${yesCount}/${voteData.totalVoters}`,
          missing: missingCount
        }, 'low');

      } catch (error) {
        logger.error('Erreur lors de l\'attribution du rôle:', error);
        await voteData.channel.send(
          `❌ Erreur lors de l'attribution du rôle à ${voteData.targetMember.user.tag}.`
        );
      }

    } else {
      // Vote non unanime : refus - RETIRER le rôle Condamné
      const condamneRoleId = config.get('roles.condamneRoleId');
      
      try {
        await voteData.targetMember.roles.remove(condamneRoleId);
        logger.info(`Rôle Condamné retiré de ${voteData.targetMember.user.tag} (vote refusé après timeout)`);
      } catch (error) {
        logger.error('Erreur lors du retrait du rôle Condamné:', error);
      }
      
      const failEmbed = new EmbedBuilder()
        .setTitle('❌ Vote échoué')
        .setDescription(
          `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
          `Le vote n'est pas unanime. ${voteData.targetMember.user.tag} ne peut pas rejoindre les Exilés.\n\n` +
          `Le vote doit être unanime pour accepter un nouveau membre.\n` +
          `Le rôle "Condamné à l'Exil" a été retiré.`
        )
        .setColor('#FF0000')
        .setTimestamp();

      await voteData.channel.send({
        embeds: [failEmbed]
      });

      logger.info(`Vote échoué pour ${voteData.targetMember.user.tag} (${noCount} non) après timeout`);
    }

    // Supprimer le vote actif
    this.activeVotes.delete(voteId);
  }

  /**
   * Annule un vote
   */
  async cancelVote(voteId, reason = 'Vote annulé') {
    const voteData = this.activeVotes.get(voteId);
    if (!voteData) return;

    const cancelEmbed = new EmbedBuilder()
      .setTitle('⚠️ Vote annulé')
      .setDescription(
        `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
        `${reason}`
      )
      .setColor('#FFA500')
      .setTimestamp();

    const disabledRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('✅ Oui')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('❌ Non')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      );

    try {
      await voteData.message.edit({
        embeds: [cancelEmbed],
        components: [disabledRow]
      });
    } catch (error) {
      logger.error('Erreur lors de l\'annulation du vote:', error);
    }

    this.activeVotes.delete(voteId);
    logger.info(`Vote annulé pour ${voteData.targetMember.user.tag}: ${reason}`);
  }

  /**
   * Liste les votes en cours
   */
  listActiveVotes() {
    return Array.from(this.activeVotes.values()).map(vote => ({
      target: vote.targetMember.user.tag,
      initiator: vote.initiator.user.tag,
      votes: `${vote.votes.size}/${vote.totalVoters}`,
      startTime: new Date(vote.startTime).toLocaleString('fr-FR')
    }));
  }

  /**
   * Démarre un vote kick automatique pour punir un abus de @everyone
   * Ce vote retire DÉFINITIVEMENT le rôle Exilés (pas de durée limitée)
   */
  async startVoteKickEveryone(culprit, channel, message) {
    const exilesRoleId = config.get('roles.exilesRoleId');

    // Vérifier que le coupable a le rôle Exilé
    if (!culprit.roles.cache.has(exilesRoleId)) {
      return; // Pas un Exilé, on ignore
    }

    // Vérifier qu'il n'y a pas déjà un vote kick en cours pour ce membre
    for (const [voteId, voteData] of this.activeVotes.entries()) {
      if (voteData.type === 'kick' && voteData.targetMember.id === culprit.id) {
        return; // Un vote kick est déjà en cours
      }
    }

    // Récupérer tous les membres avec le rôle Exilé (sauf bots et sauf le coupable)
    // Utiliser le cache pour éviter les rate limits
    const exiledMembers = this.guild.members.cache.filter(
      member => member.roles.cache.has(exilesRoleId) && !member.user.bot && member.id !== culprit.id
    );

    if (exiledMembers.size === 0) {
      return; // Aucun Exilé pour voter
    }

    // Créer l'ID du vote
    const voteId = `votekick_everyone_${Date.now()}_${culprit.id}`;

    // Récupérer la durée du vote kick depuis la config (en heures pour @everyone)
    const durationHours = config.get('voteKickEveryone.durationHours') || 24;

    // Créer l'embed du vote kick
    const voteEmbed = new EmbedBuilder()
      .setTitle('🚨 Vote Kick - Abus de @everyone')
      .setDescription(
        `**Coupable :** ${culprit}\n\n` +
        `${culprit.user.tag} a utilisé @everyone.\n\n` +
        `Un vote est lancé pour décider de son EXCLUSION DÉFINITIVE du serveur.\n\n` +
        `**Règles :**\n` +
        `• Vote PUBLIC (non anonyme)\n` +
        `• Majorité ABSOLUE (>50% de TOUS les Éxilés) requise pour kick\n` +
        `• Les votes manquants après ${durationHours}h comptent comme "Pardon"\n` +
        `• Si kick : EXPULSION du serveur Discord (pas de retour)\n\n` +
        `**Votes : 0/${exiledMembers.size}**\n\n` +
        `**👍 Kick (0) :** _Aucun_\n` +
        `**🙏 Pardon (0) :** _Aucun_`
      )
      .setColor('#FF0000')
      .setTimestamp();

    // Créer les boutons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('✅ Kick')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('❌ Pardonner')
          .setStyle(ButtonStyle.Secondary)
      );

    // Envoyer le message de vote kick avec ping du rôle
    const voteMessage = await channel.send({
      content: `<@&${exilesRoleId}> 🚨 Vote kick automatique lancé !`,
      embeds: [voteEmbed],
      components: [row]
    });

    // Stocker les données du vote kick
    this.activeVotes.set(voteId, {
      voteId: voteId,
      type: 'kick',
      subtype: 'everyone', // Indique que c'est un vote pour @everyone (définitif)
      targetMember: culprit,
      message: voteMessage,
      channel: channel,
      originalMessage: message,
      exiledMembers: exiledMembers,
      votes: new Map(), // userId -> 'yes' | 'no'
      totalVoters: exiledMembers.size,
      startTime: Date.now()
    });

    logger.info(`Vote kick automatique lancé pour ${culprit.user.tag} (abus @everyone)`);

    // Timeout configurable (en heures pour le vote kick @everyone)
    const durationMs = durationHours * 60 * 60 * 1000;
    setTimeout(() => {
      if (this.activeVotes.has(voteId)) {
        this.concludeVoteKickWithTimeout(voteId);
      }
    }, durationMs);
  }

  /**
   * Démarre un vote kick manuel via la commande !vote-kick
   * Ce vote donne le rôle Rapatrié pendant 24h (temporaire)
   */
  async startVoteKickManual(initiator, targetMember, channel) {
    const exilesRoleId = config.get('roles.exilesRoleId');
    const rapatriRoleId = config.get('roles.rapatriRoleId');

    // Vérifier que l'initiateur a le rôle Exilé
    if (!initiator.roles.cache.has(exilesRoleId)) {
      await channel.send(`❌ Seuls les Exilés peuvent lancer un vote-kick.`);
      return;
    }

    // Vérifier que la cible a le rôle Exilé
    if (!targetMember.roles.cache.has(exilesRoleId)) {
      await channel.send(`❌ ${targetMember.user.tag} n'est pas un Exilé.`);
      return;
    }

    // Vérifier que la cible n'a pas déjà le rôle Rapatrié
    if (targetMember.roles.cache.has(rapatriRoleId)) {
      await channel.send(`❌ ${targetMember.user.tag} a déjà le rôle Rapatrié.`);
      return;
    }

    // Vérifier qu'il n'y a pas déjà un vote kick en cours pour ce membre
    for (const [voteId, voteData] of this.activeVotes.entries()) {
      if (voteData.type === 'kick' && voteData.targetMember.id === targetMember.id) {
        await channel.send(`❌ Un vote kick est déjà en cours pour ${targetMember.user.tag}.`);
        return;
      }
    }

    // Récupérer tous les membres avec le rôle Exilé (sauf bots et sauf la cible)
    const exiledMembers = this.guild.members.cache.filter(
      member => member.roles.cache.has(exilesRoleId) && !member.user.bot && member.id !== targetMember.id
    );

    if (exiledMembers.size === 0) {
      await channel.send(`❌ Aucun Exilé disponible pour voter.`);
      return;
    }

    // Créer l'ID du vote
    const voteId = `votekick_manual_${Date.now()}_${targetMember.id}`;

    // Récupérer la durée du vote kick depuis la config (en minutes)
    const durationMinutes = config.get('voteKick.durationMinutes') || 5;
    const rapatriDurationHours = config.get('voteKick.rapatriDurationHours') || 24;

    // Créer l'embed du vote kick manuel
    const voteEmbed = new EmbedBuilder()
      .setTitle('⚖️ Vote Kick Manuel')
      .setDescription(
        `**Cible :** ${targetMember}\n\n` +
        `Un vote est lancé pour punir temporairement ce membre.\n\n` +
        `**Règles :**\n` +
        `• Vote PUBLIC (non anonyme)\n` +
        `• Majorité absolue (>50%) requise\n` +
        `• Les votes manquants après ${durationMinutes} minutes comptent comme "Non"\n` +
        `• Si oui : retrait du rôle Exilés + ajout du rôle Rapatrié (lecture seule) pendant ${rapatriDurationHours}h\n` +
        `• Après ${rapatriDurationHours}h : le rôle Rapatrié est retiré automatiquement et le rôle Exilés est rendu\n\n` +
        `**Votes : 0/${exiledMembers.size}**\n\n` +
        `**👍 Oui (0) :** \n` +
        `**👎 Non (0) :** `
      )
      .setColor('#FFA500')
      .setTimestamp();

    // Créer les boutons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('👍 Oui')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('👎 Non')
          .setStyle(ButtonStyle.Success)
      );

    // Envoyer le message de vote kick avec ping du rôle
    const voteMessage = await channel.send({
      content: `<@&${exilesRoleId}> 🔔 Vote kick manuel lancé par ${initiator.user.tag}`,
      embeds: [voteEmbed],
      components: [row]
    });

    // Stocker les données du vote kick manuel
    this.activeVotes.set(voteId, {
      voteId: voteId,
      type: 'kick',
      subtype: 'manual', // Indique que c'est un vote manuel (temporaire)
      initiator: initiator,
      targetMember: targetMember,
      message: voteMessage,
      channel: channel,
      exiledMembers: exiledMembers,
      votes: new Map(),
      totalVoters: exiledMembers.size,
      startTime: Date.now()
    });

    logger.info(`Vote kick manuel lancé par ${initiator.user.tag} pour ${targetMember.user.tag}`);

    // Timeout configurable
    const durationMs = durationMinutes * 60 * 1000;
    setTimeout(() => {
      if (this.activeVotes.has(voteId)) {
        this.concludeVoteKickWithTimeout(voteId);
      }
    }, durationMs);
  }

  /**
   * Conclut le vote kick après timeout (majorité absolue)
   */
  async concludeVoteKickWithTimeout(voteId) {
    const voteData = this.activeVotes.get(voteId);
    if (!voteData) return;

    // Compter les votes
    let kickCount = 0;
    let pardonCount = 0;

    for (const [userId, vote] of voteData.votes) {
      if (vote === 'yes') kickCount++;
      else if (vote === 'no') pardonCount++;
    }

    const totalVotes = kickCount + pardonCount;
    const isManual = voteData.subtype === 'manual';
    
    // Calcul de la majorité selon le type de vote
    let hasMajority;
    if (isManual) {
      // Vote manuel : majorité simple (> 50% des votes exprimés)
      // Les votes manquants NE comptent PAS
      hasMajority = totalVotes > 0 && kickCount > (totalVotes / 2);
    } else {
      // Vote @everyone : majorité absolue (> 50% de TOUS les Éxilés)
      // Les votes manquants comptent comme Pardon
      hasMajority = kickCount > (voteData.totalVoters / 2);
    }

    // Désactiver les boutons du message de vote
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel(isManual ? '👍 Oui' : '✅ Kick')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel(isManual ? '👎 Non' : '❌ Pardonner')
          .setStyle(isManual ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      );

    try {
      await voteData.message.edit({
        components: [disabledRow]
      });
    } catch (error) {
      logger.error('Erreur lors de la désactivation des boutons:', error);
    }

    if (hasMajority) {
      const exilesRoleId = config.get('roles.exilesRoleId');
      
      if (isManual) {
        // Vote manuel : retrait temporaire avec rôle Rapatrié pendant 24h
        const rapatriRoleId = config.get('roles.rapatriRoleId');
        const rapatriDurationHours = config.get('voteKick.rapatriDurationHours') || 24;
        
        try {
          // Retirer le rôle Exilés
          await voteData.targetMember.roles.remove(exilesRoleId);
          
          // Ajouter le rôle Rapatrié (lecture seule) temporairement
          await voteData.targetMember.roles.add(rapatriRoleId);

          const kickEmbed = new EmbedBuilder()
            .setTitle('⚖️ Vote Kick Manuel - Sanction Temporaire')
            .setDescription(
              `**Cible :** ${voteData.targetMember.user.tag}\n\n` +
              `La majorité simple a voté pour la sanction temporaire.\n\n` +
              `${voteData.targetMember.user.tag} a été retiré des Exilés et a reçu le rôle "Rapatrié" pendant ${rapatriDurationHours}h.\n` +
              `**Après ${rapatriDurationHours}h, il retrouvera automatiquement son rôle Exilés.**\n\n` +
              `**Résultat final :**\n` +
              `✅ Oui : ${kickCount}\n` +
              `❌ Non : ${pardonCount}\n` +
              `🔇 Abstentions : ${voteData.totalVoters - totalVotes}`
            )
            .setColor('#FFA500')
            .setTimestamp();

          await voteData.channel.send({ embeds: [kickEmbed] });

          // Programmer le retour automatique après 24h
          const rapatriDurationMs = rapatriDurationHours * 60 * 60 * 1000;
          setTimeout(async () => {
            try {
              // Vérifier que le membre a toujours le rôle Rapatrié
              const currentMember = await this.guild.members.fetch(voteData.targetMember.id);
              if (currentMember.roles.cache.has(rapatriRoleId)) {
                // Retirer le rôle Rapatrié et rendre le rôle Exilés
                await currentMember.roles.remove(rapatriRoleId);
                await currentMember.roles.add(exilesRoleId);
                
                await voteData.channel.send(
                  `✅ ${voteData.targetMember.user.tag} a purgé sa peine de ${rapatriDurationHours}h et retrouve son rôle Exilés.`
                );
                
                logger.info(`${voteData.targetMember.user.tag} a retrouvé le rôle Exilés après ${rapatriDurationHours}h`);
              }
            } catch (error) {
              logger.error(`Erreur lors du retour automatique du rôle Exilés pour ${voteData.targetMember.user.tag}:`, error);
            }
          }, rapatriDurationMs);

          await logger.security('Vote kick manuel réussi (temporaire)', {
            target: voteData.targetMember.user.tag,
            kickVotes: kickCount,
            pardonVotes: pardonCount,
            abstentions: voteData.totalVoters - totalVotes,
            duration: `${rapatriDurationHours}h`
          }, 'medium');

        } catch (error) {
          logger.error('Erreur lors de l\'application de la sanction temporaire:', error);
          await voteData.channel.send(`❌ Erreur lors de l'application de la sanction.`);
        }
        
      } else {
        // Vote @everyone : EXPULSION du serveur (kick Discord)
        try {
          // EXPULSER le membre du serveur Discord
          await voteData.targetMember.kick('Abus de @everyone - Vote kick approuvé par la majorité absolue');

          const kickEmbed = new EmbedBuilder()
            .setTitle('🚨 Vote Kick @everyone - EXPULSION DU SERVEUR')
            .setDescription(
              `**Coupable :** ${voteData.targetMember.user.tag}\n\n` +
              `La majorité absolue a voté pour l'expulsion.\n\n` +
              `${voteData.targetMember.user.tag} a été **EXPULSÉ DU SERVEUR** suite à l'abus de @everyone.\n` +
              `Il devra être réinvité par un admin pour revenir.\n\n` +
              `**Résultats :**\n` +
              `👍 Kick : ${kickCount}\n` +
              `🙏 Pardon : ${pardonCount}\n` +
              `🔇 Abstentions : ${voteData.totalVoters - totalVotes}\n\n` +
              `*Majorité absolue : ${kickCount}/${voteData.totalVoters} Éxilés (> 50%)*`
            )
            .setColor('#FF0000')
            .setTimestamp();

          await voteData.channel.send({
            embeds: [kickEmbed]
          });

          await logger.security('Vote kick réussi - Expulsion du serveur', {
            target: voteData.targetMember.user.tag,
            reason: 'Abus @everyone',
            votes: `${kickCount}/${voteData.totalVoters}`,
            kicked: true
          }, 'high');

        } catch (error) {
          logger.error('Erreur lors de l\'expulsion du serveur:', error);
          await voteData.channel.send(
            `❌ Erreur lors de l'expulsion de ${voteData.targetMember.user.tag} du serveur.`
          );
        }
      }

    } else {
      // Pas de majorité : pardon
      const isManualVote = voteData.subtype === 'manual';
      const pardonEmbed = new EmbedBuilder()
        .setTitle(isManualVote ? '✅ Vote Kick Manuel - Rejeté' : '✅ Vote Kick - Pardon accordé')
        .setDescription(
          `**Coupable :** ${voteData.targetMember.user.tag}\n\n` +
          `La majorité n'a pas voté pour le kick.\n\n` +
          `${voteData.targetMember.user.tag} reste parmi les Exilés.\n\n` +
          `**Résultats :**\n` +
          `👍 Kick : ${kickCount}\n` +
          `🙏 Pardon : ${pardonCount}\n` +
          `Abstentions : ${voteData.totalVoters - totalVotes}`
        )
        .setColor('#00FF00')
        .setTimestamp();

      await voteData.channel.send({
        embeds: [pardonEmbed]
      });

      logger.info(`Vote kick échoué pour ${voteData.targetMember.user.tag} - Pardon accordé (${kickCount}/${totalVotes})`);
    }

    // Supprimer le vote actif
    this.activeVotes.delete(voteId);
  }
}

export default VoteSystem;
