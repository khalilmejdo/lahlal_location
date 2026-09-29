/**
 * « Nouvelle activité » : le formulaire central (§6, §23, §44).
 *
 * L'exigence est chiffree : « je dois pouvoir enregistrer une activité en
 * moins d'une minute ». Trois choix de conception en decoulent.
 *
 * 1. TOUT TIENT DANS UNE SEULE MODALE, sans etape ni onglet. Un formulaire
 *    en deux ecrans double les clics et fait perdre la saisie quand on
 *    revient en arriere.
 *
 * 2. LE TYPE SE CHOISIT EN UN TOUCHER. Ce sont des boutons, pas une liste
 *    deroulante : sur telephone, une liste demande un toucher pour ouvrir,
 *    un defilement, un toucher pour choisir. Le type retenu oriente ensuite
 *    le clavier vers le champ qu'on remplit neuf fois sur dix — depense
 *    pour un carburant, recette pour un remorquage.
 *
 * 3. LE RESULTAT S'AFFICHE PENDANT LA SAISIE. « Dépense 50, recette 250 »
 *    doit montrer « +200,00 DH » avant d'enregistrer, pas apres : c'est ce
 *    qui permet de voir une erreur de frappe au moment ou on la fait.
 *
 * LE KILOMETRAGE INCOHERENT N'EST PAS REFUSE, IL EST CONFIRME (§4).
 *
 * Le serveur repond 409 avec son explication ; on la montre telle quelle et
 * l'on propose de passer outre. Le message vient du serveur et non d'ici :
 * c'est lui qui connait les relevés existants, et une seconde formulation
 * cote ecran finirait par dire autre chose que la sienne.
 */
import {
  h, fill, donnee, api, etat, modale, champ, saisie, liste, zoneTexte, icone,
  montantSigne, versCentimes, aujourdhui, signalerErreur, confirmer, entier,
} from '../core.js';
import { selecteurPieces } from './pieces.js';

/**
 * Une cle d'idempotence pour cet envoi precis.
 *
 * Elle est tiree UNE fois, a l'ouverture du formulaire, et ne change pas
 * entre deux tentatives : c'est tout son interet. Un envoi parti dans une
 * zone mal couverte, dont la reponse ne revient pas, puis reessaye, porte la
 * meme cle — le serveur reconnait le rejeu et ne cree pas une seconde
 * activite (schema.sql, uq_activites_idempotency).
 */
const nouvelleCle = () =>
  'act-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

/**
 * Le véhicule et le type de la dernière saisie.
 *
 * Gardés dans le navigateur, pas en base : c'est une commodité par poste,
 * pas une donnée. Deux personnes qui partagent un compte n'ont pas les mêmes
 * habitudes, et le serveur n'a rien à savoir de celles-ci.
 *
 * Toute lecture et toute écriture sont protégées : en navigation privée ou
 * avec le stockage bloqué, l'accès lève, et le formulaire doit s'ouvrir
 * quand même — simplement sans se souvenir.
 */
const CLE_DERNIERE_SAISIE = 'flotte:derniere-saisie';

function lireDerniereSaisie() {
  try {
    return JSON.parse(localStorage.getItem(CLE_DERNIERE_SAISIE)) || {};
  } catch {
    return {};
  }
}

function retenirDerniereSaisie(valeur) {
  try {
    localStorage.setItem(CLE_DERNIERE_SAISIE, JSON.stringify(valeur));
  } catch {
    // Stockage indisponible : on ne se souviendra pas, et c'est tout.
  }
}

/**
 * Ouvre le formulaire. Rend l'activite creee, ou null si l'on renonce.
 *
 * @param {{vehiculeId?: string}} [prefixe]
 */
