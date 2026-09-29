/**
 * L'application : amorcage, navigation, routage.
 *
 * Un routeur par fragment d'adresse (« #/vehicules/... »), sans bibliotheque.
 * Chaque vue est un module charge A LA DEMANDE : ouvrir le tableau de bord
 * sur un telephone en 3G ne doit pas telecharger l'ecran des parametres.
 *
 * LE PARCOURS MOBILE EST LE PARCOURS PRINCIPAL (§23, §38).
 *
 * Le bouton « Nouvelle activité » est present sur TOUS les ecrans, en bas a
 * droite, a portee du pouce. C'est le geste qu'on vient faire ; il ne doit
 * jamais demander de naviguer d'abord.
 */
import {
  h, fill, $, etat, api, icone, signalerErreur, notifier, succes, donnee,
  chargement, etatVide, saisie, champ,
} from './core.js';
import { initLangue, definirLangue, langue, LANGUES, chainesManquantes } from './i18n.js';

/* ================================================================== */
/*  Le menu                                                            */
/* ================================================================== */

/**
 * Chaque entree porte le droit qui la rend visible.
 *
 * Une entree sans droit n'est pas grisee : elle n'apparait pas. Un menu qui
 * montre ce qu'on ne peut pas ouvrir n'apprend rien d'utile et fait perdre
 * un clic a chaque fois.
 */
const MENU = [
  // `libelleCourt` est ce que porte la barre basse du téléphone : quatre
  // cibles doivent tenir sur 390 px sans rétrécir sous le doigt.
  { route: '', libelle: 'Tableau de bord', libelleCourt: 'Accueil', icone: 'tableau', droit: 'dashboard.view' },
  { route: 'vehicules', libelle: 'Véhicules', icone: 'voiture', droit: 'vehicle.view' },
  { route: 'activites', libelle: 'Activités', icone: 'activite', droit: 'activity.view' },
  { route: 'entretiens', libelle: 'Entretiens', libelleCourt: 'Échéances', icone: 'cle', droit: 'maintenance.view' },
  { route: 'statistiques', libelle: 'Statistiques', icone: 'rapport', droit: 'stats.view' },
  { route: 'reglages', libelle: 'Paramètres', icone: 'administration', droit: 'settings.view' },
  { route: 'comptes', libelle: 'Comptes', icone: 'utilisateur', droit: 'user.view' },
  { route: 'journal', libelle: 'Journal', icone: 'journal', droit: 'audit.view' },
];

/** Les vues, chargees a la demande. */
const VUES = {
  '': () => import('./vues/tableau-de-bord.js'),
  vehicules: () => import('./vues/vehicules.js'),
  activites: () => import('./vues/activites.js'),
  entretiens: () => import('./vues/entretiens.js'),
  statistiques: () => import('./vues/statistiques.js'),
  reglages: () => import('./vues/reglages.js'),
  comptes: () => import('./vues/comptes.js'),
  journal: () => import('./vues/journal.js'),
};

/* ================================================================== */
/*  Amorcage                                                           */
/* ================================================================== */

async function demarrer() {
  // La langue AVANT tout rendu : elle pose `lang` et `dir` sur le document,
  // d'où le navigateur tire l'alignement et le sens des listes. Posée
  // après, le premier écran s'afficherait aligné à gauche en darija.
  initLangue();
  appliquerTheme(localStorage.getItem('theme') || 'auto');

  try {
    const session = await api.get('/api/auth/session');
    if (!session.authenticated) {
      montrerConnexion(session.settings);
      return;
    }
    await ouvrirApplication(session);
  } catch (err) {
    // L'application ne peut pas demarrer : on le dit en clair plutot que de
    // laisser l'ecran de chargement tourner indefiniment.
    fill($('#ecran-demarrage'),
      h('div', { class: 'demarrage-marque' },
        h('p', { class: 'demarrage-texte' },
          err?.message || 'Le serveur ne répond pas.'),
        h('button', { class: 'bouton principal', onclick: () => location.reload() }, 'Réessayer')));
  }
}

