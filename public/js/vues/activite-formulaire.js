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
  h, fill, api, etat, modale, champ, saisie, liste, zoneTexte, icone,
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

    const champVehicule = liste(
      vehicules.map((v) => ({ value: v.id, label: v.nom + ' — ' + v.immatriculation })),
      vehiculeId ?? vehicules[0].id,
      { onchange: () => rappelerCompteur() },
    );

    const champDate = saisie({ type: 'date', value: aujourdhui(), max: aujourdhui(), required: true });
    const champPrestation = saisie({ maxlength: 200, required: true, placeholder: 'Remorquage Oujda → Nador' });
    const champKm = saisie({ type: 'number', inputmode: 'numeric', min: 0, max: 3000000, placeholder: 'Compteur' });
    const champDepense = saisie({ type: 'text', inputmode: 'decimal', placeholder: '0,00' });
    const champRecette = saisie({ type: 'text', inputmode: 'decimal', placeholder: '0,00' });
    const champNotes = zoneTexte({ rows: 2, maxlength: 4000, placeholder: 'Précision utile (facultatif)' });

    const compteurConnu = h('small', { class: 'ligne-note' });
    const ligneResultat = h('strong', { class: 'resultat-positif' }, '0,00 DH');
    const avis = h('p', { class: 'ligne-note', role: 'alert' });

    let typeRetenu = types[0]?.code ?? 'AUTRE';

    const rappelerCompteur = () => {
      const v = vehicules.find((x) => x.id === champVehicule.value);
      fill(compteurConnu, v && v.kilometrage != null
        ? 'Dernier relevé connu : ' + entier(v.kilometrage) + ' km'
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
          // Le sens oriente le clavier vers le champ qu'on remplit
          // habituellement. Il n'interdit rien : une location peut coûter.
          if (t.sens === 'DEPENSE') champDepense.focus();
          else if (t.sens === 'RECETTE') champRecette.focus();
        },
      }, t.libelle)));
    };
    peindreTypes();

    const pieces = selecteurPieces();

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
      if (!champPrestation.value.trim()) {
        fill(avis, 'Indiquez ce qui a été fait.');
        champPrestation.focus();
        return null;
      }

      const corps = {
        vehiculeId: champVehicule.value,
        date: champDate.value,
        typeCode: typeRetenu,
        prestation: champPrestation.value.trim(),
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
    champ('Véhicule', champVehicule, { large: true }),
    h('div', { class: 'ligne-champs' },
      champ('Date', champDate),
      champ('Kilométrage', champKm, { aide: null })),
    compteurConnu,

    h('div', { class: 'champ large' },
      h('span', {}, 'Type d’activité'),
      boutonsType),

    champ('Prestation', champPrestation, { large: true, aide: 'Ce que vous avez fait, en clair.' }),

    h('div', { class: 'ligne-champs' },
      champ('Dépense (DH)', champDepense),
      champ('Recette (DH)', champRecette)),

    h('div', { class: 'encadre' },
      h('span', {}, 'Résultat '),
      ligneResultat,
      h('small', { class: 'ligne-note' },
        'Recette moins dépense. Activité non déclarée : aucune TVA n’est appliquée.')),

    champ('Notes', champNotes, { large: true }),
    pieces.noeud,
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
    champPrestation.focus();
  });
}
