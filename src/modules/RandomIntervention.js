import OpenAI from 'openai';
import config from '../config/ConfigManager.js';
import logger from '../utils/Logger.js';

/**
 * Gère les interventions aléatoires du bot dans les conversations
 */
class RandomIntervention {
  constructor(client) {
    this.client = client;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    // Cooldown par channel pour éviter le spam
    this.lastInterventionByChannel = new Map();
  }

  /**
   * Vérifie si le bot doit intervenir sur ce message
   */
  shouldIntervene(message) {
    // Vérifier si activé
    if (!config.get('randomIntervention.enabled')) {
      return false;
    }

    // Ignorer les bots
    if (message.author.bot) {
      return false;
    }

    // Ignorer les commandes
    if (message.content.startsWith('!')) {
      return false;
    }

    // Ignorer les messages trop courts
    if (message.content.length < config.get('randomIntervention.minMessageLength')) {
      return false;
    }

    // Vérifier le cooldown
    const cooldown = config.get('randomIntervention.cooldownMinutes') * 60 * 1000;
    const lastIntervention = this.lastInterventionByChannel.get(message.channel.id);
    if (lastIntervention && Date.now() - lastIntervention < cooldown) {
      return false;
    }

    // Chance aléatoire d'intervenir
    const chance = config.get('randomIntervention.chancePercent');
    const random = Math.random() * 100;
    
    return random < chance;
  }

  /**
   * Génère une réponse basée sur le contexte
   */
  async generateResponse(message) {
    try {
      // Collecter les 10 derniers messages pour le contexte
      const contextSize = config.get('randomIntervention.contextMessages');
      const messages = await message.channel.messages.fetch({ limit: contextSize });
      
      // Formater le contexte
      const context = Array.from(messages.values())
        .reverse()
        .filter(msg => !msg.author.bot && !msg.content.startsWith('!'))
        .map(msg => `[${msg.author.username}]: ${msg.content}`)
        .join('\n');

      if (!context || context.trim().length < 20) {
        logger.warn('Contexte trop court pour générer une intervention');
        return null;
      }

      // Appeler GPT
      const model = config.get('randomIntervention.model');
      const temperature = config.get('randomIntervention.temperature');

      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: 'system',
            content: `Tu es JR, un bot Discord qui traîne sur le serveur et qui intervient de temps en temps dans les conversations de manière naturelle et spontanée.

RÈGLES :
- Réponds de manière courte et naturelle (1-2 phrases MAX)
- Ton style : cool, décontracté, parfois sarcastique ou drôle
- Tu peux réagir à ce qui se dit, faire une blague, donner ton avis, chambrer quelqu'un
- Parle comme un mec normal qui participe à la conv, pas comme un assistant
- Utilise "mdr", "wsh", "genre", "frr" etc. si ça colle
- Sois naturel, pas forcé : si t'as rien d'intéressant à dire, dis juste un truc simple
- JAMAIS de formules type "Je peux vous aider" ou "En tant que bot"
- Tu peux être un peu trash mais pas trop non plus

Interviens de manière pertinente par rapport au contexte de la conversation.`
          },
          {
            role: 'user',
            content: `Contexte de la conversation :\n\n${context}\n\nInterviens de manière naturelle :`
          }
        ],
        temperature: temperature,
        max_tokens: 100
      });

      return response.choices[0].message.content.trim();

    } catch (error) {
      logger.error('Erreur lors de la génération de l\'intervention aléatoire:', error);
      return null;
    }
  }

  /**
   * Traite un message et intervient si nécessaire
   */
  async handleMessage(message) {
    try {
      // Vérifier si on doit intervenir
      if (!this.shouldIntervene(message)) {
        return;
      }

      logger.info(`🎲 Intervention aléatoire déclenchée dans #${message.channel.name}`);

      // Générer la réponse
      const response = await this.generateResponse(message);

      if (!response) {
        return;
      }

      // Envoyer la réponse
      await message.channel.send(response);

      // Mettre à jour le cooldown
      this.lastInterventionByChannel.set(message.channel.id, Date.now());

      logger.info(`✅ Intervention envoyée: "${response}"`);

    } catch (error) {
      logger.error('Erreur lors du traitement de l\'intervention aléatoire:', error);
    }
  }
}

export default RandomIntervention;