async function ouvrirApplication(session) {
  etat.utilisateur = session.user;
  etat.csrfToken = session.csrfToken;
  etat.parametres = session.settings ?? null;

  // Le mot de passe a changer passe avant tout le reste : tant qu'il ne
  // l'est pas, aucun ecran ne s'ouvre.
  if (session.user.mustChangePassword) {
    montrerChangementMotDePasse();
    return;
  }

  etat.meta = await api.get('/api/meta');
  // La reponse de /session porte les seuils ; celle de /login, non — elle
  // precede l'ouverture de la session. /api/meta les porte dans les deux
  // cas, et c'est la source qui vaut.
  etat.seuils = etat.meta?.seuils ?? session.settings?.seuils ?? null;

  $('#ecran-demarrage').hidden = true;
  $('#application').hidden = false;

  construireMenu();
  construireCarteUtilisateur();
  construireBoutonFlottant();

  $('#bouton-menu').addEventListener('click', () => $('#rail').classList.toggle('ouvert'));
  $('#bouton-theme').addEventListener('click', basculerTheme);
  construireChoixLangue();

  window.addEventListener('hashchange', router);
  window.addEventListener('session-perdue', (e) => {
    if (e.detail?.ecriture) {
      notifier('erreur', 'Session expirée',
        'Votre session a expiré AVANT que cette modification soit enregistrée : elle n’a pas été prise en compte. Reconnectez-vous et recommencez.',
        { duree: 0 });
    }
    setTimeout(() => location.reload(), e.detail?.ecriture ? 6000 : 300);
  });

  await router();
}

/* ================================================================== */
/*  Routage                                                            */
/* ================================================================== */