export function ouvrirFormulaireActivite({ vehiculeId = null } = {}) {
  return new Promise((resolve) => {
    let repondu = false;
    const finir = (v) => { if (!repondu) { repondu = true; resolve(v); } };

    const meta = etat.meta ?? {};
    const vehicules = meta.vehicules ?? [];
    const types = meta.typesActivite ?? [];
    const cleIdempotence = nouvelleCle();

    if (!vehicules.length) {
      const m = modale({
        titre: 'Aucun véhicule',
        contenu: h('p', {},
          'Créez d’abord un véhicule : une activité se rattache toujours à l’un d’eux.'),
        actions: [h('button', { class: 'bouton principal', onclick: () => { finir(null); m.fermer(); } }, 'Fermer')],
        surFermeture: () => finir(null),
      });
      return;
    }

    /* --- Les champs --- */

    // On rouvre sur le véhicule et le type de la dernière saisie : dans une
    // journée, on enregistre plusieurs fois la même chose avec le même
    // camion. Deux listes à reparcourir à chaque fois, c'est deux gestes de
    // trop — et c'est le genre de friction qui décourage de tout saisir.
    const dernier = lireDerniereSaisie();

    const champVehicule = liste(
      vehicules.map((v) => ({ value: v.id, label: donnee(v.nom + ' — ' + v.immatriculation) })),
      vehiculeId
        ?? (vehicules.some((v) => v.id === dernier.vehiculeId) ? dernier.vehiculeId : null)
        ?? vehicules[0].id,
      { onchange: () => rappelerCompteur() },
    );

    const champDate = saisie({ type: 'date', value: aujourdhui(), max: aujourdhui(), required: true });
    // La prestation n'est PAS obligatoire à l'écran : laissée vide, elle
    // reprend le libellé du type. « Carburant, 400 DH » est une saisie
    // complète et honnête ; exiger en plus d'écrire « Carburant » dans une
    // case ne documente rien et coûte un clavier de plus.
    const champPrestation = saisie({ maxlength: 200 });
    const champKm = saisie({ type: 'number', inputmode: 'numeric', min: 0, max: 3000000, placeholder: 'Compteur' });
    const champDepense = saisie({ type: 'text', inputmode: 'decimal', placeholder: '0,00' });
    const champRecette = saisie({ type: 'text', inputmode: 'decimal', placeholder: '0,00' });
    const champNotes = zoneTexte({ rows: 2, maxlength: 4000, placeholder: 'Précision utile (facultatif)' });

    // Un bloc, pas un « small » : en ligne, il se collait a l'etiquette du
    // champ suivant — « 162 300 kmPrestation ».
    const compteurConnu = h('p', { class: 'ligne-note' });
    const ligneResultat = h('strong', { class: 'resultat-positif' }, '0,00 DH');
    const avis = h('p', { class: 'ligne-note', role: 'alert' });
    const etiquetteDepense = h('span', {}, 'Dépense (DH)');
    const etiquetteRecette = h('span', {}, 'Recette (DH)');

    let typeRetenu = types.some((t) => t.code === dernier.typeCode)
      ? dernier.typeCode
      : (types[0]?.code ?? 'AUTRE');

    const rappelerCompteur = () => {
      const v = vehicules.find((x) => x.id === champVehicule.value);
      fill(compteurConnu, v && v.kilometrage != null
        ? h('span', {}, 'Dernier relevé connu : ', donnee(entier(v.kilometrage) + ' km'))
        : 'Aucun relevé connu pour ce véhicule.');
    };

    const recalculer = () => {
      const d = versCentimes(champDepense.value);
      const r = versCentimes(champRecette.value);
      if (d === null || r === null) {
        fill(ligneResultat, '—');
        ligneResultat.className = 'ligne-note';
        return;
      }
      const resultat = r - d;
      fill(ligneResultat, montantSigne(resultat));
      ligneResultat.className = resultat < 0 ? 'resultat-negatif' : 'resultat-positif';
    };

    champDepense.addEventListener('input', recalculer);
    champRecette.addEventListener('input', recalculer);

    /* --- Les types, en boutons (§23) --- */

    const boutonsType = h('div', { class: 'choix-type' });

    const peindreTypes = () => {
      fill(boutonsType, ...types.map((t) => h('button', {
        type: 'button',
        class: 'bouton petit' + (t.code === typeRetenu ? ' actif' : ''),
        onclick: () => {
          typeRetenu = t.code;
          peindreTypes();
          orienterMontants();
          // Le sens amène le clavier sur le champ qu'on remplit neuf fois
          // sur dix. Il n'interdit rien : une location peut coûter.
          if (t.sens === 'DEPENSE') champDepense.focus();
          else if (t.sens === 'RECETTE') champRecette.focus();
        },
      }, donnee(t.libelle))));
    };

    /**
     * Marque le champ de montant attendu, sans déplacer l'autre.
     *
     * Les deux restent côte à côte, au même endroit : un champ qui bouge
     * quand on choisit un type ferait perdre plus de temps qu'il n'en fait
     * gagner. Seule l'étiquette dit lequel on attend.
     */
    const orienterMontants = () => {
      const t = types.find((x) => x.code === typeRetenu);
      const attendu = t?.sens ?? 'MIXTE';
      fill(etiquetteDepense, 'Dépense (DH)', attendu === 'DEPENSE' ? ' ·' : '');
      fill(etiquetteRecette, 'Recette (DH)', attendu === 'RECETTE' ? ' ·' : '');
      champDepense.placeholder = attendu === 'DEPENSE' ? 'Montant payé' : '0,00';
      champRecette.placeholder = attendu === 'RECETTE' ? 'Montant encaissé' : '0,00';
      // La prestation propose le libellé du type : c'est ce qui sera
      // enregistré si on ne l'écrit pas soi-même.
      champPrestation.placeholder = t ? t.libelle : 'Ce que vous avez fait';
    };

    peindreTypes();
    orienterMontants();

    const pieces = selecteurPieces();

    /*
     * La note se déplie, elle ne s'impose pas.
     *
     * Elle sert une fois sur vingt. Laissée ouverte, elle allonge le
     * formulaire d'un bloc que la plupart des saisies franchissent sans le
     * remplir — et sur téléphone, chaque bloc traversé est du défilement.
     */
    const zoneNote = h('div', { hidden: true }, champ('Note', champNotes, { large: true }));
    const ouvrirNote = h('button', {
      type: 'button',
      class: 'bouton sourdine petit',
      onclick: () => {
        zoneNote.hidden = false;
        ouvrirNote.hidden = true;
        champNotes.focus();
      },
    }, icone('crayon'), h('span', {}, 'Ajouter une note'));
    const blocNote = h('div', {}, ouvrirNote, zoneNote);

    /* --- L'enregistrement --- */

    const valider = h('button', { type: 'submit', class: 'bouton principal' },
      icone('coche'), h('span', {}, 'Enregistrer'));

    async function envoyer(confirmerKilometrage = false) {
      fill(avis, '');

      const depenseCents = versCentimes(champDepense.value);
      const recetteCents = versCentimes(champRecette.value);
      if (depenseCents === null || recetteCents === null) {
        fill(avis, 'Un montant ne se lit pas. Exemple attendu : 1 035,50');
        return null;
      }

      // Prestation laissée vide : on enregistre le libellé du type. Le
      // serveur, lui, continue d'en exiger une — l'historique n'a jamais de
      // ligne sans intitulé, c'est le client qui fournit le défaut.
      const libelleType = types.find((t) => t.code === typeRetenu)?.libelle ?? typeRetenu;
      const prestation = champPrestation.value.trim() || libelleType;

      const corps = {
        vehiculeId: champVehicule.value,
        date: champDate.value,
        typeCode: typeRetenu,
        prestation,
        kilometrage: champKm.value === '' ? undefined : Number(champKm.value),
        depenseCents,
        recetteCents,
        notes: champNotes.value.trim() || undefined,
        idempotencyKey: cleIdempotence,
        confirmerKilometrage,
      };

      valider.disabled = true;
      try {
        const { activite } = await api.post('/api/activites', corps);
        // La prochaine ouverture repartira sur ce véhicule et ce type.
        retenirDerniereSaisie({ vehiculeId: corps.vehiculeId, typeCode: corps.typeCode });
        // Les pieces partent APRES : elles ont besoin de l'identifiant. Si
        // leur envoi echoue, l'activite reste — on ne perd pas la saisie
        // pour une photo, on le dit et elles se rajoutent depuis la fiche.
        try {
          await pieces.envoyer('activite', activite.id);
        } catch (err) {
          signalerErreur(err,
            'Activité enregistrée, mais les pièces jointes n’ont pas pu être envoyées');
        }
        return activite;
      } catch (err) {
        // 409 sur le kilometrage : ce n'est pas une saisie invalide, c'est
        // une incoherence avec ce que l'on sait deja. On montre le message
        // du serveur et l'on propose de passer outre (§4).
        if (err.statut === 409 && String(err.code || '').startsWith('KILOMETRAGE_')) {
          valider.disabled = false;
          const ok = await confirmer({
            titre: 'Kilométrage à confirmer',
            message: err.message,
            libelleConfirmation: 'Confirmer ce kilométrage',
            danger: false,
          });
          if (!ok) return null;
          return envoyer(true);
        }
        signalerErreur(err, 'Enregistrement impossible');
        const champs = err.champs;
        if (champs) fill(avis, Object.values(champs).join(' · '));
        return null;
      } finally {
        valider.disabled = false;
      }
    }

    const formulaire = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const creee = await envoyer(false);
        if (creee) { finir(creee); m.fermer(); }
      },
    },
    // L'ORDRE EST CELUI DE LA SAISIE RÉELLE, pas celui du cahier des
    // charges. On choisit d'abord CE QU'ON A FAIT — c'est la décision qui
    // oriente tout le reste —, puis on tape le montant. Le véhicule et la
    // date sont déjà justes neuf fois sur dix : ils se relisent, ils ne se
    // remplissent pas.
    h('div', { class: 'champ large' },
      h('span', {}, 'Type d’activité'),
      boutonsType),

    h('div', { class: 'ligne-champs' },
      h('label', { class: 'champ' }, etiquetteDepense, champDepense),
      h('label', { class: 'champ' }, etiquetteRecette, champRecette)),

    h('div', { class: 'encadre' },
      h('div', { class: 'titre' }, 'Résultat ', ligneResultat),
      h('div', { class: 'ligne-note' },
        'Recette moins dépense. Activité non déclarée : aucune TVA n’est appliquée.')),

    h('div', { class: 'ligne-champs' },
      champ('Véhicule', champVehicule),
      champ('Date', champDate)),

    champ('Kilométrage', champKm, { large: true }),
    compteurConnu,

    champ('Prestation', champPrestation, {
      large: true,
      aide: 'Facultatif. Sans rien, le type sert de libellé.',
    }),

    pieces.noeud,
    blocNote,
    avis);

    const m = modale({
      titre: 'Nouvelle activité',
      sousTitre: 'Véhicule, ce que vous avez fait, ce que cela a coûté et rapporté.',
      contenu: formulaire,
      actions: [
        h('button', { type: 'button', class: 'bouton', onclick: () => { finir(null); m.fermer(); } }, 'Annuler'),
        valider,
      ],
      surFermeture: () => finir(null),
    });

    // Le bouton d'action vit dans le pied de la modale, hors du <form> :
    // sans cela, « Entrée » dans un champ n'enverrait rien.
    valider.addEventListener('click', (e) => {
      e.preventDefault();
      formulaire.requestSubmit();
    });

    rappelerCompteur();
    recalculer();

    // Le curseur se pose sur le MONTANT, pas sur la prestation : le type est
    // déjà choisi — celui de la dernière fois — et la prestation est
    // facultative. Ce qui reste à taper, c'est le chiffre.
    const sensRetenu = types.find((t) => t.code === typeRetenu)?.sens;
    (sensRetenu === 'RECETTE' ? champRecette : champDepense).focus();
  });
}
