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
    
    // Vérifier que l'initiateur a le rôle Exilé
    if (!initiator.roles.cache.has(exilesRoleId)) {
      await channel.send(`❌ Seuls les Exilés peuvent lancer un vote.`);
      return;
    }

    // Vérifier que la cible n'a pas déjà le rôle
    if (targetMember.roles.cache.has(exilesRoleId)) {
      await channel.send(`❌ ${targetMember.user.tag} a déjà le rôle Exilé.`);
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
        `**Règles :**\n` +
        `• Vote anonyme\n` +
        `• Tous les Exilés doivent voter dans les ${durationHours}h\n` +
        `• Le vote doit être unanime (un seul "Non" = refus)\n` +
        `• Les votes manquants après ${durationHours}h comptent comme "Oui"\n\n` +
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
    
    // Parser l'ID du vote (vote_... ou votekick_...)
    const match = customId.match(/^(vote(?:kick)?_\d+_\d+)_(yes|no)$/);
    if (!match) return;

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
      // Vote kick - PUBLIC avec noms des votants
      const durationMinutes = config.get('voteKick.durationMinutes') || 5;
      
      // Séparer les votes
      const kickVoters = [];
      const pardonVoters = [];
      
      for (const [userId, vote] of voteData.votes) {
        const member = voteData.exiledMembers.get(userId);
        if (member) {
          if (vote === 'yes') {
            kickVoters.push(member.user.tag);
          } else {
            pardonVoters.push(member.user.tag);
          }
        }
      }
      
      voteEmbed = new EmbedBuilder()
        .setTitle('⚠️ Vote Kick - Abus de @everyone')
        .setDescription(
          `**Coupable :** ${voteData.targetMember}\n\n` +
          `${voteData.targetMember.user.tag} a utilisé @everyone.\n\n` +
          `Un vote est lancé pour décider de son exclusion des Exilés.\n\n` +
          `**Règles :**\n` +
          `• Vote PUBLIC (non anonyme)\n` +
          `• Majorité absolue (>50%) requise pour kick\n` +
          `• Les votes manquants après ${durationMinutes} minutes comptent comme "Pardon"\n` +
          `• Si kick : retrait du rôle Exilés + expulsion du serveur\n\n` +
          `**Votes : ${voteData.votes.size}/${voteData.totalVoters}**\n\n` +
          `**👍 Kick (${kickVoters.length}) :** ${kickVoters.length > 0 ? kickVoters.join(', ') : 'Aucun'}\n` +
          `**🙏 Pardon (${pardonVoters.length}) :** ${pardonVoters.length > 0 ? pardonVoters.join(', ') : 'Aucun'}`
        )
        .setColor('#FF0000')
        .setTimestamp();
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
          `• Le vote doit être unanime (un seul "Non" = refus)\n` +
          `• Les votes manquants après ${durationHours}h comptent comme "Oui"\n\n` +
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

    // Vérifier l'unanimité (aucun "non")
    const isUnanimous = noCount === 0;

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

    if (isUnanimous) {
      // Vote unanime : attribuer le rôle
      const exilesRoleId = config.get('roles.exilesRoleId');
      
      try {
        await voteData.targetMember.roles.add(exilesRoleId);

        const successEmbed = new EmbedBuilder()
          .setTitle('✅ Vote réussi')
          .setDescription(
            `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
            `Le vote est unanime ! ${voteData.targetMember.user.tag} rejoint les Exilés.\n\n` +
            `**Résultats :**\n` +
            `✅ Oui : ${yesCount}\n` +
            `❌ Non : ${noCount}\n\n` +
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

        logger.security('Vote unanime réussi', {
          target: voteData.targetMember.user.tag,
          initiator: voteData.initiator.user.tag,
          votes: `${yesCount}/${voteData.totalVoters}`
        }, 'low');

      } catch (error) {
        logger.error('Erreur lors de l\'attribution du rôle:', error);
        await voteData.channel.send(
          `❌ Erreur lors de l'attribution du rôle à ${voteData.targetMember.user.tag}.`
        );
      }

    } else {
      // Vote non unanime : refus
      const failEmbed = new EmbedBuilder()
        .setTitle('❌ Vote échoué')
        .setDescription(
          `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
          `Le vote n'est pas unanime. ${voteData.targetMember.user.tag} ne peut pas rejoindre les Exilés.\n\n` +
          `**Résultats :**\n` +
          `✅ Oui : ${yesCount}\n` +
          `❌ Non : ${noCount}\n\n` +
          `Le vote doit être unanime pour accepter un nouveau membre.`
        )
        .setColor('#FF0000')
        .setTimestamp();

      await voteData.message.edit({
        embeds: [failEmbed],
        components: [disabledRow]
      });

      logger.info(`Vote échoué pour ${voteData.targetMember.user.tag} (${noCount} non)`);
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
      // Vote unanime : attribuer le rôle
      const exilesRoleId = config.get('roles.exilesRoleId');
      
      try {
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
      // Vote non unanime : refus
      const failEmbed = new EmbedBuilder()
        .setTitle('❌ Vote échoué')
        .setDescription(
          `**Candidat :** ${voteData.targetMember.user.tag}\n\n` +
          `Le vote n'est pas unanime. ${voteData.targetMember.user.tag} ne peut pas rejoindre les Exilés.\n\n` +
          `Le vote doit être unanime pour accepter un nouveau membre.`
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
   * Démarre un vote kick pour punir un @everyone
   */
  async startVoteKick(culprit, channel, message) {
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
    const voteId = `votekick_${Date.now()}_${culprit.id}`;

    // Récupérer la durée du vote kick depuis la config (en minutes)
    const durationMinutes = config.get('voteKick.durationMinutes') || 5;

    // Créer l'embed du vote kick
    const voteEmbed = new EmbedBuilder()
      .setTitle('⚠️ Vote Kick - Abus de @everyone')
      .setDescription(
        `**Coupable :** ${culprit}\n\n` +
        `${culprit.user.tag} a utilisé @everyone.\n\n` +
        `Un vote est lancé pour décider de son exclusion des Exilés.\n\n` +
        `**Règles :**\n` +
        `• Vote PUBLIC (non anonyme)\n` +
        `• Majorité absolue (>50%) requise pour kick\n` +
        `• Les votes manquants après ${durationMinutes} minutes comptent comme "Pardon"\n` +
        `• Si kick : retrait du rôle Exilés + expulsion du serveur\n\n` +
        `**Votes : 0/${exiledMembers.size}**\n\n` +
        `**👍 Kick (0) :** \n` +
        `**🙏 Pardon (0) :** `
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
      targetMember: culprit,
      message: voteMessage,
      channel: channel,
      originalMessage: message,
      exiledMembers: exiledMembers,
      votes: new Map(), // userId -> 'yes' | 'no'
      totalVoters: exiledMembers.size,
      startTime: Date.now()
    });

    logger.info(`Vote kick lancé pour ${culprit.user.tag} (abus @everyone)`);

    // Timeout configurable (en minutes pour le vote kick)
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

    // Les votes manquants comptent comme "non" (pardon)
    const missingCount = voteData.totalVoters - voteData.votes.size;
    pardonCount += missingCount;

    // Vérifier la majorité absolue (>50%)
    const totalVotes = kickCount + pardonCount;
    const hasAbsoluteMajority = kickCount > (totalVotes / 2);

    // Désactiver les boutons du message de vote
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${voteId}_yes`)
          .setLabel('✅ Kick')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${voteId}_no`)
          .setLabel('❌ Pardonner')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );

    try {
      await voteData.message.edit({
        components: [disabledRow]
      });
    } catch (error) {
      logger.error('Erreur lors de la désactivation des boutons:', error);
    }

    if (hasAbsoluteMajority) {
      // Majorité pour kick : retirer le rôle et kick
      const exilesRoleId = config.get('roles.exilesRoleId');
      
      try {
        // Retirer le rôle Exilés
        await voteData.targetMember.roles.remove(exilesRoleId);
        
        // Kick du serveur
        await voteData.targetMember.kick('Vote kick : Abus de @everyone - Majorité absolue atteinte');

        const kickEmbed = new EmbedBuilder()
          .setTitle('🚨 Vote Kick - Expulsion')
          .setDescription(
            `**Coupable :** ${voteData.targetMember.user.tag}\n\n` +
            `La majorité absolue a voté pour l'expulsion.\n\n` +
            `${voteData.targetMember.user.tag} a été retiré des Exilés et expulsé du serveur.`
          )
          .setColor('#FF0000')
          .setTimestamp();

        await voteData.channel.send({
          embeds: [kickEmbed]
        });

        logger.security('Vote kick réussi', {
          target: voteData.targetMember.user.tag,
          reason: 'Abus @everyone',
          votes: `${kickCount}/${totalVotes}`
        }, 'high');

      } catch (error) {
        logger.error('Erreur lors du kick:', error);
        await voteData.channel.send(
          `❌ Erreur lors de l'expulsion de ${voteData.targetMember.user.tag}.`
        );
      }

    } else {
      // Pas de majorité : pardon
      const pardonEmbed = new EmbedBuilder()
        .setTitle('✅ Vote Kick - Pardon accordé')
        .setDescription(
          `**Coupable :** ${voteData.targetMember.user.tag}\n\n` +
          `La majorité a choisi de pardonner.\n\n` +
          `${voteData.targetMember.user.tag} reste parmi les Exilés.`
        )
        .setColor('#00FF00')
        .setTimestamp();

      await voteData.channel.send({
        embeds: [pardonEmbed]
      });

      logger.info(`Vote kick échoué pour ${voteData.targetMember.user.tag} - Pardon accordé`);
    }

    // Supprimer le vote actif
    this.activeVotes.delete(voteId);
  }
}

export default VoteSystem;
