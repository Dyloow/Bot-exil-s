import OpenAI from 'openai';
import { EmbedBuilder } from 'discord.js';
import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';
import { normalizeMessage, buildTranscript, fitToBudget, resolveImages } from './summary/transcript.js';
import { parseRange } from './summary/range.js';
import { renderSummary, groupEmbeds } from './summary/render.js';

const TIME_ZONE = 'Europe/Paris';
const MAX_PARENT_PREFETCH = 20;
const TYPING_REFRESH_MS = 8000;
const RETRY_TOPICS_COUNT = 3;
const IMAGE_ERROR_RE = /image|invalid_image_url|download/i;

/**
 * Gère la commande `!résumé` : collecte les messages, construit le transcript, interroge l'IA et envoie le rendu.
 */
class SummaryManager {
  constructor(client, guild) {
    this.client = client;
    this.guild = guild;

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Dernier résumé lancé par channel, pour le cooldown
    this.lastRunByChannel = new Map();
    // Channels pour lesquels un résumé est en train d'être généré
    this.activeChannels = new Set();
    // Compteur de messages par channel, pour le seuil automatique
    this.messageCounters = new Map();
  }

  /**
   * Point d'entrée de la commande `!résumé` / `!resume` / `!summary`.
   */
  async generateSummaryCommand(message, args) {
    const range = parseRange(args, {
      defaultCount: config.get('summary.maxMessages'),
      maxCount: config.get('summary.maxCount'),
      maxHours: config.get('summary.maxHours'),
      now: new Date()
    });

    if (range.error) {
      await message.reply(range.error);
      return;
    }

    await this.runSummary(message.channel, range, { reply: (text) => message.reply(text) });
  }

  /**
   * Vérifie si le seuil automatique de messages est atteint et lance un résumé le cas échéant.
   */
  async checkAutoTrigger(channel) {
    const threshold = config.get('summary.autoTriggerThreshold');
    if (!threshold || threshold <= 0) return;

    const currentCount = (this.messageCounters.get(channel.id) || 0) + 1;
    this.messageCounters.set(channel.id, currentCount);

    if (currentCount < threshold) return;

    this.messageCounters.set(channel.id, 0);
    logger.info(`Seuil automatique atteint pour #${channel.name} (${currentCount} messages)`);

    await this.runSummary(
      channel,
      { mode: 'count', count: threshold },
      { reply: (text) => channel.send(text) }
    );
  }

  /**
   * Génère et envoie un résumé pour un channel, en gérant cooldown, verrou, statut et nettoyage.
   * Tout ce qui suit l'acquisition du verrou est protégé par try/finally, pour ne jamais le laisser
   * bloqué (ni l'intervalle de "typing...") si `reply()`, la collecte ou l'IA échouent.
   */
  async runSummary(channel, range, { reply }) {
    if (this.activeChannels.has(channel.id)) {
      await reply('⏳ Un résumé est déjà en cours de génération sur ce channel, patiente un peu.');
      return;
    }

    const cooldownSeconds = config.get('summary.cooldownSeconds') ?? 60;
    const lastRun = this.lastRunByChannel.get(channel.id);
    if (lastRun) {
      const elapsedSeconds = (Date.now() - lastRun) / 1000;
      if (elapsedSeconds < cooldownSeconds) {
        const waitSeconds = Math.ceil(cooldownSeconds - elapsedSeconds);
        await reply(`⏳ Merci de patienter encore ${waitSeconds}s avant un nouveau résumé sur ce channel.`);
        return;
      }
    }

    this.activeChannels.add(channel.id);
    // Posé dès le verrou (pas seulement en cas de succès) : un échec après l'appel IA ne doit pas
    // permettre de relancer immédiatement et refacturer des tokens.
    this.lastRunByChannel.set(channel.id, Date.now());

    let typingInterval = null;
    let statusMessage = null;

    try {
      typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), TYPING_REFRESH_MS);
      await channel.sendTyping().catch(() => {});

      statusMessage = await reply(
        range.mode === 'count'
          ? `⏳ Génération du résumé des ${range.count} derniers messages...`
          : `⏳ Génération du résumé des dernières ${range.label}...`
      );

      const window = await this.collectWindow(channel, range);

      if (window.messages.length === 0) {
        await statusMessage.edit('Rien à résumer sur cette période.');
        return;
      }

      const maxImages = config.get('summary.maxImages') ?? 6;
      const maxInputChars = config.get('summary.maxInputChars') ?? 60000;
      const maxTopics = config.get('summary.maxTopics') ?? 6;

