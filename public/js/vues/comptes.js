/**
 * Les comptes et les roles.
 *
 * LE MOT DE PASSE PROVISOIRE NE S'AFFICHE QU'UNE FOIS.
 *
 * Le serveur le rend a la creation et a la reinitialisation, et il ne le
 * stocke pas en clair : personne ne pourra le relire. L'ecran le presente
 * donc dans une boite qu'on ferme volontairement, avec un bouton de copie,
 * plutot que dans une notification qui disparait au bout de cinq secondes —
 * on perdrait le mot de passe en regardant ailleurs.
 */
import {
  h, fill, api, etat, icone, dateHeureFr, etatVide, chargement,
  modale, champ, saisie, liste, signalerErreur, succes, confirmer,
} from '../core.js';

export async function rendre() {
  const racine = h('div', {});
  const corps = h('div', {}, chargement());
  let roles = [];

  async function relire() {
    try {
      const [{ comptes }, donneesRoles] = await Promise.all([
        api.get('/api/utilisateurs'),
        api.get('/api/utilisateurs/roles'),
      ]);
      roles = donneesRoles.roles;
      fill(corps, peindre(comptes, donneesRoles));
    } catch (err) {
      fill(corps, etatVide('Comptes indisponibles.'));
      signalerErreur(err, 'Lecture des comptes');
    }
  }

  const peindre = (comptes, donneesRoles) => h('div', {},
    h('div', { class: 'table-enveloppe' },
      h('table', { class: 'donnees' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Identifiant'),
          h('th', {}, 'Nom'),
          h('th', {}, 'Rôle'),
          h('th', {}, 'État'),
          h('th', {}, 'Dernière connexion'),
          h('th', {}, ''))),
        h('tbody', {}, ...comptes.map((c) => h('tr', {},
          h('td', {}, h('code', {}, c.username)),
          h('td', {}, c.fullName),
          h('td', {}, c.role.name),
          h('td', {},
            c.actif
              ? h('span', { class: 'pastille succes' }, 'Actif')
              : h('span', { class: 'pastille danger' }, 'Désactivé'),
            c.doitChangerMotDePasse
              ? h('span', { class: 'pastille attente' }, 'Mot de passe à changer')
              : null),
          h('td', {}, c.derniereConnexion ? dateHeureFr(c.derniereConnexion) : 'jamais'),
          h('td', {}, etat.peut('user.manage') && peutAgir(c)
            ? h('div', { class: 'groupe-boutons' },
              h('button', {
                class: 'bouton petit', title: 'Modifier',
                onclick: () => formulaireCompte(c, relire),
              }, icone('crayon')),
              h('button', {
                class: 'bouton petit', onclick: () => reinitialiser(c),
              }, 'Mot de passe'))
            : null)))))),

    blocRoles(donneesRoles, relire));

  /** Le rang decide de qui peut agir sur qui : strictement inferieur. */
  const peutAgir = (cible) => (etat.utilisateur.role?.rank ?? 999) < (cible.role.rank ?? 999);

  const blocRoles = (donnees, apres) => h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' }, h('h2', {}, 'Rôles')),
    h('div', { class: 'carte-corps' },
      h('p', { class: 'ligne-note' },
        'Les permissions disent ce qu’on peut faire ; le rang dit sur qui. ' +
        'Un compte n’agit que sur un rang strictement inférieur au sien.'),
      h('div', { class: 'table-enveloppe' },
        h('table', { class: 'donnees' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Rôle'), h('th', { class: 'num' }, 'Rang'),
            h('th', { class: 'num' }, 'Comptes'), h('th', { class: 'num' }, 'Droits'),
            h('th', {}, ''))),
          h('tbody', {}, ...donnees.roles.map((r) => h('tr', {},
            h('td', {}, h('strong', {}, r.name),
              h('div', { class: 'ligne-note' }, r.description),
              r.personnalise ? h('span', { class: 'pastille info' }, 'Droits redéfinis') : null),
            h('td', { class: 'num' }, String(r.rank)),
            h('td', { class: 'num' }, String(r.nbComptes)),
            h('td', { class: 'num' }, r.code === 'SUPERADMIN' ? 'tous' : String(r.permissions.length)),
            h('td', {},
              etat.peut('role.manage') && r.code !== 'SUPERADMIN'
                ? h('button', {
                  class: 'bouton petit',
                  onclick: () => editerDroits(r, donnees.catalogue ?? [], donnees.reserveSuperadmin ?? [], apres),
                }, 'Droits')
                : null))))))));

  /* ---------------- Formulaires ---------------- */

  function formulaireCompte(existant, apres) {
    const champIdentifiant = saisie({
      maxlength: 40, value: existant?.username ?? '', disabled: Boolean(existant),
    });
    const champNom = saisie({ maxlength: 120, value: existant?.fullName ?? '', required: true });
    const champEmail = saisie({ type: 'email', maxlength: 160, value: existant?.email ?? '' });
    const champTelephone = saisie({ maxlength: 30, value: existant?.phone ?? '' });

    // On ne propose que les roles sur lesquels on a autorite.
    const monRang = etat.utilisateur.role?.rank ?? 999;
    const choix = roles.filter((r) => r.rank > monRang)
      .map((r) => ({ value: r.id, label: r.name }));
    const champRole = liste(choix, existant?.role?.id ?? choix[0]?.value);
    const champActif = h('input', { type: 'checkbox', checked: existant ? existant.actif : true });
    const avis = h('p', { class: 'ligne-note', role: 'alert' });

    if (!choix.length) {
      signalerErreur(new Error('Aucun rôle ne vous est subordonné.'), 'Création impossible');
      return;
    }

    const enregistrer = async () => {
      fill(avis, '');
      const corps = {
        fullName: champNom.value.trim(),
        email: champEmail.value.trim() || undefined,
        phone: champTelephone.value.trim() || undefined,
        roleId: champRole.value,
      };
      try {
        if (existant) {
          await api.patch('/api/utilisateurs/' + existant.id, { ...corps, actif: champActif.checked });
          succes('Compte modifié', existant.username);
        } else {
          const { motDePasseProvisoire, compte } = await api.post('/api/utilisateurs', {
            ...corps, username: champIdentifiant.value.trim().toLowerCase(),
          });
          montrerMotDePasse(compte.username, motDePasseProvisoire);
        }
        m.fermer();
        apres();
      } catch (err) { fill(avis, err?.message || 'Enregistrement impossible.'); }
    };

    const m = modale({
      titre: existant ? 'Modifier « ' + existant.username + ' »' : 'Nouveau compte',
      contenu: h('div', {},
        champ('Identifiant', champIdentifiant, {
          large: true,
          aide: existant ? 'L’identifiant ne change pas.' : 'Minuscules, chiffres, . _ et -',
        }),
        champ('Nom complet', champNom, { large: true }),
        h('div', { class: 'ligne-champs' },
          champ('Adresse électronique', champEmail),
          champ('Téléphone', champTelephone)),
        champ('Rôle', champRole, { large: true }),
        existant
          ? h('label', { class: 'case' }, champActif, h('span', {}, 'Compte actif'))
          : null,
        avis),
      actions: [
        h('button', { class: 'bouton', onclick: () => m.fermer() }, 'Annuler'),
        h('button', { class: 'bouton principal', onclick: enregistrer }, 'Enregistrer'),
      ],
    });
  }

  async function reinitialiser(c) {
    const ok = await confirmer({
      titre: 'Réinitialiser le mot de passe de « ' + c.username + ' » ?',
      message: 'Un mot de passe provisoire sera généré et affiché une seule fois. ' +
        'Toutes les sessions ouvertes de ce compte seront fermées.',
      libelleConfirmation: 'Réinitialiser',
      danger: true,
    });
    if (!ok) return;
    try {
      const { motDePasseProvisoire } = await api.post('/api/utilisateurs/' + c.id + '/mot-de-passe', {});
      montrerMotDePasse(c.username, motDePasseProvisoire);
    } catch (err) { signalerErreur(err, 'Réinitialisation impossible'); }
  }

  /** La boite qui montre le mot de passe. Elle ne se ferme pas toute seule. */
  function montrerMotDePasse(identifiant, motDePasse) {
    const champMdp = saisie({ value: motDePasse, readonly: true });
    const m = modale({
      titre: 'Mot de passe provisoire',
      sousTitre: 'Pour « ' + identifiant + ' »',
      contenu: h('div', {},
        h('p', {},
          'Notez-le maintenant : il ne sera plus affiché, et personne ne pourra le relire. ' +
          'Son titulaire devra le changer à sa première connexion.'),
        champMdp,
        h('button', {
          class: 'bouton', style: { marginTop: '10px' },
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(motDePasse);
              succes('Copié', 'Le mot de passe est dans le presse-papiers.');
            } catch {
              // Le presse-papiers n'est pas toujours accessible (contexte non
              // securise, permission refusee) : le champ reste selectionnable.
              champMdp.select();
            }
          },
        }, 'Copier')),
      actions: [h('button', { class: 'bouton principal', onclick: () => m.fermer() }, 'J’ai noté')],
    });
    champMdp.select();
  }

  /* ---------------- Les droits d'un role ---------------- */

  function editerDroits(role, catalogue, reserve, apres) {
    const retenues = new Set(role.permissions);
    const parCategorie = new Map();
    for (const p of catalogue) {
      if (!parCategorie.has(p.category)) parCategorie.set(p.category, []);
      parCategorie.get(p.category).push(p);
    }

    const enregistrer = async () => {
      try {
        await api.put('/api/utilisateurs/roles/' + role.id + '/permissions', {
          permissions: [...retenues],
        });
        succes('Droits enregistrés', role.name +
          ' — les sessions ouvertes de ce rôle ont été fermées.');
        m.fermer();
        apres();
      } catch (err) { signalerErreur(err, 'Enregistrement impossible'); }
    };

    const m = modale({
      titre: 'Droits du rôle « ' + role.name + ' »',
      sousTitre: 'Les comptes qui le portent seront déconnectés : leurs sessions portent les anciens droits.',
      taille: 'large',
      contenu: h('div', {},
        ...[...parCategorie.entries()].map(([categorie, permissions]) =>
          h('section', { style: { marginBottom: '14px' } },
            h('h3', {}, categorie),
            ...permissions.map((p) => h('label', { class: 'case' },
              h('input', {
                type: 'checkbox',
                checked: retenues.has(p.code),
                onchange: (e) => (e.target.checked ? retenues.add(p.code) : retenues.delete(p.code)),
              }),
              h('span', {}, p.label,
                p.sensitive ? h('span', { class: 'pastille danger' }, 'sensible') : null,
                reserve.includes(p.code)
                  ? h('span', { class: 'pastille attente' }, 'réservé')
                  : null)))))),
      actions: [
        h('button', { class: 'bouton', onclick: () => m.fermer() }, 'Annuler'),
        h('button', { class: 'bouton principal', onclick: enregistrer }, 'Enregistrer'),
      ],
    });
  }

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {}, h('h1', {}, 'Comptes')),
      h('div', { class: 'page-actions' },
        etat.peut('user.manage')
          ? h('button', { class: 'bouton principal', onclick: () => formulaireCompte(null, relire) },
            icone('plus'), h('span', {}, 'Nouveau compte'))
          : null)),
    corps);

  relire();
  return racine;
}
