import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Système de logging centralisé pour toutes les actions du bot
 */
class Logger {
  constructor() {
    this.logsDir = path.join(__dirname, '../../logs');
    this.ensureLogsDirectory();
    this.logChannel = null;
  }

  /**
   * Crée le dossier de logs s'il n'existe pas
   */
  ensureLogsDirectory() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * Définit le channel Discord pour les logs
   */
  setLogChannel(channel) {
    this.logChannel = channel;
  }

  /**
   * Formate la date pour les noms de fichiers
   */
  getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * Écrit dans un fichier de log
   */
  writeToFile(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      data
    };

    const filename = `${this.getDateString()}.log`;
    const filepath = path.join(this.logsDir, filename);

    try {
      fs.appendFileSync(
        filepath,
        JSON.stringify(logEntry) + '\n',
        'utf8'
      );
    } catch (error) {
      console.error('Erreur lors de l\'écriture du log:', error);
    }
  }

  /**
   * Log d'information
   */
  info(message, data = {}) {
    console.log(`${message}`);
    this.writeToFile('INFO', message, data);
  }

  /**
   * Log d'avertissement
   */
  warn(message, data = {}) {
    console.warn(`${message}`);
    this.writeToFile('WARN', message, data);
  }

  /**
   * Log d'erreur
   */
  error(message, error = null, data = {}) {
    console.error(`${message}`, error);
    this.writeToFile('ERROR', message, {
      ...data,
      error: error ? {
        message: error.message,
        stack: error.stack
      } : null
    });
  }

  /**
   * Log de sécurité (actions critiques)
   */
  async security(action, details, severity = 'medium') {
    const message = ` [SÉCURITÉ] ${action}`;
    console.log(message);
    
    this.writeToFile('SECURITY', action, {
      severity,
      ...details
    });

    // Envoyer également au channel de logs Discord
    if (this.logChannel) {
      await this.sendToDiscord('security', action, details, severity);
    }
  }

  /**
   * Log d'action de modération
   */
  async moderation(action, executor, target, reason, actionData = {}) {
    const message = `[MODÉRATION] ${action} par ${executor.tag} sur ${target}`;
    console.log(message);

    const details = {
      action,
      executor: {
        id: executor.id,
        tag: executor.tag
      },
      target,
      reason,
      ...actionData
    };

    this.writeToFile('MODERATION', action, details);

    if (this.logChannel) {
      await this.sendToDiscord('moderation', action, details);
    }
  }

  /**
   * Log d'abus détecté
   */
  async abuse(action, details) {
    const message = `[ABUS DÉTECTÉ] ${action}`;
    console.error(message);

    this.writeToFile('ABUSE', action, details);

    if (this.logChannel) {
      await this.sendToDiscord('abuse', action, details, 'high');
    }
  }

  /**
   * Log de résumé IA
   */
  async aiSummary(channelName, messageCount, tokensUsed) {
    const message = `Résumé IA généré pour #${channelName} (${messageCount} messages, ${tokensUsed} tokens)`;
    console.log(message);

    this.writeToFile('AI_SUMMARY', message, {
      channel: channelName,
      messageCount,
      tokensUsed
    });
  }

  /**
   * Envoie un log au channel Discord
   */
  async sendToDiscord(type, action, details, severity = 'medium') {
    if (!this.logChannel) return;

    const colors = {
      security: {
        low: 0x3498db,    // Bleu
        medium: 0xf39c12, // Orange
        high: 0xe74c3c    // Rouge
      },
      moderation: 0x9b59b6,  // Violet
      abuse: 0xe74c3c,       // Rouge
      info: 0x2ecc71         // Vert
    };

    const color = type === 'security' || type === 'abuse'
      ? colors[type][severity] || colors[type]
      : colors[type] || colors.info;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(this.getEmojiForType(type) + ' ' + action)
      .setTimestamp();

    // Ajouter les détails pertinents
    if (details.executor) {
      embed.addFields({
        name: 'Exécuteur',
        value: `<@${details.executor.id}> (${details.executor.tag})`,
        inline: true
      });
    }

    if (details.target) {
      embed.addFields({
        name: 'Cible',
        value: details.target,
        inline: true
      });
    }

    if (details.reason) {
      embed.addFields({
        name: 'Raison',
        value: details.reason,
        inline: false
      });
    }

    if (details.rollback) {
      embed.addFields({
        name: 'Action corrective',
        value: details.rollback,
        inline: false
      });
    }

    if (severity === 'high') {
      embed.setFooter({ text: 'ALERTE DE HAUTE PRIORITÉ' });
    }

    try {
      await this.logChannel.send({ embeds: [embed] });
    } catch (error) {
      console.error('Erreur lors de l\'envoi du log Discord:', error);
    }
  }

  /**
   * Retourne l'emoji approprié selon le type de log
   */
  getEmojiForType(type) {
    const emojis = {
      security: '',
      moderation: '',
      abuse: '',
      info: ''
    };
    return emojis[type] || '';
  }

  /**
   * Purge les anciens logs (selon la configuration)
   */
  async purgeOldLogs(retentionDays = 30) {
    const now = Date.now();
    const files = fs.readdirSync(this.logsDir);

    let purged = 0;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;

      const filepath = path.join(this.logsDir, file);
      const stats = fs.statSync(filepath);
      const ageInDays = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays > retentionDays) {
        fs.unlinkSync(filepath);
        purged++;
      }
    }

    if (purged > 0) {
      this.info(`Purge des logs: ${purged} fichier(s) supprimé(s)`);
    }
  }
}

export default new Logger();