      const { lines, candidates } = buildTranscript(window.messages, { timeZone: TIME_ZONE, byId: window.byId });
      const { lines: fittedLines, omittedMessageCount } = fitToBudget(lines, maxInputChars);
      const { lines: finalLines, images } = resolveImages(fittedLines, candidates, maxImages);
      const transcriptText = finalLines.join('\n');

      logger.info(
        `Résumé #${channel.name} : ${window.messages.length} messages (${omittedMessageCount} omis par le budget), transcript ${transcriptText.length} caractères, ${images.length} image(s)`
      );

      const result = await this.generateCompletion(transcriptText, images, maxTopics);

      if (result.finishReason === 'length') {
        await statusMessage.edit(
          "❌ Trop de choses à résumer pour une seule réponse, réessaie avec moins de messages (ex: `!résumé 50`)."
        );
        return;
      }

      const includedCount = window.messages.length - omittedMessageCount;
      const label = range.mode === 'count' ? `${window.messages.length} messages` : `dernières ${range.label}`;
      const meta = {
        channelName: channel.name,
        label,
        messageCount: window.messages.length,
        includedCount,
        omittedCount: omittedMessageCount,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        timeZone: TIME_ZONE
      };

      const embeds = renderSummary(result.content, meta);
      const groups = groupEmbeds(embeds);

      const targetChannel = this.resolveTargetChannel(channel);

      for (const group of groups) {
        await targetChannel.send({ embeds: group.map((embed) => new EmbedBuilder(embed)) });
      }

      if (targetChannel.id === channel.id) {
        await statusMessage.edit('✅ Résumé prêt.');
      } else {
        await statusMessage.delete().catch(() => {});
      }

