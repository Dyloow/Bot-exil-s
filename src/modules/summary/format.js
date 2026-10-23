/**
 * Petits utilitaires de formatage partagés entre transcript.js et render.js.
 */

/**
 * Formate une heure locale HH:mm dans le fuseau donné.
 */
export function formatTime(date, timeZone = 'Europe/Paris') {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(
    date
  );
}

/**
 * Tronque un texte à `max` caractères, en ajoutant « … » si besoin. Ne touche pas aux espaces internes.
 */
export function truncatePlain(text, max) {
  if (!text) return text;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Aplatit les espaces (sauts de ligne compris) puis tronque, pour citer un message sur une seule ligne.
 */
export function truncateQuote(text, max) {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return truncatePlain(clean, max) ?? '';
}
