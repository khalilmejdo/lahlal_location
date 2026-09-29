/**
 * Serialisation CSV, partagee par les exports.
 *
 * Les valeurs commencant par =, +, - ou @ sont prefixees d'une apostrophe :
 * sans cette precaution, un libelle saisi par un utilisateur pourrait etre
 * interprete comme une formule a l'ouverture du fichier dans un tableur
 * (injection de formule).
 *
 * Elle vivait dans server/routes/reports.js, privee, tant qu'un seul module
 * exportait. L'export des reglements (C5, demande de Khalil du 16 septembre
 * 2026) en est le second appelant : une seconde copie aurait diverge des le
 * premier changement — un separateur, une echappe, et deux fichiers que le
 * meme tableur ne lit plus de la meme facon.
 */

/**
 * Un nombre destine au tableur, et non du texte qui lui ressemble.
 *
 * Contre-verification du 16 septembre 2026 : la garde exemptait tout ce qui
 * RESSEMBLE a un nombre, colonnes de texte comprises. Une reference de
 * virement « -0012345 » perdait son apostrophe, et le tableur la convertissait
 * en nombre : les zeros de tete disparaissaient du fichier remis au comptable.
 *
 * Un nombre se DECLARE maintenant : nombreCsv() rend cet objet, la garde le
 * reconnait a son type, et rien d'autre n'en beneficie. Deviner le type d'une
 * cellule a partir de son texte, c'est exactement l'erreur du tableur.
 */
class NombreCsv {
  constructor(texte) { this.texte = texte; }
  toString() { return this.texte; }
  // Partout ailleurs que dans toCsv, ce montant doit se comporter comme le
  // texte qu'il represente : concatenation, gabarit, et JSON. Sans toJSON,
  // JSON.stringify rendait { "texte": "-500,50" } — un objet la ou un appelant
  // futur attendrait un montant, et le piege ne se verrait qu'a la lecture du
  // fichier produit.
  toJSON() { return this.texte; }
}

export function toCsv(headers, rows) {
  const escapeCell = (value) => {
    if (value === null || value === undefined) return '';
    // Un nombre negatif commence par « - » : la garde anti-formule le
    // prefixait d'une apostrophe, et le tableur lisait « '-500,00 » comme du
    // TEXTE. Les avoirs et les remboursements d'un export sortaient donc non
    // additionnables, precisement ceux qu'un comptable doit soustraire.
    const estNombre = value instanceof NombreCsv;
    let text = String(value);
    if (!estNombre && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[";\n\r]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
    return text;
  };

  // Separateur point-virgule : c'est celui qu'attend Excel en configuration
  // francaise, ou la virgule est le separateur decimal.
  const lines = [headers.map(escapeCell).join(';')];
  for (const row of rows) lines.push(row.map(escapeCell).join(';'));
  return lines.join('\r\n');
}

/**
 * Un montant, en centimes, ecrit comme le tableur l'attend.
 *
 * centsToNumber() rend 500.5, que String() ecrit « 500.5 » : un tableur
 * francais — celui que le separateur point-virgule vise explicitement — lit
 * le point comme un separateur de milliers et range la cellule en TEXTE. Le
 * comptable ne pouvait additionner aucune colonne de l'export sans la
 * reformater d'abord.
 *
 * Rend un NombreCsv, que toCsv() laisse passer sans apostrophe : c'est la
 * SEULE facon d'obtenir cette exemption.
 */
export const nombreCsv = (cents) =>
  new NombreCsv((Math.trunc(Number(cents) || 0) / 100).toFixed(2).replace('.', ','));
