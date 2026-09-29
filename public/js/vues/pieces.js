/**
 * Les pieces jointes : prise de photo, apercu, envoi (§8, §30, §31).
 *
 * DEUX PORTES, ET ELLES NE FONT PAS LA MEME CHOSE.
 *
 *   « Prendre une photo »   -> capture="environment" : sur telephone, ouvre
 *                              directement l'appareil photo arriere.
 *   « Choisir un fichier »  -> sans capture : ouvre la galerie ou le
 *                              gestionnaire de fichiers, PDF compris.
 *
 * Sur un ordinateur, les deux ouvrent le meme selecteur — l'attribut est
 * simplement ignore. C'est voulu : un seul code, et le telephone y gagne
 * sans que le poste de bureau y perde.
 *
 * LES IMAGES SONT REDUITES AVANT L'ENVOI.
 *
 * Une photo de compteur prise avec un telephone recent pese 4 a 8 Mo pour
 * 4 000 pixels de large. Personne n'a besoin de cette definition pour lire
 * un compteur ou une facture, et cinquante photos par mois rempliraient la
 * base. La reduction se fait ici, dans le navigateur : ce qui part sur le
 * reseau est deja leger, ce qui compte quand on saisit depuis le bord de la
 * route. Le PDF, lui, part tel quel — on ne recompresse pas un document.
 */
import {
  h, fill, api, icone, signalerErreur, etat, succes, confirmer,
} from '../core.js';

/** Au-dela, on reduit. En deca, on n'y touche pas : recompresser degrade. */
const COTE_MAX = 1600;
const QUALITE = 0.82;

/**
 * Reduit une image, ou rend le fichier inchange.
 *
 * Rend TOUJOURS un fichier utilisable : si le navigateur ne sait pas
 * decoder l'image — un HEIC hors Safari, par exemple —, l'original part tel
 * quel. Le serveur l'acceptera : il reconnait le HEIC par ses octets
 * d'en-tete. Echouer ici ferait perdre la photo d'un justificatif pour une
 * question d'octets.
 */
export async function reduireImage(fichier) {
  if (!fichier.type.startsWith('image/')) return fichier;

  try {
    const bitmap = await createImageBitmap(fichier);
    const facteur = Math.min(1, COTE_MAX / Math.max(bitmap.width, bitmap.height));
    if (facteur >= 1) { bitmap.close?.(); return fichier; }

    const largeur = Math.round(bitmap.width * facteur);
    const hauteur = Math.round(bitmap.height * facteur);
    const toile = document.createElement('canvas');
    toile.width = largeur;
    toile.height = hauteur;
    toile.getContext('2d').drawImage(bitmap, 0, 0, largeur, hauteur);
    bitmap.close?.();

    const blob = await new Promise((r) => toile.toBlob(r, 'image/jpeg', QUALITE));
    if (!blob || blob.size >= fichier.size) return fichier;

    const nom = fichier.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], nom, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return fichier;
  }
}

/* ------------------------------------------------------------------ */
/*  Le selecteur, avant enregistrement                                 */
/* ------------------------------------------------------------------ */

/**
 * Le bloc de pieces d'un formulaire de CREATION.
 *
 * L'entite n'existe pas encore : les fichiers sont gardes en memoire, avec
 * leur apercu, et envoyes une fois qu'elle a un identifiant. On peut donc
 * en retirer un avant de valider (§8) sans qu'il ait jamais quitte le
 * telephone.
 *
 * @returns {{noeud: HTMLElement, fichiers: () => File[], envoyer: (entity, id) => Promise<void>}}
 */
export function selecteurPieces({ libelle = 'Photos et justificatifs' } = {}) {
  /** @type {Array<{fichier: File, url: string|null}>} */
  const retenus = [];
  const galerie = h('div', { class: 'pieces' });
  const compte = h('small', { class: 'ligne-note' });

  const tailleMax = etat.meta?.uploadMaxBytes ?? 10 * 1024 * 1024;

  const peindre = () => {
    fill(galerie, ...retenus.map((piece, index) =>
      h('div', { class: 'piece' },
        piece.url
          ? h('img', { src: piece.url, alt: piece.fichier.name })
          : h('span', { class: 'nom' }, piece.fichier.name),
        h('button', {
          type: 'button',
          class: 'retirer',
          'aria-label': 'Retirer ' + piece.fichier.name,
          title: 'Retirer',
          onclick: () => {
            if (piece.url) URL.revokeObjectURL(piece.url);
            retenus.splice(index, 1);
            peindre();
          },
        }, '×'))));

    fill(compte, retenus.length
      ? retenus.length + ' pièce(s) · ' + poids(retenus.reduce((s, p) => s + p.fichier.size, 0))
      : 'Aucune pièce. Vous pouvez enregistrer sans.');
  };

  const ajouter = async (listeFichiers) => {
    for (const brut of [...listeFichiers]) {
      const fichier = await reduireImage(brut);
      if (fichier.size > tailleMax) {
        signalerErreur(
          new Error('« ' + fichier.name + ' » pèse ' + poids(fichier.size) +
            ', au-delà de la limite de ' + poids(tailleMax) + '.'),
          'Fichier trop volumineux');
        continue;
      }
      retenus.push({
        fichier,
        url: fichier.type.startsWith('image/') && fichier.type !== 'image/heic'
          ? URL.createObjectURL(fichier)
          : null,
      });
    }
    peindre();
  };

  const champAppareil = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment', multiple: true,
    onchange: (e) => { ajouter(e.target.files); e.target.value = ''; },
  });
  const champFichier = h('input', {
    type: 'file', accept: 'image/*,application/pdf', multiple: true,
    onchange: (e) => { ajouter(e.target.files); e.target.value = ''; },
  });

  const noeud = h('div', { class: 'champ large' },
    h('span', {}, libelle),
    h('div', { class: 'capture' },
      champAppareil,
      champFichier,
      h('button', {
        type: 'button', class: 'bouton', onclick: () => champAppareil.click(),
      }, icone('appareil'), h('span', {}, 'Prendre une photo')),
      h('button', {
        type: 'button', class: 'bouton', onclick: () => champFichier.click(),
      }, icone('image'), h('span', {}, 'Choisir un fichier'))),
    galerie,
    compte);

  peindre();

  return {
    noeud,
    fichiers: () => retenus.map((p) => p.fichier),
    /** Envoie les pieces retenues sur l'entite, une fois qu'elle existe. */
    async envoyer(entity, entityId) {
      const fichiers = retenus.map((p) => p.fichier);
      if (!fichiers.length) return;
      // Par paquets : la route en accepte huit par envoi.
      for (let i = 0; i < fichiers.length; i += 8) {
        await api.televerser('/api/fichiers', { entity, entityId }, fichiers.slice(i, i + 8));
      }
      for (const p of retenus) if (p.url) URL.revokeObjectURL(p.url);
      retenus.length = 0;
      peindre();
    },
  };
}