      await logger.aiSummary(channel.name, window.messages.length, result.usage?.total_tokens ?? null);
    } catch (error) {
      logger.error('Erreur lors de la génération du résumé:', error);
      if (statusMessage) {
        await statusMessage.edit('❌ Une erreur est survenue lors de la génération du résumé.').catch(() => {});
      } else {
        await reply('❌ Une erreur est survenue lors de la génération du résumé.').catch(() => {});
      }
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      this.activeChannels.delete(channel.id);
    }
  }

  /**
   * Résout un id de mention en nom lisible (utilisateur, channel ou rôle).
   */
  resolveName(id, type) {
    if (type === 'channel') {
      return this.guild.channels.cache.get(id)?.name;
    }
    if (type === 'role') {
      return this.guild.roles.cache.get(id)?.name;
    }
    const member = this.guild.members.cache.get(id);
    return member?.displayName ?? this.client.users.cache.get(id)?.username;
  }

  /**
   * Détermine le channel de destination du résumé : celui configuré, sinon le channel courant.
   */
  resolveTargetChannel(fallbackChannel) {
    const summaryChannelId = config.get('server.summaryChannelId');
    if (summaryChannelId && !summaryChannelId.includes('FROM_ENV') && !summaryChannelId.includes('REMPLACER')) {
      const configured = this.guild.channels.cache.get(summaryChannelId);
      if (configured) return configured;
    }
    return fallbackChannel;
  }

  /**
   * Collecte la fenêtre de messages à résumer (par nombre ou depuis une date), avec le contexte des réponses.
   */
  async collectWindow(channel, range) {
    const excludeBots = config.get('summary.excludeBotMessages');
    const maxFetch = config.get('summary.maxFetch') ?? 2000;
    const botId = this.client.user?.id;

    const kept = [];
    let before;
    let totalFetched = 0;
    let reachedSince = false;

    while (totalFetched < maxFetch && (range.mode === 'count' ? kept.length < range.count : !reachedSince)) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;

      totalFetched += batch.size;
      before = batch.last().id;

      for (const msg of batch.values()) {
        if (range.mode === 'since' && msg.createdAt < range.since) {
          reachedSince = true;
          break;
        }

        if (this.shouldKeep(msg, botId, excludeBots)) {
          kept.push(msg);
        }

        if (range.mode === 'count' && kept.length >= range.count) break;
      }
    }

    kept.reverse(); // ordre chronologique : du plus ancien au plus récent

    const resolveName = (id, type) => this.resolveName(id, type);
    const normalized = kept.map((msg) => normalizeMessage(msg, resolveName));
    const byId = new Map(normalized.map((msg) => [msg.id, msg]));

    await this.prefetchReplyParents(channel, normalized, byId, resolveName);

    return {
      messages: normalized,
      byId,
      periodStart: normalized[0]?.createdAt ?? new Date(),
      periodEnd: normalized[normalized.length - 1]?.createdAt ?? new Date()
    };
  }

  /**
   * Détermine si un message brut doit entrer dans la fenêtre : on garde les messages courts,
   * on ne jette que les messages vides sans rien d'attaché, les commandes `!` et les messages du bot.
   */
  shouldKeep(msg, botId, excludeBots) {
    if (msg.author.id === botId) return false;
    if (excludeBots && msg.author.bot) return false;
    if (msg.content.startsWith('!')) return false;

    const hasAttachment = msg.attachments.size > 0 || msg.embeds.length > 0 || msg.stickers.size > 0;
    if (!msg.content.trim() && !hasAttachment) return false;

    return true;
  }

  /**
   * Pré-charge les messages parents (réponses) situés hors fenêtre, pour donner du contexte aux citations.
   */
  async prefetchReplyParents(channel, normalized, byId, resolveName) {
    const missingIds = [
      ...new Set(normalized.map((msg) => msg.replyToId).filter((id) => id && !byId.has(id)))
    ].slice(0, MAX_PARENT_PREFETCH);

    if (missingIds.length === 0) return;

    const results = await Promise.allSettled(missingIds.map((id) => channel.messages.fetch(id)));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const normalizedParent = normalizeMessage(result.value, resolveName);
        byId.set(normalizedParent.id, normalizedParent);
      }
    }
  }

  /**
   * Appelle l'IA, avec deux filets de sécurité : si une image fait échouer la requête, on retente en
   * texte seul ; si la réponse est coupée (`finish_reason === 'length'`), on retente avec moins de sujets.
   */
  async generateCompletion(transcriptText, images, maxTopics) {
    let usedImages = images;
    let result;

    try {
      result = await this.callAI(transcriptText, usedImages, maxTopics);
    } catch (error) {
      if (usedImages.length > 0 && this.looksLikeImageError(error)) {
        logger.warn(`Erreur IA liée aux images, nouvelle tentative sans images : ${error.message}`);
        usedImages = [];
        transcriptText += '\n\n(Les images ne sont pas disponibles : ne décris pas les [photo img N] / [GIF img N], mentionne seulement qu\'une image a été envoyée.)';
        result = await this.callAI(transcriptText, usedImages, maxTopics);
      } else {
        throw error;
      }
    }

    if (result.finishReason === 'length') {
      logger.warn('Réponse IA tronquée, nouvelle tentative avec moins de sujets...');
      result = await this.callAI(transcriptText, usedImages, Math.min(RETRY_TOPICS_COUNT, maxTopics));
    }

    return result;
  }

  /**
   * Détecte une erreur OpenAI liée au téléchargement/format d'une image, pour retenter en texte seul.
   */
  looksLikeImageError(error) {
    const haystack = [error?.message, error?.error?.message, error?.code, error?.error?.code]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return IMAGE_ERROR_RE.test(haystack);
  }

  /**
   * Appelle l'IA avec le transcript et les images collectées, en demandant un JSON structuré par sujets.
   * Chaque image est précédée d'un repère texte (`img N :`) pour que le modèle sache à quelle référence
   * du transcript elle correspond.
   */
  async callAI(transcriptText, images, maxTopics) {
    const model = config.get('ai.model');
    const maxTokens = config.get('ai.maxTokensOutput');
    const temperature = config.get('ai.temperature');

    const systemPrompt = `${config.get('ai.systemPrompt')}

Regroupe la conversation en ${maxTopics} sujets maximum. Réponds uniquement avec un JSON valide de cette forme, sans texte autour :
{"tldr": "résumé en 1-2 phrases", "topics": [{"title": "titre court", "emoji": "un emoji", "people": ["pseudo1", "pseudo2"], "summary": "1 à 3 phrases"}], "vibe": "l'ambiance générale en une phrase"}`;

    const userContent = [{ type: 'text', text: transcriptText }];
    for (const image of images) {
      userContent.push({ type: 'text', text: `${image.ref}:` });
      userContent.push({ type: 'image_url', image_url: { url: image.url, detail: 'low' } });
    }

    const requestParams = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: maxTokens
    };

    // gpt-5-nano ne supporte que temperature=1 (défaut)
    if (!model.includes('gpt-5-nano')) {
      requestParams.temperature = temperature;
    }

    const response = await this.openai.chat.completions.create(requestParams);
    const choice = response.choices[0];

    return {
      content: choice.message.content,
      finishReason: choice.finish_reason,
      usage: response.usage
    };
  }
}

export default SummaryManager;
