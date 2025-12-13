#!/bin/bash

# Script de déploiement pour le bot Discord
SERVER="node1.adky.net"
PORT="2022"
USER="lazy7zjp.c7b4ea51"
REMOTE_DIR="~/bot-exile"

echo "📦 Transfert de l'archive..."
scp -P $PORT /tmp/bot-exile.tar.gz $USER@$SERVER:~/

echo "🔧 Configuration du serveur distant..."
ssh -p $PORT $USER@$SERVER << 'ENDSSH'
# Créer le répertoire du bot
mkdir -p ~/bot-exile
cd ~/bot-exile

# Extraire l'archive
tar -xzf ~/bot-exile.tar.gz -C ~/bot-exile
rm ~/bot-exile.tar.gz

# Vérifier Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js n'est pas installé sur le serveur"
    echo "Veuillez installer Node.js 18+ manuellement"
    exit 1
fi

echo "📥 Installation des dépendances..."
npm install --production

# Vérifier PM2
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installation de PM2..."
    npm install -g pm2
fi

# Vérifier le fichier .env
if [ ! -f .env ]; then
    echo "Fichier .env manquant!"
    echo "Veuillez créer un fichier .env avec DISCORD_TOKEN et OPENAI_API_KEY"
    exit 1
fi

echo "🚀 Démarrage du bot avec PM2..."
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup

echo "✅ Déploiement terminé!"
echo "📊 Commandes utiles:"
echo "  pm2 status          - Voir le statut"
echo "  pm2 logs            - Voir les logs"
echo "  pm2 restart all     - Redémarrer"
echo "  pm2 stop all        - Arrêter"

ENDSSH

echo "✅ Déploiement terminé!"