/** « #/vehicules/abc?du=2026-09-01 » -> { segments, parametres } */
function lireAdresse() {
  const brut = location.hash.replace(/^#\/?/, '');
  const [chemin, requete] = brut.split('?');
  return {
    segments: chemin.split('/').filter(Boolean),
    parametres: Object.fromEntries(new URLSearchParams(requete || '')),
  };
}

let rendusEnCours = 0;

async function router() {
  const { segments, parametres } = lireAdresse();
  const racine = segments[0] ?? '';
  const contenu = $('#contenu');

  const entree = MENU.find((m) => m.route === racine);
  if (entree && !etat.peut(entree.droit)) {
    fill(contenu, etatVide('Vous n’avez pas accès à cet écran.'));
    return;
  }
  if (!VUES[racine]) {
    fill(contenu, etatVide('Cette adresse n’existe pas.'));
    return;
  }

  marquerMenuActif(racine);
  fill(contenu, chargement());

  // Deux navigations rapprochees : seule la derniere doit peindre. Sans ce
  // jeton, revenir en arriere pendant un chargement lent affiche l'ecran
  // precedent par-dessus le nouveau.
  const jeton = ++rendusEnCours;

  try {
    const module = await VUES[racine]();
    if (jeton !== rendusEnCours) return;
    const noeud = await module.rendre({ segments: segments.slice(1), parametres });
    if (jeton !== rendusEnCours) return;
    fill(contenu, noeud);
    contenu.focus();
    $('#rail').classList.remove('ouvert');
  } catch (err) {
    if (jeton !== rendusEnCours) return;
    fill(contenu, etatVide(
      err?.message || 'Cet écran n’a pas pu être affiché.',
      h('button', { class: 'bouton principal', onclick: () => router() }, 'Réessayer'),
    ));
    signalerErreur(err, 'Affichage impossible');
  }
}

/**
 * Ce qu'il reste a traduire, lisible depuis la console du navigateur :
 *
 *     chainesManquantes()
 *
 * Rien n'est envoye nulle part. C'est le moyen le plus court de completer
 * le dictionnaire — on parcourt les ecrans en darija, et la liste dit
 * exactement ce qui est reste en francais.
 */
window.chainesManquantes = chainesManquantes;

/** Navigation interne : les vues appellent ceci plutot que de toucher au hash. */
export function aller(chemin, parametres = null) {
  const qs = parametres ? '?' + new URLSearchParams(parametres).toString() : '';
  location.hash = '#/' + chemin + qs;
}
window.aller = aller;

/* ================================================================== */
/*  Ossature                                                           */
/* ================================================================== */

function construireMenu() {
  const accessibles = MENU.filter((m) => etat.peut(m.droit));

  fill($('#navigation'), ...accessibles.map((m) => h('a', {
    class: 'nav-lien',
    href: '#/' + m.route,
    dataset: { route: m.route },
  }, icone(m.icone), h('span', {}, m.libelle))));

  construireOngletsBas(accessibles);
}

/**
 * La barre d'onglets du téléphone.
 *
 * QUATRE DESTINATIONS, PAS HUIT. Une barre basse tient quatre cibles de
 * quarante-quatre pixels sur un écran de 390 ; au-delà, elles rétrécissent
 * et l'on touche à côté. Les quatre retenues sont celles qu'on ouvre tous
 * les jours ; le reste vit derrière « Plus », qui déplie le rail — il n'est
 * pas perdu, il est rangé.
 *
 * Le rail latéral reste la navigation du bureau : la barre basse disparaît
 * au-delà de 720 px, et aucun des deux ne duplique l'état de l'autre — ils
 * lisent la même liste.
 */
const ROUTES_PRINCIPALES = ['', 'vehicules', 'activites', 'entretiens'];

function construireOngletsBas(accessibles) {
  const principales = accessibles.filter((m) => ROUTES_PRINCIPALES.includes(m.route));
  const reste = accessibles.filter((m) => !ROUTES_PRINCIPALES.includes(m.route));

  const onglets = principales.map((m) => h('a', {
    class: 'onglet-bas',
    href: '#/' + m.route,
    dataset: { route: m.route },
  }, icone(m.icone, 21), h('span', {}, m.libelleCourt ?? m.libelle)));

  if (reste.length) {
    onglets.push(h('button', {
      type: 'button',
      class: 'onglet-bas',
      onclick: () => $('#rail').classList.toggle('ouvert'),
    }, icone('menu', 21), h('span', {}, 'Plus')));
  }

  fill($('#onglets-bas'), ...onglets);
}

function marquerMenuActif(racine) {
  for (const lien of document.querySelectorAll('.nav-lien, .onglet-bas')) {
    lien.classList.toggle('actif', lien.dataset.route === racine);
  }
  const entree = MENU.find((m) => m.route === racine);
  fill($('#fil-ariane'), entree ? entree.libelle : '');
  document.title = (entree ? entree.libelle + ' — ' : '') + 'Lahlal, gestion de flotte';
}

function construireCarteUtilisateur() {
  const u = etat.utilisateur;
  fill($('#carte-utilisateur'),
    h('div', { class: 'avatar' }, initiales(u.fullName || u.username)),
    h('div', {},
      h('strong', {}, donnee(u.fullName || u.username)),
      h('span', {}, donnee(u.role?.name || ''))),
    h('button', {
      type: 'button',
      class: 'bouton-sortie',
      title: 'Se déconnecter',
      'aria-label': 'Se déconnecter',
      onclick: deconnecter,
    }, icone('deconnexion')));
}

const initiales = (nom) => String(nom || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join('');

/**
 * Le bouton « Nouvelle activité », flottant et toujours la (§23, §38).
 *
 * Il ouvre le formulaire par-dessus l'ecran courant, sans naviguer : on
 * enregistre une activite depuis la ou l'on est, et l'on y reste.
 */
function construireBoutonFlottant() {
  if (!etat.peut('activity.create')) return;

  const bouton = h('button', {
    type: 'button',
    class: 'bouton principal bouton-nouvelle-activite',
    onclick: async () => {
      const { ouvrirFormulaireActivite } = await import('./vues/activite-formulaire.js');
      const creee = await ouvrirFormulaireActivite();
      if (creee) {
        succes('Activité enregistrée', creee.prestation);
        await router();
      }
    },
  }, icone('plus', 20), h('span', {}, 'Nouvelle activité'));

  document.body.append(bouton);
}

/* ================================================================== */
/*  Theme                                                              */
/* ================================================================== */

/**
 * Le choix de la langue, dans le pied du rail, à côté du thème.
 *
 * Une liste déroulante et non deux boutons : elle tient dans la largeur du
 * rail, et elle s'étendra sans redessiner quoi que ce soit le jour où une
 * troisième langue arrive.
 *
 * Changer de langue recharge la page. C'est assumé : les écrans déjà
 * construits portent des nœuds de texte figés, et les retraduire en place
 * demanderait de retenir la chaîne d'origine de chacun — alourdir chaque
 * rendu de l'application pour un geste qu'on fait deux fois par an.
 */
function construireChoixLangue() {
  const pied = $('.rail-pied');
  if (!pied) return;

  const select = h('select', {
    class: 'rail-langue',
    'aria-label': 'Langue',
    onchange: (e) => definirLangue(e.target.value),
    // Le nom d'une langue s'ecrit TOUJOURS dans cette langue : « الدارجة »
    // ne se traduit pas en francais, ni l'inverse.
  }, ...LANGUES.map((l) => h('option', { value: l.code }, donnee(l.nom))));
  select.value = langue();

  // Le thème et la langue partagent une ligne : les deux règlent
  // l'affichage, et se cherchent au même endroit.
  const boutonTheme = $('#bouton-theme');
  const ligne = h('div', { class: 'rail-affichage' });
  boutonTheme.replaceWith(ligne);
  ligne.append(boutonTheme, select);
}

function appliquerTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
}

function basculerTheme() {
  const suivant = { auto: 'clair', clair: 'sombre', sombre: 'auto' };
  appliquerTheme(suivant[document.documentElement.dataset.theme] || 'auto');
}

/* ================================================================== */
/*  Connexion                                                          */
/* ================================================================== */

function montrerConnexion(parametres) {
  const identifiant = saisie({ name: 'username', autocomplete: 'username', required: true, autofocus: true });
  const motDePasse = saisie({ type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const avis = h('p', { class: 'ligne-note', role: 'alert' });
  const valider = h('button', { type: 'submit', class: 'bouton principal pleine-largeur' }, 'Se connecter');

  const formulaire = h('form', {
    class: 'connexion-formulaire',
    onsubmit: async (e) => {
      e.preventDefault();
      valider.disabled = true;
      fill(avis, '');
      try {
        const session = await api.post('/api/auth/login', {
          username: identifiant.value.trim(),
          password: motDePasse.value,
        });
        document.body.classList.remove('page-connexion');
        await ouvrirApplication({ ...session, authenticated: true });
      } catch (err) {
        fill(avis, err?.message || 'Connexion impossible.');
        motDePasse.value = '';
        motDePasse.focus();
      } finally {
        valider.disabled = false;
      }
    },
  },
  h('h1', {}, 'Gestion de flotte'),
  h('p', { class: 'connexion-recit' },
    'Vos véhicules, ce qu’ils coûtent, ce qu’ils rapportent, et ce qui arrive à échéance.'),
  champ('Identifiant', identifiant),
  champ('Mot de passe', motDePasse),
  avis,
  valider,
  parametres?.passwordMinLength
    ? h('small', { class: 'ligne-note' },
      'Mot de passe de ' + parametres.passwordMinLength + ' caractères minimum. ' +
      'Le compte se verrouille après ' + parametres.loginMaxAttempts + ' échecs.')
    : null);

  document.body.classList.add('page-connexion');
  $('#ecran-demarrage').hidden = true;
  $('#application').hidden = false;
  $('#rail').hidden = true;
  fill($('#contenu'), h('div', { class: 'connexion-boite' }, formulaire));
}

/** Le changement impose a la premiere connexion : rien d'autre ne s'ouvre. */
function montrerChangementMotDePasse() {
  const ancien = saisie({ type: 'password', autocomplete: 'current-password', required: true });
  const nouveau = saisie({ type: 'password', autocomplete: 'new-password', required: true });
  const confirmation = saisie({ type: 'password', autocomplete: 'new-password', required: true });
  const avis = h('p', { class: 'ligne-note', role: 'alert' });
  const min = etat.parametres?.passwordMinLength ?? 12;

  const formulaire = h('form', {
    class: 'connexion-formulaire',
    onsubmit: async (e) => {
      e.preventDefault();
      fill(avis, '');
      if (nouveau.value !== confirmation.value) {
        fill(avis, 'Les deux saisies du nouveau mot de passe diffèrent.');
        return;
      }
      if (nouveau.value.length < min) {
        fill(avis, 'Le nouveau mot de passe doit faire au moins ' + min + ' caractères.');
        return;
      }
      try {
        await api.post('/api/auth/password', {
          currentPassword: ancien.value,
          newPassword: nouveau.value,
        });
        location.reload();
      } catch (err) {
        fill(avis, err?.message || 'Changement impossible.');
      }
    },
  },
  h('h1', {}, 'Choisissez un mot de passe'),
  h('p', { class: 'connexion-recit' },
    'Celui qui vous a été remis est provisoire : il a été affiché une fois, à quelqu’un d’autre.'),
  champ('Mot de passe actuel', ancien),
  champ('Nouveau mot de passe', nouveau, { aide: min + ' caractères minimum' }),
  champ('Confirmation', confirmation),
  avis,
  h('button', { type: 'submit', class: 'bouton principal pleine-largeur' }, 'Enregistrer'));

  document.body.classList.add('page-connexion');
  $('#ecran-demarrage').hidden = true;
  $('#application').hidden = false;
  $('#rail').hidden = true;
  fill($('#contenu'), h('div', { class: 'connexion-boite' }, formulaire));
}

async function deconnecter() {
  try {
    await api.post('/api/auth/logout', {});
  } catch {
    // Deconnexion locale quoi qu'il arrive : rester connecte parce que le
    // serveur n'a pas repondu serait le pire des deux mondes.
  }
  location.reload();
}

demarrer();
