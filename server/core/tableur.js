/**
 * Ecriture d'un classeur Excel, sans dependance.
 *
 * L'application exportait en CSV. Excel l'ouvre, mais mal : les colonnes de
 * montants arrivent en texte des qu'une virgule decimale s'y trouve, les dates
 * se reinterpretent selon la langue du poste, et rien ne distingue l'en-tete
 * des donnees. C'est precisement le genre de derive qui a produit les
 * anomalies du classeur d'origine — un nombre pris pour du texte, un texte
 * pris pour une date.
 *
 * Un fichier .xlsx est une archive ZIP contenant du XML. Les deux tiennent
 * dans les modules natifs de Node : `zlib` pour la compression, quelques
 * lignes pour l'entete ZIP. C'est moins de code que d'auditer une bibliotheque
 * tierce, et cela evite d'ajouter une dependance a une application qui n'en a
 * qu'une.
 *
 * Le format ecrit ici est volontairement minimal : une feuille, un en-tete en
 * gras, et trois types de cellule — texte, nombre, date. Rien de plus n'est
 * necessaire pour un etat, et tout ce qui s'ajoute devrait etre maintenu.
 */
import { deflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ */
/*  Archive ZIP                                                        */
/* ------------------------------------------------------------------ */

const TABLE_CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32, celui qu'exige l'entete ZIP. */
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = TABLE_CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble une archive ZIP a partir d'entrees { nom, contenu }.
 *
 * Aucune date n'est ecrite dans les entetes : deux exports du meme etat
 * doivent produire le meme fichier, octet pour octet. C'est ce qui permet de
 * comparer deux extractions sans les ouvrir.
 */
export function construireZip(entrees) {
  const locaux = [];
  const centraux = [];
  let position = 0;

  for (const { nom, contenu } of entrees) {
    const nomOctets = Buffer.from(nom, 'utf8');
    const brut = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8');
    const compresse = deflateRawSync(brut);
    const somme = crc32(brut);

    const entete = Buffer.alloc(30);
    entete.writeUInt32LE(0x04034b50, 0);
    entete.writeUInt16LE(20, 4);           // version minimale
    entete.writeUInt16LE(0x0800, 6);       // noms de fichier en UTF-8
    entete.writeUInt16LE(8, 8);            // methode : deflate
    entete.writeUInt16LE(0, 10);           // heure — fixee, pour la reproductibilite
    entete.writeUInt16LE(0x21, 12);        // date — 1er janvier 1996
    entete.writeUInt32LE(somme, 14);
    entete.writeUInt32LE(compresse.length, 18);
    entete.writeUInt32LE(brut.length, 22);
    entete.writeUInt16LE(nomOctets.length, 26);
    entete.writeUInt16LE(0, 28);

    locaux.push(entete, nomOctets, compresse);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(somme, 16);
    central.writeUInt32LE(compresse.length, 20);
    central.writeUInt32LE(brut.length, 24);
    central.writeUInt16LE(nomOctets.length, 28);
    central.writeUInt32LE(position, 42);

    centraux.push(central, nomOctets);
    position += entete.length + nomOctets.length + compresse.length;
  }

  const corps = Buffer.concat(locaux);
  const repertoire = Buffer.concat(centraux);

  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entrees.length, 8);
  fin.writeUInt16LE(entrees.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(corps.length, 16);

  return Buffer.concat([corps, repertoire, fin]);
}

/* ------------------------------------------------------------------ */
/*  Feuille de calcul                                                  */
/* ------------------------------------------------------------------ */

const echapper = (valeur) => [...String(valeur ?? '')]
  // Les caracteres de controle rendent le fichier illisible par Excel, qui
  // annonce alors « contenu illisible » sans dire lequel. La tabulation, le
  // saut de ligne et le retour chariot restent.
  //
  // Ecrit par code de caractere (16 septembre 2026) : la classe d'expression
  // reguliere d'origine portait ces caracteres EN CLAIR dans la source, et
  // git comme grep prenaient ce fichier pour un binaire.
  .filter((c) => {
    const n = c.charCodeAt(0);
    return n >= 32 || n === 9 || n === 10 || n === 13;
  })
  .join('')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** « AAAA-MM-JJ » -> numero de serie Excel. Le 1900 d'Excel a un bogue de deux jours, assume ici. */
export function serieExcel(date) {
  const t = Date.parse(String(date).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 86400000) + 25569;
}

/** Reference de cellule : (0, 0) -> « A1 », (0, 26) -> « AA1 ». */
export function referenceCellule(ligne, colonne) {
  let n = colonne;
  let lettres = '';
  do {
    lettres = String.fromCharCode(65 + (n % 26)) + lettres;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return lettres + (ligne + 1);
}

/**
 * Une cellule. Le style est celui de sa ligne : 3 pour un montant, 4 et 5 pour
 * la ligne de total, 6 pour un titre (construireXlsx). Une date garde le sien.
 */
function cellule(ligne, colonne, valeur, style = 0) {
  const ref = referenceCellule(ligne, colonne);
  const s = style ? ' s="' + style + '"' : '';

  if (valeur === null || valeur === undefined || valeur === '') return '';

  if (typeof valeur === 'number' && Number.isFinite(valeur)) {
    return '<c r="' + ref + '"' + s + '><v>' + valeur + '</v></c>';
  }

  if (valeur instanceof Date || (valeur && valeur.__date)) {
    const serie = serieExcel(valeur.__date ?? valeur.toISOString());
    if (serie !== null) return '<c r="' + ref + '" s="2"><v>' + serie + '</v></c>';
  }

  // « inlineStr » evite la table des chaines partagees : un fichier de plus a
  // ecrire et a maintenir, pour un gain nul sur quelques centaines de lignes.
  return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' +
    echapper(valeur) + '</t></is></c>';
}

/** Marque une valeur comme date, sans dependre du type JavaScript. */
export const dateExcel = (iso) => (iso ? { __date: String(iso).slice(0, 10) } : null);

/**
 * Construit un classeur d'une feuille.
 *
 * Le cas simple — un en-tete et des lignes — ecrit exactement ce qu'il
 * ecrivait : l'export des anomalies n'en voit rien. Le recapitulatif des
 * factures (demande de Khalil, 16 septembre 2026 : « avec le logo et les infos
 * aussi dans Excel ») y ajoute ce que porte un document remis a un client :
 * le logo, un bloc d'informations au-dessus du tableau, une ligne de total et
 * des mentions en dessous, des montants au format monetaire, et une mise en
 * page paysage pour l'impression depuis Excel.
 *
 * @param {object} options
 * @param {string} [options.feuille] nom de l'onglet
 * @param {Array<{titre:string, largeur?:number, format?:'montant'}>} options.colonnes
 * @param {Array<Array<*>>} options.lignes
 * @param {Array<{valeurs: Array<*>, style?: 'titre'|'gras'}>} [options.entete]  au-dessus du tableau
 * @param {Array<*>|null} [options.total]     ligne de total, en gras, sous le tableau
 * @param {string[]} [options.mentions]       lignes de texte sous le total
 * @param {{octets: Buffer, extension: 'png'|'jpeg', largeur: number, hauteur: number}|null} [options.image]
 *        largeur et hauteur d'affichage, en pixels
 * @param {boolean} [options.paysage]          impression en paysage, ajustee a la largeur
 * @returns {Buffer}
 */
export function construireXlsx({
  feuille = 'Feuille1', colonnes, lignes, entete = [], total = null, mentions = [], image = null, paysage = false,
}) {
  // Une ligne de feuille fait 15 points par defaut, soit 20 pixels : le logo
  // occupe autant de lignes vides qu'il en faut, plus une de respiration.
  const lignesImage = image ? Math.ceil(image.hauteur / 20) + 1 : 0;
  const premiereEntete = lignesImage;
  const ligneTitres = premiereEntete + (entete.length ? entete.length + 1 : 0);
  const derniereDonnee = ligneTitres + lignes.length;
  const montant = colonnes.map((c) => c.format === 'montant');

  const largeurs = colonnes
    .map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) +
      '" width="' + (c.largeur || 18) + '" customWidth="1"/>')
    .join('');

  const rangeesEntete = entete.map((r, index) => {
    const style = r.style === 'titre' ? 6 : r.style === 'gras' ? 4 : 0;
    return '<row r="' + (premiereEntete + index + 1) + '">' +
      (r.valeurs || []).map((v, colonne) => cellule(premiereEntete + index, colonne, v, style)).join('') +
      '</row>';
  }).join('');

  const enTete = '<row r="' + (ligneTitres + 1) + '">' +
    colonnes.map((c, i) =>
      '<c r="' + referenceCellule(ligneTitres, i) + '" s="1" t="inlineStr"><is><t>' +
      echapper(c.titre) + '</t></is></c>').join('') +
    '</row>';

  const corps = lignes.map((ligne, index) =>
    '<row r="' + (ligneTitres + index + 2) + '">' +
    ligne.map((valeur, colonne) =>
      cellule(ligneTitres + index + 1, colonne, valeur, montant[colonne] ? 3 : 0)).join('') +
    '</row>').join('');

  const ligneTotal = total
    ? '<row r="' + (derniereDonnee + 2) + '">' +
      total.map((valeur, colonne) =>
        cellule(derniereDonnee + 1, colonne, valeur, montant[colonne] ? 5 : 4)).join('') +
      '</row>'
    : '';

  const debutMentions = derniereDonnee + (total ? 1 : 0) + 2;
  const rangeesMentions = mentions.map((texte, index) =>
    '<row r="' + (debutMentions + index + 1) + '">' + cellule(debutMentions + index, 0, texte, 0) + '</row>').join('');

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    (image ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '') + '>' +
    (paysage ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') +
    // Le volet fige garde l'en-tete visible : un etat de quatre cents lignes
    // se parcourt sans perdre le nom des colonnes.
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="' + (ligneTitres + 1) + '" topLeftCell="A' + (ligneTitres + 2) +
    '" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    '<cols>' + largeurs + '</cols>' +
    '<sheetData>' + rangeesEntete + enTete + corps + ligneTotal + rangeesMentions + '</sheetData>' +
    '<autoFilter ref="' + referenceCellule(ligneTitres, 0) + ':' +
    referenceCellule(ligneTitres, colonnes.length - 1) + '"/>' +
    (paysage
      ? '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
        '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
      : '') +
    (image ? '<drawing r:id="rId1"/>' : '') +
    '</worksheet>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>' +
    '<numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>' +
    '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF16202E"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    // 0 ordinaire, 1 en-tete, 2 date, 3 montant, 4 gras, 5 montant gras, 6 titre.
    '<cellXfs count="7">' +
    '<xf xfId="0"/>' +
    '<xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1"/>' +
    '<xf xfId="0" numFmtId="164" applyNumberFormat="1"/>' +
    '<xf xfId="0" numFmtId="165" applyNumberFormat="1"/>' +
    '<xf xfId="0" fontId="2" applyFont="1"/>' +
    '<xf xfId="0" numFmtId="165" fontId="2" applyNumberFormat="1" applyFont="1"/>' +
    '<xf xfId="0" fontId="3" applyFont="1"/>' +
    '</cellXfs></styleSheet>';

  const typeImage = image?.extension === 'jpeg' ? 'image/jpeg' : 'image/png';
  // EMU : l'unite des dessins Office, 9 525 par pixel.
  const cx = image ? Math.round(image.largeur * 9525) : 0;
  const cy = image ? Math.round(image.hauteur * 9525) : 0;

  return construireZip([
    {
      nom: '[Content_Types].xml',
      contenu:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        (image ? '<Default Extension="' + image.extension + '" ContentType="' + typeImage + '"/>' : '') +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        (image ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
        '</Types>',
    },
    {
      nom: '_rels/.rels',
      contenu:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      nom: 'xl/workbook.xml',
      contenu:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + echapper(String(feuille).slice(0, 31)) +
        '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      nom: 'xl/_rels/workbook.xml.rels',
      contenu:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { nom: 'xl/styles.xml', contenu: styles },
    { nom: 'xl/worksheets/sheet1.xml', contenu: sheet },
    ...(image
      ? [
          {
            nom: 'xl/worksheets/_rels/sheet1.xml.rels',
            contenu:
              '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
              '</Relationships>',
          },
          {
            nom: 'xl/drawings/drawing1.xml',
            contenu:
              '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
              'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
              '<xdr:oneCellAnchor>' +
              '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
              '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>' +
              '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/>' +
              '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
              '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
              '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
              '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
              '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>',
          },
          {
            nom: 'xl/drawings/_rels/drawing1.xml.rels',
            contenu:
              '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.' + image.extension + '"/>' +
              '</Relationships>',
          },
          { nom: 'xl/media/image1.' + image.extension, contenu: image.octets },
        ]
      : []),
  ]);
}

/** Type MIME d'un classeur, pour l'en-tete de reponse. */
export const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
