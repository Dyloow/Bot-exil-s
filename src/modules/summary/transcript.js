/**
 * Transcript pur : convertit des messages Discord en texte lisible pour l'IA.
 * Aucun import discord.js / openai ici, pour rester testable sans réseau.
 */

const TWO_MINUTES_MS = 2 * 60 * 1000;
const GIF_HOST_RE = /tenor\.com|giphy\.com/i;
const GIF_EXT_RE = /\.gif(\?|$)/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm)(\?|$)/i;

/**
 * Transforme une Collection-like (Map/array) en tableau simple.
 */
function toArray(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return [...collection.values()];
  return [];
}

/**
 * Tronque un texte à N caractères, en ajoutant « … » si besoin.
 */
function truncate(text, maxLength) {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength).trim()}…`;
}

/**
 * Remplace les mentions <@id>, <#id>, <@&id> et les emojis custom par du texte lisible.
 */
function resolveMentions(content, resolveName) {
  const resolve = typeof resolveName === 'function' ? resolveName : () => undefined;

  return (content ?? '')
    .replace(/<@&(\d+)>/g, (_, id) => `@${resolve(id, 'role') ?? id}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${resolve(id, 'channel') ?? id}`)
    .replace(/<@!?(\d+)>/g, (_, id) => `@${resolve(id, 'user') ?? id}`)
    .replace(/<a?:(\w+):\d+>/g, (_, name) => `:${name}:`);
}

/**
 * Convertit un message Discord (ou un objet plain compatible) en objet plat.
 */
export function normalizeMessage(msg, resolveName) {
  const authorName =
    msg.member?.displayName ?? msg.author?.globalName ?? msg.author?.username ?? 'Inconnu';

  const attachments = toArray(msg.attachments).map((att) => ({
    url: att.url,
    name: att.name,
    contentType: att.contentType ?? null
  }));

  const embeds = toArray(msg.embeds).map((embed) => ({
    type: embed.type ?? null,
    url: embed.url ?? null,
    title: embed.title ?? null,
    description: embed.description ?? null,
    provider: embed.provider?.name ?? embed.provider ?? null,
    thumbnailUrl: embed.thumbnail?.url ?? embed.video?.thumbnail?.url ?? null
  }));

  const stickers = toArray(msg.stickers).map((sticker) =>
    typeof sticker === 'string' ? sticker : sticker.name
  );

  const reactions = toArray(msg.reactions?.cache ?? msg.reactions).map((reaction) => ({
    emoji: typeof reaction.emoji === 'string' ? reaction.emoji : (reaction.emoji?.name ?? '❓'),
    count: reaction.count ?? 1
  }));

  const createdAt = msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdTimestamp ?? msg.createdAt);

  return {
    id: msg.id,
    authorName,
    isBot: msg.author?.bot === true,
    content: resolveMentions(msg.content, resolveName),
    createdAt,
    replyToId: msg.reference?.messageId ?? msg.replyToId ?? null,
    attachments,
    embeds,
    stickers,
    reactions,
    edited: Boolean(msg.editedAt ?? msg.editedTimestamp ?? msg.edited)
  };
}

/**
 * Détermine la nature d'un média (gif / image / vidéo / autre) à partir de son URL et son type.
 */
function classifyMedia(contentType, url) {
  if ((contentType && contentType.includes('gif')) || GIF_EXT_RE.test(url ?? '') || GIF_HOST_RE.test(url ?? '')) {
    return 'gif';
  }
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType?.startsWith('video/')) return 'video';
  if (IMAGE_EXT_RE.test(url ?? '')) return 'image';
  if (VIDEO_EXT_RE.test(url ?? '')) return 'video';
  return 'other';
}

/**
 * Extrait des mots lisibles depuis le slug d'une URL (tenor/giphy), en retirant l'id et "gif".
 */
function wordsFromSlug(url) {
  try {
    const { pathname } = new URL(url);
    const segment = pathname.split('/').filter(Boolean).pop() ?? '';
    const tokens = segment.split(/[-_]/).filter(Boolean);
    const words = tokens.filter((token) => {
      if (/^gif$/i.test(token)) return false;
      if (/^\d+$/.test(token)) return false;
      if (/^[a-z0-9]{10,}$/i.test(token) && /\d/.test(token)) return false;
      return true;
    });
    return words.join(' ');
  } catch {
    return '';
  }
}

/**
 * Renvoie le nom de domaine d'une URL, sans le préfixe www.
 */
function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url ?? 'lien';
  }
}

/**
 * Pousse une image dans la liste à transmettre à la vision, si le quota n'est pas atteint.
 */
function collectImage(url, images, maxImages) {
  if (!url || images.length >= maxImages) return null;
  const ref = `img ${images.length + 1}`;
  images.push({ url, ref });
  return ref;
}

/**
 * Construit les tags média (`[photo]`, `[GIF: ...]`, réactions, etc.) d'un message normalisé.
 */
function buildMediaTags(msg, images, maxImages) {
  const tags = [];

  for (const att of msg.attachments) {
    const kind = classifyMedia(att.contentType, att.url);
    if (kind === 'gif') {
      const words = wordsFromSlug(att.url) || (att.name ?? '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const ref = collectImage(att.url, images, maxImages);
      tags.push(ref ? `[GIF ${ref}: ${words}]` : `[GIF: ${words}]`);
    } else if (kind === 'image') {
      const ref = collectImage(att.url, images, maxImages);
      tags.push(ref ? `[photo ${ref}]` : '[photo]');
    } else if (kind === 'video') {
      tags.push('[vidéo]');
    } else {
      tags.push(`[fichier: ${att.name ?? 'inconnu'}]`);
    }
  }

  for (const embed of msg.embeds) {
    const kind = classifyMedia(null, embed.url) === 'gif' || embed.type === 'gifv' ? 'gif' : 'other';
    if (kind === 'gif') {
      const words = embed.title || wordsFromSlug(embed.url);
      const thumbIsImage = embed.thumbnailUrl && IMAGE_EXT_RE.test(embed.thumbnailUrl);
      const ref = thumbIsImage ? collectImage(embed.thumbnailUrl, images, maxImages) : null;
      tags.push(ref ? `[GIF ${ref}: ${words}]` : `[GIF: ${words}]`);
    } else {
      const domain = domainFromUrl(embed.url);
      tags.push(embed.title ? `[lien ${domain}: ${embed.title}]` : `[lien ${domain}]`);
    }
  }

  for (const sticker of msg.stickers) {
    tags.push(`[sticker: ${sticker}]`);
  }

  if (msg.reactions.length > 0) {
    const reactionsText = msg.reactions.map((r) => `${r.emoji}x${r.count}`).join(' ');
    tags.push(`(réactions: ${reactionsText})`);
  }

  if (msg.edited) {
    tags.push('(modifié)');
  }

  return tags;
}

/**
 * Regroupe les messages consécutifs du même auteur, à moins de 2 minutes d'écart, sans réponse.
 */
function groupMessages(messages) {
  const groups = [];

  for (const msg of messages) {
    const currentGroup = groups[groups.length - 1];
    const previous = currentGroup?.[currentGroup.length - 1];

    const canMerge =
      previous &&
      !msg.replyToId &&
      previous.authorName === msg.authorName &&
      msg.createdAt - previous.createdAt < TWO_MINUTES_MS;

    if (canMerge) {
      currentGroup.push(msg);
    } else {
      groups.push([msg]);
    }
  }

  return groups;
}

/**
 * Construit le transcript chronologique lisible par l'IA, avec en-têtes de jour et tags média.
 */
export function buildTranscript(messages, { timeZone = 'Europe/Paris', byId = new Map(), maxImages = Infinity } = {}) {
  const images = [];
  const lines = [];
  const dayFormatter = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone });
  const timeFormatter = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });

  let currentDay = null;

  for (const group of groupMessages(messages)) {
    const first = group[0];

    const dayKey = dayFormatter.format(first.createdAt);
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      lines.push(`--- ${dayKey} ---`);
    }

    let prefix = `[${timeFormatter.format(first.createdAt)}] ${first.authorName}`;

    if (group.length === 1 && first.replyToId) {
      const parent = byId.get(first.replyToId);
      if (parent) {
        prefix += ` ↪ à ${parent.authorName} « ${truncate(parent.content, 60)} »`;
      } else {
        prefix += ' ↪ (réponse à un message plus ancien)';
      }
    }

    const parts = group
      .map((msg) => {
        const tags = buildMediaTags(msg, images, maxImages);
        return [msg.content, ...tags].filter((part) => part && part.length > 0).join(' ').trim();
      })
      .filter((part) => part.length > 0);

    lines.push(`${prefix}: ${parts.join(' / ')}`);
  }

  return { lines, images };
}

/**
 * Teste si une ligne est un en-tête de jour (`--- ... ---`), jamais comptée comme message omis.
 */
function isDayHeader(line) {
  return /^--- .+ ---$/.test(line);
}

/**
 * Coupe les lignes les plus anciennes jusqu'à tenir dans `maxChars`, en gardant toujours la dernière.
 */
export function fitToBudget(lines, maxChars) {
  if (lines.length === 0) return lines;

  const remaining = [...lines];
  let omittedCount = 0;

  const totalLength = (arr) => arr.reduce((sum, line) => sum + line.length + 1, 0);

  while (remaining.length > 1 && totalLength(remaining) > maxChars) {
    const dropped = remaining.shift();
    if (!isDayHeader(dropped)) omittedCount++;
  }

  if (omittedCount > 0) {
    remaining.unshift(`[... ${omittedCount} messages plus anciens omis ...]`);
  }

  return remaining;
}
