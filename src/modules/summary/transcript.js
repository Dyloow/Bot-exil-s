/**
 * Transcript pur : convertit des messages Discord en texte lisible pour l'IA.
 * Aucun import discord.js / openai ici, pour rester testable sans réseau.
 */

import { formatTime, truncateQuote } from './format.js';

const TWO_MINUTES_MS = 2 * 60 * 1000;
const GIF_HOST_RE = /tenor\.com|giphy\.com/i;
const GIF_EXT_RE = /\.gif(\?|$)/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm)(\?|$)/i;
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMG_TOKEN_RE = /\u0000IMGREF(\d+)\u0000/g;

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
 * Lit un champ d'embed en tenant compte des vrais objets discord.js `Embed`, qui exposent `.data.<champ>`
 * mais pas toujours un getter correspondant (ex: `.type` n'a pas de getter, seulement `.data.type`).
 */
function embedGet(embed, key) {
  return embed?.data?.[key] ?? embed?.[key] ?? null;
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

  const embeds = toArray(msg.embeds).map((embed) => {
    const thumbnail = embedGet(embed, 'thumbnail');
    const video = embedGet(embed, 'video');
    const providerRaw = embedGet(embed, 'provider');

    return {
      type: embedGet(embed, 'type'),
      url: embedGet(embed, 'url'),
      title: embedGet(embed, 'title'),
      description: embedGet(embed, 'description'),
      provider: providerRaw?.name ?? providerRaw ?? null,
      thumbnailUrl: thumbnail?.url ?? video?.thumbnail?.url ?? null
    };
  });

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
 * Détermine la nature d'un média (gif / image / image non supportée / vidéo / autre).
 * Seuls png/jpeg/webp sont envoyés à la vision ; les autres image/* (heic, svg...) deviennent un fichier.
 */
function classifyMedia(contentType, url) {
  if ((contentType && contentType.includes('gif')) || GIF_EXT_RE.test(url ?? '') || GIF_HOST_RE.test(url ?? '')) {
    return 'gif';
  }
  if (contentType && SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType)) return 'image';
  if (IMAGE_EXT_RE.test(url ?? '')) return 'image';
  if (contentType?.startsWith('video/')) return 'video';
  if (VIDEO_EXT_RE.test(url ?? '')) return 'video';
  if (contentType?.startsWith('image/')) return 'image-unsupported';
  return 'other';
}

/**
 * Convertit l'URL d'un GIF en image statique (png) via le proxy média de Discord, quand c'est possible.
 * Renvoie `null` quand la conversion n'est pas sûre : on tague le GIF sans l'envoyer à la vision.
 */
function toStaticImageUrl(url) {
  if (!url) return null;
  if (IMAGE_EXT_RE.test(url)) return url;
  if (!GIF_EXT_RE.test(url)) return null;

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'cdn.discordapp.com' && parsed.hostname !== 'media.discordapp.net') {
      return null;
    }
    parsed.hostname = 'media.discordapp.net';
    parsed.searchParams.set('format', 'png');
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Extrait des mots lisibles depuis le slug d'une URL (tenor/giphy), en retirant l'id et "gif".
 */
function wordsFromSlug(url) {
  try {
    const { pathname } = new URL(url);
    const segment = (pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.[a-z0-9]+$/i, '');
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
 * Enregistre un candidat image et renvoie un jeton de référence à résoudre après `fitToBudget`
 * (on ne sait pas encore s'il fera partie des N images les plus récentes conservées).
 */
function pushCandidate(candidates, url) {
  const index = candidates.length;
  candidates.push({ url });
  return `\u0000IMGREF${index}\u0000`;
}

/**
 * Construit les tags média (`[photo]`, `[GIF: ...]`, réactions, etc.) d'un message normalisé.
 * Les images/GIFs convertibles poussent un candidat dans `candidates`, résolu plus tard par `resolveImages`.
 */
function buildMediaTags(msg, candidates) {
  const tags = [];

  for (const att of msg.attachments) {
    const kind = classifyMedia(att.contentType, att.url);
    if (kind === 'gif') {
      const words = wordsFromSlug(att.url) || (att.name ?? '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const staticUrl = toStaticImageUrl(att.url);
      const token = staticUrl ? pushCandidate(candidates, staticUrl) : '';
      tags.push(`[GIF${token}: ${words}]`);
    } else if (kind === 'image') {
      const token = pushCandidate(candidates, att.url);
      tags.push(`[photo${token}]`);
    } else if (kind === 'image-unsupported') {
      tags.push(`[fichier: ${att.name ?? 'image'}]`);
    } else if (kind === 'video') {
      tags.push('[vidéo]');
    } else {
      tags.push(`[fichier: ${att.name ?? 'inconnu'}]`);
    }
  }

  for (const embed of msg.embeds) {
    const isGif = classifyMedia(null, embed.url) === 'gif' || embed.type === 'gifv';
    if (isGif) {
      const words = embed.title || wordsFromSlug(embed.url);
      const thumbIsImage = embed.thumbnailUrl && IMAGE_EXT_RE.test(embed.thumbnailUrl);
      const token = thumbIsImage ? pushCandidate(candidates, embed.thumbnailUrl) : '';
      tags.push(`[GIF${token}: ${words}]`);
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
 * Renvoie des lignes `{ text, messageCount }` (pas encore coupées par budget, images pas encore résolues) :
 * `fitToBudget` doit tourner avant `resolveImages`, pour ne garder que les images des lignes conservées.
 */
export function buildTranscript(messages, { timeZone = 'Europe/Paris', byId = new Map() } = {}) {
  const candidates = [];
  const lines = [];
  const dayFormatter = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone });

  let currentDay = null;

  for (const group of groupMessages(messages)) {
    const first = group[0];

    const dayKey = dayFormatter.format(first.createdAt);
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      lines.push({ text: `--- ${dayKey} ---`, messageCount: 0 });
    }

    let prefix = `[${formatTime(first.createdAt, timeZone)}] ${first.authorName}`;

    if (first.replyToId) {
      const parent = byId.get(first.replyToId);
      if (parent) {
        prefix += ` ↪ à ${parent.authorName} « ${truncateQuote(parent.content, 60)} »`;
      } else {
        prefix += ' ↪ (réponse à un message plus ancien)';
      }
    }

    const parts = group
      .map((msg) => {
        const tags = buildMediaTags(msg, candidates);
        return [msg.content, ...tags].filter((part) => part && part.length > 0).join(' ').trim();
      })
      .filter((part) => part.length > 0);

    lines.push({ text: `${prefix}: ${parts.join(' / ')}`, messageCount: group.length });
  }

  return { lines, candidates };
}

/**
 * Coupe les lignes les plus anciennes jusqu'à tenir dans `maxChars`, en gardant toujours la dernière.
 * `omittedMessageCount` compte les messages source (pas les lignes) laissés de côté, en-têtes de jour exclues.
 */
export function fitToBudget(lineEntries, maxChars) {
  if (lineEntries.length === 0) return { lines: lineEntries, omittedMessageCount: 0 };

  const remaining = [...lineEntries];
  let omittedMessageCount = 0;

  const totalLength = (arr) => arr.reduce((sum, entry) => sum + entry.text.length + 1, 0);

  while (remaining.length > 1 && totalLength(remaining) > maxChars) {
    const dropped = remaining.shift();
    omittedMessageCount += dropped.messageCount;
  }

  if (omittedMessageCount > 0) {
    remaining.unshift({ text: `[... ${omittedMessageCount} messages plus anciens omis ...]`, messageCount: 0 });
  }

  return { lines: remaining, omittedMessageCount };
}

/**
 * Résout les jetons image posés par `buildTranscript`, une fois les lignes coupées par `fitToBudget` :
 * ne garde que les candidats dont la ligne a survécu, et parmi eux les `maxImages` les plus récents.
 * Les jetons non conservés sont simplement retirés du texte (`[photo]`, `[GIF: ...]` sans référence).
 */
export function resolveImages(lineEntries, candidates, maxImages = Infinity) {
  const order = [];
  const seen = new Set();

  for (const entry of lineEntries) {
    IMG_TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = IMG_TOKEN_RE.exec(entry.text)) !== null) {
      const index = Number(match[1]);
      if (!seen.has(index)) {
        seen.add(index);
        order.push(index);
      }
    }
  }

  const kept = maxImages > 0 ? order.slice(-maxImages) : [];
  const rankByIndex = new Map(kept.map((index, i) => [index, i + 1]));

  const lines = lineEntries.map((entry) =>
    entry.text.replace(IMG_TOKEN_RE, (_, idx) => {
      const rank = rankByIndex.get(Number(idx));
      return rank ? ` img ${rank}` : '';
    })
  );

  const images = kept.map((index, i) => ({ url: candidates[index].url, ref: `img ${i + 1}` }));

  return { lines, images };
}
