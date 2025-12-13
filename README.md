# Bot Discord Guardian

Bot Discord complet avec **résumés IA** (GPT-4o-mini) et **protection anti-abus** des permissions de modération.

## 🎯 Fonctionnalités principales

### 📝 Résumés IA automatiques
- Résumés des conversations via GPT-4o-mini
- Déclenchement manuel (`!résumé`) ou automatique
- Planification personnalisable (6x/jour par défaut)
- Seuil automatique basé sur le nombre de messages
- Coût optimisé (~0.002€ par résumé)

### Protection anti-abus
- Surveillance en temps réel des actions de modération
- Détection et rollback des bans/kicks abusifs
- Système de quotas (actions/heure, bans/jour, etc.)
- Protection du rôle du bot (aucun membre ne peut le modifier)
- Mode panique automatique en cas d'abus massif

### Validation collaborative
- Système de vote pour actions critiques
- Boutons interactifs dans Discord
- Délai de validation configurable
- Logs détaillés de toutes les validations

### 📊 Logging complet
- Tous les événements enregistrés (fichiers + Discord)
- Channel sécurisé pour les logs
- Purge automatique des anciens logs
- Embeds colorés selon la sévérité

---

## 🚀 Installation

### Prérequis

- **Node.js** 18+ ([télécharger](https://nodejs.org/))
- **Compte Discord Developer** ([portal](https://discord.com/developers/applications))
- **Clé API OpenAI** ([plateforme](https://platform.openai.com/api-keys))
- **Serveur Discord** avec permissions administrateur

---

### Étape 1 : Créer l'application Discord

1. Allez sur https://discord.com/developers/applications
2. Cliquez sur **"New Application"**
3. Donnez un nom à votre bot
4. Allez dans l'onglet **"Bot"**
5. Activez les **Privileged Gateway Intents** :
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
6. Copiez le **token** du bot (vous en aurez besoin plus tard)
7. Allez dans **"OAuth2" > "URL Generator"**
8. Sélectionnez :
   - **Scopes** : `bot`
   - **Bot Permissions** :
     - Administrator (ou minimum : Manage Roles, Kick Members, Ban Members, Manage Messages, Read Messages, Send Messages, Manage Channels)
9. Copiez l'URL générée et ouvrez-la dans votre navigateur pour inviter le bot

---

### Étape 2 : Cloner et configurer le projet

```bash
# Cloner le projet (si depuis Git)
git clone <url_du_repo>
cd discord-bot-guardian

# Installer les dépendances
npm install

# Créer le fichier .env
cp .env.example .env
```

Éditez le fichier `.env` :

```env
# Discord Configuration
DISCORD_TOKEN=VOTRE_TOKEN_BOT_ICI
GUILD_ID=VOTRE_SERVER_ID_ICI

# OpenAI Configuration
OPENAI_API_KEY=VOTRE_CLE_API_OPENAI_ICI

# Bot Configuration
NODE_ENV=production
```

**Comment trouver les IDs :**
- **GUILD_ID** : Clic droit sur votre serveur > Copier l'identifiant du serveur
- **Channel IDs** : Clic droit sur un channel > Copier l'identifiant
- **Role IDs** : Paramètres serveur > Rôles > Clic droit sur un rôle > Copier l'identifiant

> ⚠️ Activez le **Mode Développeur** dans Discord : Paramètres > Avancés > Mode développeur

---

### Étape 3 : Configurer le bot

Éditez le fichier `config.json` :

```json
{
  "server": {
    "guildId": "VOTRE_SERVER_ID",
    "logChannelId": "CHANNEL_LOGS_ID",
    "summaryChannelId": "CHANNEL_RÉSUMÉS_ID"
  },
  "roles": {
    "protectedRoleId": "ROLE_BOT_ID",
    "moderatorRoles": [
      "ROLE_MODO_1_ID",
      "ROLE_MODO_2_ID"
    ],
    "adminRoles": [
      "ROLE_ADMIN_ID"
    ]
  },
  "moderation": {
    "maxActionsPerHour": 5,
    "maxBansPerDay": 3,
    "maxKicksPerDay": 5,
    "maxDeletesPerMinute": 10,
    "validationDelaySeconds": 30,
    "requireConfirmationFor": ["ban", "massDelete"],
    "confirmationVotesRequired": 2,
    "panicModeThreshold": 10
  },
  "summary": {
    "enabled": true,
    "maxMessages": 100,
    "minMessageLength": 10,
    "excludeBotMessages": true,
    "autoTriggerThreshold": 150,
    "scheduledTimes": ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"],
    "maxTokens": 3000,
    "summaryLength": "brief"
  }
}
```

---

### Étape 4 : Créer les channels

Dans votre serveur Discord :

1. **Channel de logs** (privé, accès bot + admins uniquement)
   - Nom : `🔒-bot-logs`
   - Copier l'ID et le mettre dans `logChannelId`

2. **Channel des résumés** (optionnel)
   - Nom : `📝-résumés`
   - Copier l'ID et le mettre dans `summaryChannelId`

---

### Étape 5 : Permissions du bot

**Très important pour la sécurité :**

1. Allez dans **Paramètres du serveur > Rôles**
2. Déplacez le rôle du bot **tout en haut** (au-dessus de tous les autres rôles)
3. Assurez-vous qu'il a les permissions :
   - Administrator (recommandé)
   - Ou minimum : Gérer les rôles, Expulser, Bannir, Gérer les messages

> ⚠️ Le bot doit être **au-dessus** de tous les rôles qu'il doit protéger !

---

### Étape 6 : Lancer le bot

```bash
# Mode production
npm start

# Mode développement (avec auto-reload)
npm run dev
```

Si tout fonctionne, vous devriez voir :

```
ℹ️  🚀 Connexion au bot Discord...
ℹ️  Bot connecté en tant que VotreBot#1234
ℹ️  📍 Serveur: Nom de votre serveur
ℹ️  📝 Channel de logs configuré: #bot-logs
ℹ️  Module ModerationGuard initialisé
ℹ️  Module SummaryManager initialisé
ℹ️  Scheduler initialisé
ℹ️  🎉 Bot opérationnel
```

---

## 📖 Utilisation

### Commandes disponibles

| Commande | Description | Permissions requises |
|----------|-------------|---------------------|
| `!résumé [nombre]` | Génère un résumé des derniers messages | Modérateur |
| `!status` | Affiche l'état du bot | Tous |
| `!config` | Affiche la configuration | Modérateur |
| `!help` | Affiche l'aide | Tous |

### Exemples

```
!résumé           → Résume les 100 derniers messages
!résumé 50        → Résume les 50 derniers messages
!résumé 200       → Résume les 200 derniers messages (max 500)
```

---

## Sécurité

### Protection automatique

Le bot protège contre :

- Bans abusifs (rollback automatique)
- Kicks en masse
- Suppressions massives de messages
- Retrait du rôle protégé (restauration automatique)
- Actions trop fréquentes (quotas)
- Mode panique (blocage temporaire en cas d'abus massif)

### Système de validation

Pour les actions critiques (bans, suppressions massives), le bot demande une validation :

1. L'action est tentée
2. Le bot envoie une demande de validation dans `#bot-logs`
3. D'autres modérateurs votent avec les boutons ✅/❌
4. Si suffisamment de votes ✅, l'action est approuvée
5. Sinon, l'action est bloquée après le délai

### Logs

Tous les événements sont loggés :
- **Fichiers** : `/logs/YYYY-MM-DD.log` (JSON)
- **Discord** : Embeds dans le channel configuré

---

## 💰 Coût estimé

### OpenAI (GPT-4o-mini)

- **Input** : $0.15 / 1M tokens
- **Output** : $0.60 / 1M tokens

Pour 6 résumés/jour :
- ~3000 tokens input/résumé = 18k tokens/jour = 540k/mois
- ~500 tokens output/résumé = 3k tokens/jour = 90k/mois

**Coût mensuel** : (540k × $0.15 + 90k × $0.60) / 1M = **~$0.13/mois** ≈ **0.12€/mois**

**Coût annuel** : **~1.50€/an**

### Hébergement

Options :

1. **Raspberry Pi** (chez vous) : 0€/mois
2. **VPS Basic** (Contabo, Hetzner) : 4-5€/mois
3. **Bot Hosting** (BotGhost, Railway) : 5-10€/mois
4. **Gratuit** (Replit, Render) : 0€/mois (avec limitations)

**Total annuel** : **~50-120€/an** (ou 0€ si hébergement gratuit/local)

---

## 🚀 Déploiement 24/7

### Option 1 : VPS (recommandé)

```bash
# Sur votre VPS (Ubuntu/Debian)
sudo apt update
sudo apt install nodejs npm

# Installer PM2 pour garder le bot actif
npm install -g pm2

# Lancer le bot
cd /chemin/vers/bot
pm2 start src/index.js --name discord-bot

# Auto-restart au démarrage du serveur
pm2 startup
pm2 save
```

### Option 2 : Systemd (Linux)

Créez `/etc/systemd/system/discord-bot.service` :

```ini
[Unit]
Description=Discord Bot Guardian
After=network.target

[Service]
Type=simple
User=votre_user
WorkingDirectory=/chemin/vers/bot
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Puis :

```bash
sudo systemctl enable discord-bot
sudo systemctl start discord-bot
sudo systemctl status discord-bot
```

### Option 3 : Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["node", "src/index.js"]
```

```bash
docker build -t discord-bot .
docker run -d --name discord-bot --restart unless-stopped discord-bot
```

---

## 🔧 Configuration avancée

### Ajuster les quotas

Dans `config.json` :

```json
"moderation": {
  "maxActionsPerHour": 10,      // Actions totales par heure
  "maxBansPerDay": 5,            // Bans par jour
  "maxKicksPerDay": 10,          // Kicks par jour
  "maxDeletesPerMinute": 20,     // Suppressions par minute
  "panicModeThreshold": 15       // Seuil mode panique
}
```

### Personnaliser les résumés

```json
"summary": {
  "autoTriggerThreshold": 200,   // Nb de messages avant résumé auto
  "scheduledTimes": ["08:00", "20:00"],  // Heures des résumés
  "maxTokens": 5000              // Taille max du contexte
},
"ai": {
  "temperature": 0.5,            // Créativité (0-1)
  "maxTokensOutput": 800,        // Taille du résumé
  "systemPrompt": "Votre prompt personnalisé..."
}
```

---

## 🐛 Dépannage

### Le bot ne démarre pas

```bash
# Vérifier les variables d'environnement
cat .env

# Vérifier les dépendances
npm install

# Lancer en mode debug
NODE_ENV=development npm start
```

### Le bot ne répond pas aux commandes

- Vérifier que le bot a bien le **Message Content Intent** activé
- Vérifier les permissions du bot dans le serveur
- Vérifier les rôles dans `config.json`

### Les résumés ne fonctionnent pas

- Vérifier que `OPENAI_API_KEY` est correcte
- Vérifier le crédit OpenAI : https://platform.openai.com/usage
- Consulter les logs : `logs/YYYY-MM-DD.log`

### Le bot ne détecte pas les abus

- Vérifier que le rôle du bot est **au-dessus** des autres rôles
- Vérifier les permissions "Voir les logs d'audit"
- Vérifier `config.json` > `roles.moderatorRoles`

---

## 📚 Structure du projet

```
discord-bot-guardian/
├── src/
│   ├── index.js                 # Point d'entrée principal
│   ├── config/
│   │   └── ConfigManager.js     # Gestion de la config
│   ├── modules/
│   │   ├── ModerationGuard.js   # Protection anti-abus
│   │   ├── SummaryManager.js    # Résumés IA
│   │   ├── ValidationSystem.js  # Validation collaborative
│   │   └── Scheduler.js         # Tâches planifiées
│   └── utils/
│       └── Logger.js            # Système de logs
├── logs/                        # Logs (créé automatiquement)
├── config.json                  # Configuration principale
├── .env                         # Variables d'environnement
└── package.json                 # Dépendances Node.js
```

---

## 🤝 Contribution

Ce bot est conçu pour être modulaire et extensible. Vous pouvez :

- Ajouter de nouveaux modules dans `src/modules/`
- Personnaliser les embeds dans les fichiers existants
- Ajouter de nouvelles commandes dans `src/index.js`

---

## 📄 Licence

MIT License - Libre d'utilisation et de modification.

---

## 🆘 Support

En cas de problème :

1. Consultez les logs : `logs/YYYY-MM-DD.log`
2. Vérifiez la configuration : `!config`
3. Vérifiez le statut : `!status`
4. Consultez la documentation Discord.js : https://discord.js.org/

---

## ⚡ Prochaines évolutions possibles

- [ ] Dashboard web pour gérer le bot
- [ ] Export des logs en CSV
- [ ] Statistiques de modération
- [ ] Résumés multi-channels
- [ ] Analyse de tendances
- [ ] Système de points de confiance pour les modérateurs
- [ ] Support de plusieurs serveurs

---

**Profitez de votre bot sécurisé ! 🎉**
# Bot-exil-s