/* ------------------------------------------------------------------ */
/*  La galerie d'une entite existante                                  */
/* ------------------------------------------------------------------ */

/**
 * Les pieces deja enregistrees, avec ajout et suppression a chaud.
 *
 * @param {'vehicule'|'activite'|'entretien'} entity
 * @param {string} entityId
 */
export function galeriePieces(entity, entityId, { modifiable = true } = {}) {
  const galerie = h('div', { class: 'pieces' });
  const zone = h('div', {});

  const peindre = (pieces) => {
    if (!pieces.length) {
      fill(galerie, h('p', { class: 'ligne-note' }, 'Aucune pièce jointe.'));
      return;
    }
    fill(galerie, ...pieces.map((p) => h('div', { class: 'piece' },
      h('a', {
        href: '/api/fichiers/' + p.id + (p.previsualisable ? '?inline=1' : ''),
        target: '_blank',
        rel: 'noopener',
        title: p.nom + ' · ' + poids(p.taille),
      },
      p.previsualisable
        // Chargement paresseux : une fiche avec vingt photos ne doit pas
        // les telecharger toutes avant de s'afficher (§32).
        ? h('img', { src: '/api/fichiers/' + p.id + '?inline=1', alt: p.nom, loading: 'lazy' })
        : h('span', { class: 'nom' }, icone('piece'), h('span', {}, p.nom))),
      modifiable && etat.peut('attachment.delete')
        ? h('button', {
          type: 'button', class: 'retirer', title: 'Supprimer', 'aria-label': 'Supprimer ' + p.nom,
          onclick: async () => {
            const ok = await confirmer({
              titre: 'Supprimer cette pièce ?',
              message: '« ' + p.nom + ' » sera définitivement supprimée. ' +
                'Il n’y a pas de corbeille pour les pièces jointes.',
              libelleConfirmation: 'Supprimer',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.delete('/api/fichiers/' + p.id);
              succes('Pièce supprimée', p.nom);
              await recharger();
            } catch (err) { signalerErreur(err, 'Suppression impossible'); }
          },
        }, '×')
        : null)));
  };

  async function recharger() {
    try {
      const { pieces } = await api.get('/api/fichiers', { entity, entityId });
      peindre(pieces);
    } catch (err) {
      fill(galerie, h('p', { class: 'ligne-note' }, 'Pièces jointes indisponibles.'));
      signalerErreur(err, 'Lecture des pièces');
    }
  }

  const champAppareil = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment', multiple: true,
    onchange: (e) => { televerser(e.target.files); e.target.value = ''; },
  });
  const champFichier = h('input', {
    type: 'file', accept: 'image/*,application/pdf', multiple: true,
    onchange: (e) => { televerser(e.target.files); e.target.value = ''; },
  });

  async function televerser(liste) {
    const fichiers = [];
    for (const brut of [...liste]) fichiers.push(await reduireImage(brut));
    if (!fichiers.length) return;
    try {
      for (let i = 0; i < fichiers.length; i += 8) {
        await api.televerser('/api/fichiers', { entity, entityId }, fichiers.slice(i, i + 8));
      }
      succes('Pièces ajoutées', fichiers.length + ' fichier(s)');
      await recharger();
    } catch (err) { signalerErreur(err, 'Ajout impossible'); }
  }

  fill(zone,
    modifiable && etat.peut('attachment.add')
      ? h('div', { class: 'capture' },
        champAppareil, champFichier,
        h('button', { type: 'button', class: 'bouton petit', onclick: () => champAppareil.click() },
          icone('appareil'), h('span', {}, 'Prendre une photo')),
        h('button', { type: 'button', class: 'bouton petit', onclick: () => champFichier.click() },
          icone('image'), h('span', {}, 'Ajouter un fichier')))
      : null,
    galerie);

  recharger();
  return zone;
}

/** « 4,2 Mo », « 840 Ko ». */
export function poids(octets) {
  if (octets >= 1024 * 1024) return (octets / (1024 * 1024)).toFixed(1).replace('.', ',') + ' Mo';
  return Math.max(1, Math.round(octets / 1024)) + ' Ko';
}
