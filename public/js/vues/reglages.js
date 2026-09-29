/**
 * Les parametres : seuils d'alerte et types configurables (§15, §35).
 *
 * C'est l'ecran qui donne son sens a la regle 17 du cahier des charges —
 * « ne pas coder en dur les paramètres métier qui doivent être
 * configurables ». Chaque seuil y montre ses bornes : une valeur refusee
 * doit dire pourquoi avant qu'on l'envoie, pas apres.
 *
 * Un type livre en standard ne se supprime pas, il se desactive : des
 * activites s'y rattachent, et les effacer leur ferait perdre leur libelle.
 * Le bouton de suppression n'apparait donc que la ou il peut agir.
 */
import {
  h, fill, api, etat, icone, etatVide, chargement, saisie, liste,
  signalerErreur, succes, confirmer, modale, champ,
} from '../core.js';

export async function rendre() {
  const racine = h('div', {});
  const corpsSeuils = h('div', {}, chargement());
  const corpsTypes = h('div', {}, chargement());
  let domaine = 'ACTIVITE';

  /* ---------------- Les seuils ---------------- */

  async function relireSeuils() {
    try {
      const { reglages, seuilsAppliques } = await api.get('/api/reglages');
      fill(corpsSeuils, peindreSeuils(reglages, seuilsAppliques));
    } catch (err) {
      fill(corpsSeuils, etatVide('Paramètres indisponibles.'));
      signalerErreur(err, 'Lecture des paramètres');
    }
  }

  const peindreSeuils = (reglages, appliques) => {
    const familles = [
      { cle: 'alertes', titre: 'Seuils d’alerte', aide:
        'À partir de quelle distance ou de quel délai une échéance change de couleur. ' +
        'Ils s’appliquent immédiatement, sans redémarrage.' },
      { cle: 'securite', titre: 'Sécurité', aide:
        'Réservé au super-administrateur. Ces valeurs ferment l’application : ' +
        'les desserrer a un coût.' },
    ];

    return h('div', {},
      h('div', { class: 'carte' },
        h('div', { class: 'carte-entete' }, h('h2', {}, 'Ce qui s’applique aujourd’hui')),
        h('div', { class: 'carte-corps' },
          h('dl', { class: 'definitions' },
            h('dt', {}, 'Attention à partir de'),
            h('dd', {}, appliques.kmAttention + ' km ou ' + appliques.joursAttention + ' jours'),
            h('dt', {}, 'Urgent en dessous de'),
            h('dd', {}, appliques.kmUrgent + ' km ou ' + appliques.joursUrgent + ' jours'),
            h('dt', {}, 'Recul du compteur toléré'),
            h('dd', {}, appliques.reculToleKm + ' km')))),

      ...familles.map((f) => {
        const siens = reglages.filter((r) => r.categorie === f.cle);
        if (!siens.length) return null;
        return h('section', { class: 'carte' },
          h('div', { class: 'carte-entete' }, h('h2', {}, f.titre)),
          h('div', { class: 'carte-corps' },
            h('p', { class: 'ligne-note' }, f.aide),
            ...siens.map(ligneReglage)));
      }));
  };

  const ligneReglage = (r) => {
    const modifiable = etat.peut('settings.edit')
      && (r.categorie !== 'securite' || etat.utilisateur.role?.code === 'SUPERADMIN');

    const champValeur = saisie({
      type: 'number',
      value: r.valeur,
      min: r.bornes?.min,
      max: r.bornes?.max,
      disabled: !modifiable,
    });

    const enregistrer = async () => {
      try {
        await api.patch('/api/reglages/' + encodeURIComponent(r.cle), {
          valeur: Number(champValeur.value),
        });
        succes('Paramètre enregistré', r.libelle);
        await relireSeuils();
      } catch (err) {
        signalerErreur(err, 'Enregistrement impossible');
        champValeur.value = r.valeur;
      }
    };

    return h('div', { class: 'ligne-champs', style: { alignItems: 'end' } },
      champ(r.libelle, champValeur, {
        large: true,
        aide: r.bornes ? 'Entre ' + r.bornes.min + ' et ' + r.bornes.max + '.' : null,
      }),
      modifiable
        ? h('button', { class: 'bouton', onclick: enregistrer }, 'Enregistrer')
        : null);
  };

  /* ---------------- Les types ---------------- */

  async function relireTypes() {
    try {
      const { types } = await api.get('/api/reglages/types/' + domaine);
      fill(corpsTypes, peindreTypes(types));
    } catch (err) {
      fill(corpsTypes, etatVide('Types indisponibles.'));
      signalerErreur(err, 'Lecture des types');
    }
  }

  const peindreTypes = (types) => h('div', { class: 'table-enveloppe' },
    h('table', { class: 'donnees' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Libellé'),
        h('th', {}, 'Code'),
        domaine === 'ACTIVITE' ? h('th', {}, 'Oriente vers') : null,
        h('th', { class: 'num' }, 'Usages'),
        h('th', {}, 'État'),
        h('th', {}, ''))),
      h('tbody', {}, ...types.map((t) => h('tr', {},
        h('td', {}, t.libelle),
        h('td', {}, h('code', {}, t.code)),
        domaine === 'ACTIVITE' ? h('td', {}, libelleSens(t.sens)) : null,
        h('td', { class: 'num' }, String(t.usages)),
        h('td', {}, t.actif
          ? h('span', { class: 'pastille succes' }, 'Actif')
          : h('span', { class: 'pastille' }, 'Désactivé')),
        h('td', {}, etat.peut('settings.edit')
          ? h('div', { class: 'groupe-boutons' },
            h('button', {
              class: 'bouton petit',
              onclick: () => formulaireType(t, relireTypes),
              title: 'Modifier',
            }, icone('crayon')),
            h('button', {
              class: 'bouton petit',
              onclick: () => basculer(t, relireTypes),
            }, t.actif ? 'Désactiver' : 'Réactiver'),
            // Le bouton n'apparait que la ou il peut agir : un type
            // standard ou deja utilise ne se supprime pas, et un bouton
            // qui refuse toujours n'apprend rien.
            !t.systeme && t.usages === 0
              ? h('button', {
                class: 'bouton petit danger',
                onclick: () => supprimerType(t, relireTypes),
                title: 'Supprimer',
              }, icone('corbeille'))
              : null)
          : null))))));

  const libelleSens = (s) => ({
    DEPENSE: 'la dépense', RECETTE: 'la recette', MIXTE: 'aucun champ',
  }[s] ?? s);

  async function basculer(t, apres) {
    try {
      await api.patch('/api/reglages/types/' + t.domaine + '/' + t.code, { actif: !t.actif });
      succes(t.actif ? 'Type désactivé' : 'Type réactivé', t.libelle);
      apres();
    } catch (err) { signalerErreur(err, 'Modification impossible'); }
  }

  async function supprimerType(t, apres) {
    const ok = await confirmer({
      titre: 'Supprimer « ' + t.libelle + ' » ?',
      message: 'Ce type n’est utilisé par aucun enregistrement : sa suppression ne casse rien.',
      libelleConfirmation: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete('/api/reglages/types/' + t.domaine + '/' + t.code);
      succes('Type supprimé', t.libelle);
      apres();
    } catch (err) { signalerErreur(err, 'Suppression impossible'); }
  }

  function formulaireType(existant, apres) {
    const champLibelle = saisie({ maxlength: 60, value: existant?.libelle ?? '', required: true });
    const champCode = saisie({
      maxlength: 40,
      value: existant?.code ?? '',
      disabled: Boolean(existant),
      placeholder: 'LAVAGE',
    });
    const champSens = liste(
      [{ value: 'MIXTE', label: 'Aucun champ' },
        { value: 'DEPENSE', label: 'La dépense' },
        { value: 'RECETTE', label: 'La recette' }],
      existant?.sens ?? 'MIXTE',
    );
    const champOrdre = saisie({ type: 'number', min: 0, max: 9999, value: existant?.ordre ?? 500 });
    const avis = h('p', { class: 'ligne-note', role: 'alert' });

    const enregistrer = async () => {
      fill(avis, '');
      const corps = {
        libelle: champLibelle.value.trim(),
        sens: champSens.value,
        ordre: Number(champOrdre.value),
      };
      try {
        if (existant) {
          await api.patch('/api/reglages/types/' + domaine + '/' + existant.code, corps);
        } else {
          await api.post('/api/reglages/types/' + domaine, {
            ...corps, code: champCode.value.trim().toUpperCase(),
          });
        }
        succes(existant ? 'Type modifié' : 'Type créé', corps.libelle);
        m.fermer();
        apres();
      } catch (err) { fill(avis, err?.message || 'Enregistrement impossible.'); }
    };

    const m = modale({
      titre: existant ? 'Modifier le type' : 'Nouveau type',
      contenu: h('div', {},
        champ('Libellé', champLibelle, { large: true }),
        champ('Code', champCode, {
          large: true,
          aide: existant
            ? 'Le code ne change pas : des enregistrements y font référence.'
            : 'Majuscules, chiffres et tirets bas. Il ne changera plus.',
        }),
        domaine === 'ACTIVITE'
          ? champ('Oriente la saisie vers', champSens, {
            large: true,
            aide: 'Place le curseur sur ce champ à la saisie. N’interdit rien.',
          })
          : null,
        champ('Ordre d’affichage', champOrdre, { large: true }),
        avis),
      actions: [
        h('button', { class: 'bouton', onclick: () => m.fermer() }, 'Annuler'),
        h('button', { class: 'bouton principal', onclick: enregistrer }, 'Enregistrer'),
      ],
    });
  }

  /* ---------------- L'ecran ---------------- */

  const onglets = h('div', { class: 'onglets' });
  const peindreOnglets = () => {
    fill(onglets,
      ...[['ACTIVITE', 'Types d’activité'], ['ENTRETIEN', 'Types d’entretien']]
        .map(([code, libelle]) => h('button', {
          class: 'onglet' + (domaine === code ? ' actif' : ''),
          onclick: () => { domaine = code; peindreOnglets(); relireTypes(); },
        }, libelle)));
  };
  peindreOnglets();

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {},
        h('h1', {}, 'Paramètres'),
        h('p', {}, 'Les seuils d’alerte et les listes de types, réglables sans redéploiement.'))),

    corpsSeuils,

    h('section', { class: 'carte' },
      h('div', { class: 'carte-entete' },
        h('h2', {}, 'Types'),
        etat.peut('settings.edit')
          ? h('button', { class: 'bouton petit', onclick: () => formulaireType(null, relireTypes) },
            icone('plus'), h('span', {}, 'Nouveau type'))
          : null),
      h('div', { class: 'carte-corps' }, onglets, corpsTypes)));

  relireSeuils();
  relireTypes();
  return racine;
}
