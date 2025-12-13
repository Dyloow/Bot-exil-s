import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/**
 * Système de validation collaborative pour les actions critiques
 */
class ValidationSystem {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;

    // Demandes de validation en attente
    this.pendingValidations = new Map();

    // Écouter les interactions des boutons
    this.setupButtonHandler();
  }

  /**
   * Configure le handler pour les boutons de validation
   */
  setupButtonHandler() {
    this.client.on('interactionCreate', async interaction => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith('validate_')) return;

      await this.handleValidationButton(interaction);
    });
  }

  /**
   * Demande une validation pour une action critique
   */
  async requestValidation(executor, actionType, target) {
    const votesRequired = config.get('moderation.confirmationVotesRequired');
    const delaySeconds = config.get('moderation.validationDelaySeconds');

    // Générer un ID unique pour cette validation
    const validationId = `${Date.now()}_${executor.id}_${actionType}`;

    // Créer l'objet de validation
    const validation = {
      id: validationId,
      executor: executor,
      actionType: actionType,
      target: target,
      votes: new Set(),
      votesRequired: votesRequired,
      createdAt: Date.now(),
      expiresAt: Date.now() + (delaySeconds * 1000),
      resolved: false,
      approved: false
    };

    this.pendingValidations.set(validationId, validation);

    // Envoyer la demande de validation
    await this.sendValidationRequest(validation);

    // Attendre la validation ou l'expiration
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const current = this.pendingValidations.get(validationId);
        
        if (!current || current.resolved) {
          clearInterval(checkInterval);
          resolve(current ? current.approved : false);
        } else if (Date.now() > current.expiresAt) {
          // Expiration
          current.resolved = true;
          current.approved = false;
          this.pendingValidations.delete(validationId);
          clearInterval(checkInterval);
          
          logger.warn(`Validation expirée pour ${actionType} par ${executor.tag}`);
          resolve(false);
        }
      }, 1000);
    });
  }

  /**
   * Envoie la demande de validation dans le channel de logs
   */
  async sendValidationRequest(validation) {
    const logChannelId = config.get('server.logChannelId');
    const logChannel = this.guild.channels.cache.get(logChannelId);

    if (!logChannel) {
      logger.error('Channel de logs introuvable pour la validation');
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle('VALIDATION REQUISE')
      .setDescription(`Une action critique nécessite validation`)
      .addFields(
        { name: 'Action', value: validation.actionType, inline: true },
        { name: 'Exécuteur', value: `<@${validation.executor.id}>`, inline: true },
        { name: 'Cible', value: validation.target ? validation.target.toString() : 'N/A', inline: true },
        { name: 'Votes requis', value: `${validation.votesRequired}`, inline: true },
        { name: 'Délai', value: `${config.get('moderation.validationDelaySeconds')}s`, inline: true },
        { name: 'Statut', value: 'En attente', inline: true }
      )
      .setFooter({ text: `ID: ${validation.id}` })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`validate_approve_${validation.id}`)
          .setLabel('Approuver')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`validate_reject_${validation.id}`)
          .setLabel('Rejeter')
          .setStyle(ButtonStyle.Danger)
      );

    try {
      const message = await logChannel.send({
        embeds: [embed],
        components: [row],
        content: `@here Validation requise !`
      });

      validation.messageId = message.id;
      validation.channelId = logChannel.id;

    } catch (error) {
      logger.error('Erreur lors de l\'envoi de la demande de validation:', error);
    }
  }

  /**
   * Gère le clic sur un bouton de validation
   */
  async handleValidationButton(interaction) {
    const [action, vote, validationId] = interaction.customId.split('_').slice(1);

    const validation = this.pendingValidations.get(validationId);

    if (!validation) {
      await interaction.reply({
        content: 'Cette validation n\'existe plus ou a expiré.',
        ephemeral: true
      });
      return;
    }

    if (validation.resolved) {
      await interaction.reply({
        content: 'Cette validation a déjà été résolue.',
        ephemeral: true
      });
      return;
    }

    // Vérifier que l'utilisateur a les permissions
    const member = interaction.member;
    if (!config.hasModerationPermissions(member)) {
      await interaction.reply({
        content: 'Vous n\'avez pas la permission de voter.',
        ephemeral: true
      });
      return;
    }

    // Empêcher l'exécuteur de voter pour sa propre action
    if (interaction.user.id === validation.executor.id) {
      await interaction.reply({
        content: 'Vous ne pouvez pas voter pour votre propre action.',
        ephemeral: true
      });
      return;
    }

    // Enregistrer le vote
    const voteKey = `${interaction.user.id}_${vote}`;
    
    // Retirer les anciens votes de cet utilisateur
    validation.votes.forEach(v => {
      if (v.startsWith(interaction.user.id)) {
        validation.votes.delete(v);
      }
    });

    validation.votes.add(voteKey);

    // Compter les votes
    const approvals = Array.from(validation.votes).filter(v => v.endsWith('approve')).length;
    const rejections = Array.from(validation.votes).filter(v => v.endsWith('reject')).length;

    await interaction.reply({
      content: `Vote enregistré ! Approbations: ${approvals}/${validation.votesRequired}, Rejets: ${rejections}`,
      ephemeral: true
    });

    // Vérifier si la validation est complète
    if (approvals >= validation.votesRequired) {
      validation.resolved = true;
      validation.approved = true;
      await this.resolveValidation(validation, true, approvals);
    } else if (rejections >= validation.votesRequired) {
      validation.resolved = true;
      validation.approved = false;
      await this.resolveValidation(validation, false, rejections);
    }

    // Mettre à jour le message
    await this.updateValidationMessage(validation, approvals, rejections);
  }

  /**
   * Met à jour le message de validation
   */
  async updateValidationMessage(validation, approvals, rejections) {
    try {
      const channel = this.guild.channels.cache.get(validation.channelId);
      if (!channel) return;

      const message = await channel.messages.fetch(validation.messageId);
      if (!message) return;

      const embed = message.embeds[0];
      const newEmbed = EmbedBuilder.from(embed);

      // Mettre à jour le statut
      const statusField = newEmbed.data.fields.find(f => f.name === 'Statut');
      if (statusField) {
        if (validation.resolved) {
          statusField.value = validation.approved ? 'APPROUVÉ' : 'REJETÉ';
          newEmbed.setColor(validation.approved ? 0x2ecc71 : 0xe74c3c);
        } else {
          statusField.value = `Approbations: ${approvals}/${validation.votesRequired}, Rejets: ${rejections}`;
        }
      }

      // Désactiver les boutons si résolu
      const components = validation.resolved ? [] : message.components;

      await message.edit({
        embeds: [newEmbed],
        components: components
      });

    } catch (error) {
      logger.error('Erreur lors de la mise à jour du message de validation:', error);
    }
  }

  /**
   * Résout une validation
   */
  async resolveValidation(validation, approved, voteCount) {
    this.pendingValidations.delete(validation.id);

    await logger.security(
      `Validation ${approved ? 'approuvée' : 'rejetée'}`,
      {
        action: validation.actionType,
        executor: validation.executor.tag,
        votes: voteCount,
        required: validation.votesRequired
      },
      approved ? 'low' : 'medium'
    );
  }

  /**
   * Nettoie les validations expirées
   */
  cleanupExpiredValidations() {
    const now = Date.now();
    
    for (const [id, validation] of this.pendingValidations) {
      if (now > validation.expiresAt && !validation.resolved) {
        validation.resolved = true;
        validation.approved = false;
        this.pendingValidations.delete(id);
        
        logger.warn(`Validation ${id} expirée automatiquement`);
      }
    }
  }
}

export default ValidationSystem;
