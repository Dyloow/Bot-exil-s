import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Charge la configuration depuis config.json
 */
class Config {
  constructor() {
    this.configPath = path.join(__dirname, '../config.json');
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error('Erreur lors du chargement de la configuration:', error.message);
      process.exit(1);
    }
  }

  /**
   * Recharge la configuration depuis le fichier
   */
  reload() {
    this.config = this.loadConfig();
    return this.config;
  }

  /**
   * Récupère une valeur de configuration
   * @param {string} path - Chemin vers la valeur (ex: 'server.guildId')
   * @returns {any}
   */
  get(path) {
    const keys = path.split('.');
    let value = this.config;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  /**
   * Vérifie si un utilisateur est whitelisté
   */
  isWhitelisted(userId) {
    const whitelist = this.get('security.whitelistedUsers') || [];
    return whitelist.includes(userId);
  }

  /**
   * Vérifie si un rôle est autorisé à modérer
   */
  isModeratorRole(roleId) {
    const moderatorRoles = this.get('roles.moderatorRoles') || [];
    const adminRoles = this.get('roles.adminRoles') || [];
    return moderatorRoles.includes(roleId) || adminRoles.includes(roleId);
  }

  /**
   * Vérifie si un rôle est administrateur
   */
  isAdminRole(roleId) {
    const adminRoles = this.get('roles.adminRoles') || [];
    return adminRoles.includes(roleId);
  }

  /**
   * Vérifie si un membre a les permissions de modération
   */
  hasModerationPermissions(member) {
    if (this.isWhitelisted(member.id)) return true;
    
    const memberRoles = member.roles.cache.map(r => r.id);
    return memberRoles.some(roleId => this.isModeratorRole(roleId));
  }

  /**
   * Vérifie si un membre a les permissions d'administration
   */
  hasAdminPermissions(member) {
    if (this.isWhitelisted(member.id)) return true;
    
    const memberRoles = member.roles.cache.map(r => r.id);
    return memberRoles.some(roleId => this.isAdminRole(roleId));
  }

  /**
   * Valide la configuration au démarrage
   */
  validate() {
    const required = [
      'server.guildId',
      'ai.model'
    ];

    const missing = required.filter(path => !this.get(path));
    
    if (missing.length > 0) {
      console.error('Configuration incomplète. Valeurs manquantes:');
      missing.forEach(path => console.error(`  - ${path}`));
      return false;
    }

    // Avertissements pour config partielle
    const warnings = [];
    if (!this.get('server.logChannelId') || this.get('server.logChannelId').includes('REMPLACER')) {
      warnings.push('server.logChannelId - Logs Discord désactivés');
    }
    if (!this.get('roles.moderatorRoles') || this.get('roles.moderatorRoles')[0]?.includes('REMPLACER')) {
      warnings.push('roles.moderatorRoles - Protection limitée');
    }

    if (warnings.length > 0) {
      console.warn('Configuration partielle détectée:');
      warnings.forEach(w => console.warn(`  - ${w}`));
      console.warn('Le bot fonctionnera en mode limité. Configurez config.json pour activer toutes les fonctionnalités.');
    }

    return true;
  }
}

export default new Config();
