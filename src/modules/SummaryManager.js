import OpenAI from 'openai';
import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';
import { EmbedBuilder } from 'discord.js';

/**
 * Gère les résumés IA des conversations Discord
 */
class SummaryManager {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;
    
    // Initialiser OpenAI
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Cache pour éviter les doublons
    this.recentSummaries = new Map();
    
    // Compteur de messages par channel
    this.messageCounters = new Map();
  }

  /**
   * Génère un résumé via commande
   */
  async generateSummaryCommand(message, args) {
    // Vérifier les permissions
    const member = message.guild.members.cache.get(message.author.id);

    // Nombre de messages à résumer
    const count = parseInt(args[0]) || config.get('summary.maxMessages');
    
    if (count < 10 || count > 500) {
      await message.reply('Le nombre de messages doit être entre 10 et 500.');
      return;
    }

    await message.reply(`Génération du résumé des ${count} derniers messages...`);

    try {
      const summary = await this.generateSummary(message.channel, count);
      
      if (summary) {
        await this.sendSummary(message.channel, summary, count);
      } else {
        await message.reply('Impossible de générer le résumé.');
      }
    } catch (error) {
      logger.error('Erreur lors de la génération du résumé:', error);
      await message.reply('Une erreur est survenue lors de la génération du résumé.');
    }
  }

  /**
   * Génère un résumé pour un channel
   */
  async generateSummary(channel, messageCount = null) {
    try {
      const count = messageCount || config.get('summary.maxMessages');

      // Collecter les messages
      logger.info(`Collecte des messages pour #${channel.name}...`);
      const messages = await this.collectMessages(channel, count);

      logger.info(`${messages.length} messages collectés`);

      if (messages.length === 0) {
        logger.warn('Aucun message à résumer');
        return null;
      }

      // Pré-traiter les messages
      const processedText = this.preprocessMessages(messages);

      logger.info(`Texte traité: ${processedText.length} caractères`);

      if (!processedText || processedText.trim().length < 50) {
        logger.warn('Texte traité trop court pour générer un résumé');
        return null;
      }

      // Limiter les tokens
      const truncatedText = this.truncateToTokenLimit(processedText);

      // Appeler l'IA
      logger.info(`Appel à l'IA pour résumer ${messages.length} messages...`);
      const summary = await this.callAI(truncatedText, channel.name);

      // Enregistrer le résumé
      this.recentSummaries.set(channel.id, Date.now());

      // Log
      await logger.aiSummary(channel.name, messages.length, truncatedText.length);

      // Réinitialiser le compteur
      this.messageCounters.set(channel.id, 0);

      return summary;

    } catch (error) {
      logger.error('Erreur lors de la génération du résumé:', error);
      return null;
    }
  }

  /**
   * Collecte les messages d'un channel
   */
  async collectMessages(channel, limit) {
    const messages = [];
    const excludeBots = config.get('summary.excludeBotMessages');
    const minLength = config.get('summary.minMessageLength');

    try {
      // Fetch max 200 messages bruts pour éviter d'être trop lent
      const maxFetch = Math.min(limit * 2, 200);
      
      logger.info(`Fetch de max ${maxFetch} messages bruts...`);
      const fetchedMessages = await channel.messages.fetch({ limit: maxFetch });
      
      logger.info(`${fetchedMessages.size} messages récupérés, filtrage...`);

      // Filtrer et limiter
      for (const [id, msg] of fetchedMessages) {
        // Filtrer les messages
        if (excludeBots && msg.author.bot) continue;
        if (msg.content.length < minLength) continue;
        if (msg.content.startsWith('!')) continue; // Ignorer les commandes
        
        messages.push({
          author: msg.author.username,
          content: msg.content,
          timestamp: msg.createdAt
        });

        // Arrêter si on a assez de messages
        if (messages.length >= limit) break;
      }

      // Inverser pour avoir l'ordre chronologique
      return messages.reverse();

    } catch (error) {
      logger.error('Erreur lors de la collecte des messages:', error);
      return [];
    }
  }

  /**
   * Pré-traite les messages pour l'IA
   */
  preprocessMessages(messages) {
    // Formater les messages
    const formatted = messages.map(msg => {
      // Nettoyer le contenu
      let content = msg.content
        .replace(/<@!?\d+>/g, '@user')  // Mentions
        .replace(/<#\d+>/g, '#channel')  // Channels
        .replace(/<:\w+:\d+>/g, '')      // Emojis custom
        .replace(/https?:\/\/\S+/g, '[lien]') // URLs
        .trim();

      // Format: [Auteur] message
      return `[${msg.author}] ${content}`;
    }).filter(msg => msg.length > 10);

    return formatted.join('\n');
  }

  /**
   * Tronque le texte pour respecter la limite de tokens
   */
  truncateToTokenLimit(text) {
    const maxTokens = config.get('summary.maxTokens');
    const maxChars = maxTokens * 4; // Approximation: 1 token ≈ 4 caractères

    if (text.length <= maxChars) {
      return text;
    }

    logger.warn(`Texte tronqué de ${text.length} à ${maxChars} caractères`);
    return text.substring(0, maxChars) + '\n[... messages suivants omis ...]';
  }

  /**
   * Appelle l'IA pour générer le résumé
   */
  async callAI(text, channelName) {
    try {
      logger.info(`Appel à l'API OpenAI...`);
      
      const systemPrompt = config.get('ai.systemPrompt');
      const model = config.get('ai.model');
      const maxTokens = config.get('ai.maxTokensOutput');
      const temperature = config.get('ai.temperature');

      const requestParams = {
        model: model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: `Voici les messages du channel Discord #${channelName} à résumer :\n\n${text}`
          }
        ],
        max_tokens: maxTokens
      };

      // gpt-5-nano ne supporte que temperature=1 (défaut)
      if (!model.includes('gpt-5-nano')) {
        requestParams.temperature = temperature;
      }

      logger.info(`Envoi de la requête à OpenAI (model: ${model}, max_tokens: ${maxTokens})...`);
      const response = await this.openai.chat.completions.create(requestParams);
      
      logger.info(`Réponse reçue de OpenAI`);
      return response.choices[0].message.content;

    } catch (error) {
      logger.error('Erreur lors de l\'appel à l\'API OpenAI:', error);
      throw error;
    }
  }

  /**
   * Envoie le résumé dans le channel
   */
  async sendSummary(channel, summary, messageCount) {
    const summaryChannelId = config.get('server.summaryChannelId');
    
    // Vérifier que l'ID est valide (pas FROM_ENV ou REMPLACER)
    let targetChannel = channel;
    if (summaryChannelId && !summaryChannelId.includes('FROM_ENV') && !summaryChannelId.includes('REMPLACER')) {
      const configuredChannel = this.guild.channels.cache.get(summaryChannelId);
      if (configuredChannel) {
        targetChannel = configuredChannel;
      }
    }

    // Discord limite à 4096 caractères pour la description d'un embed
    let truncatedSummary = summary;
    if (summary.length > 4000) {
      truncatedSummary = summary.substring(0, 3997) + '...';
      logger.warn(`Résumé tronqué de ${summary.length} à 4000 caractères`);
    }

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`Résumé - #${channel.name}`)
      .setDescription(truncatedSummary);

    try {
      await targetChannel.send({ embeds: [embed] });
      logger.info(`Résumé envoyé dans #${targetChannel.name}`);
    } catch (error) {
      logger.error('Erreur lors de l\'envoi du résumé:', error);
      throw error;
    }
  }

  /**
   * Vérifie si le seuil automatique est atteint
   */
  async checkAutoTrigger(channel) {
    const threshold = config.get('summary.autoTriggerThreshold');
    if (!threshold || threshold <= 0) return;

    // Incrémenter le compteur
    const currentCount = (this.messageCounters.get(channel.id) || 0) + 1;
    this.messageCounters.set(channel.id, currentCount);

    // Vérifier le seuil
    if (currentCount >= threshold) {
      logger.info(`Seuil automatique atteint pour #${channel.name} (${currentCount} messages)`);
      
      // Générer le résumé automatiquement
      const summary = await this.generateSummary(channel);
      if (summary) {
        await this.sendSummary(channel, summary, currentCount);
      }
    }
  }

  /**
   * Génère des résumés pour tous les channels actifs (tâche planifiée)
   */
  async generateScheduledSummaries() {
    logger.info('📅 Génération des résumés planifiés...');

    const channels = this.guild.channels.cache.filter(ch => 
      ch.isTextBased() && !ch.name.includes('log')
    );

    let generated = 0;
    for (const [id, channel] of channels) {
      // Vérifier si le channel a suffisamment de messages
      const messageCount = this.messageCounters.get(id) || 0;
      
      if (messageCount >= 50) { // Minimum de messages pour un résumé planifié
        const summary = await this.generateSummary(channel);
        if (summary) {
          await this.sendSummary(channel, summary, messageCount);
          generated++;
        }

        // Attendre 2 secondes entre chaque résumé
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    logger.info(`${generated} résumé(s) planifié(s) généré(s)`);
  }
}

export default SummaryManager;
