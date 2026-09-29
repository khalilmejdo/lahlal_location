/**
 * La recette d'intégration : l'application entière, par HTTP, sur une vraie
 * base PostgreSQL.
 *
 * Elle suit les critères d'acceptation du §47 dans l'ordre où quelqu'un les
 * vivrait : créer un véhicule, enregistrer une activité, poser une échéance,
 * la voir passer au rouge, la clôturer, filtrer, exporter. Puis ce que le
 * §41 demande de vérifier en plus : les pièces jointes et la sécurité.
 *
 * Tout passe par le réseau. Une suite qui appellerait les fonctions de
 * l'intérieur ne dirait rien des permissions, du jeton CSRF, ni du contrôle
 * d'origine — c'est-à-dire de la moitié de ce qui protège l'application.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { monterApplication, pngFactice } from './aide.js';

let app;
let admin;
let vehiculeId;

before(async () => {
  app = await monterApplication({ port: 8199 });
  admin = await app.connexion('essai', 'MotDePasseEssai2026!', { nouveau: 'RecetteFlotte2026!' });
}, { timeout: 90000 });

after(async () => { await app?.arreter(); }, { timeout: 30000 });

/* ================================================================== */

describe('§47 — Véhicule', () => {
  test('créer un véhicule, voir son kilométrage', async () => {
    const r = await admin.appel('POST', '/api/vehicules', {
      immatriculation: '1234-A-56',
      libelle: 'Renault Master',
      marque: 'Renault',
      modele: 'Master',
      annee: 2019,
      kilometrageInitial: 150000,
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    vehiculeId = r.donnees.vehicule.id;
    assert.equal(r.donnees.vehicule.nom, 'Renault Master');
    assert.equal(r.donnees.vehicule.kilometrage, 150000);
    assert.equal(r.donnees.vehicule.niveau, 'NORMAL', 'sans échéance, rien ne presse');
  });

  test('la même immatriculation écrite autrement est refusée', async () => {
    // « 1234-A-56 » et « 1234 A 56 » sont le même camion : deux fiches
    // couperaient son historique en deux.
    const r = await admin.appel('POST', '/api/vehicules', { immatriculation: '1234 a 56' });
    assert.equal(r.statut, 409);
    assert.match(r.donnees.error.message, /1234-A-56/);
  });

  test('une immatriculation vide est refusée', async () => {
    const r = await admin.appel('POST', '/api/vehicules', { immatriculation: '' });
    // 422 et non 400 : la requete est bien formee, c'est le champ qui ne
    // vaut rien. La distinction est celle du socle, et l'ecran s'en sert
    // pour afficher l'erreur A COTE du champ plutot qu'en banniere.
    assert.equal(r.statut, 422);
  });
});

/* ================================================================== */

describe('§47 — Activité', () => {
  let activiteId;

  test('dépense 50, recette 250 : le résultat est +200', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId,
      date: dateDuJour(),
      typeCode: 'REMORQUAGE',
      prestation: 'Remorquage Cannes vers Nice',
      kilometrage: 152300,
      depenseCents: 5000,
      recetteCents: 25000,
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    activiteId = r.donnees.activite.id;
    assert.equal(r.donnees.activite.resultatCents, 20000);
  });

  test('le compteur du véhicule suit l’activité, sans recalcul', async () => {
    const r = await admin.appel('GET', '/api/vehicules/' + vehiculeId);
    assert.equal(r.donnees.vehicule.kilometrage, 152300);
  });

  test('modifier l’activité corrige le compteur du véhicule', async () => {
    // C'est le §28 : « recalculer le kilométrage actuel ». Il n'y a rien à
    // recalculer, la vue le relit — mais encore faut-il le vérifier.
    await admin.appel('PATCH', '/api/activites/' + activiteId, {
      kilometrage: 153000, confirmerKilometrage: true,
    });
    const r = await admin.appel('GET', '/api/vehicules/' + vehiculeId);
    assert.equal(r.donnees.vehicule.kilometrage, 153000);

    await admin.appel('PATCH', '/api/activites/' + activiteId, {
      kilometrage: 152300, confirmerKilometrage: true,
    });
  });

  test('la corbeille fait reculer le compteur, la restauration le rend', async () => {
    const creee = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'LOCATION',
      prestation: 'Location a supprimer', kilometrage: 158000, recetteCents: 50000,
    });
    const id = creee.donnees.activite.id;

    let v = await admin.appel('GET', '/api/vehicules/' + vehiculeId);
    assert.equal(v.donnees.vehicule.kilometrage, 158000);

    const suppression = await admin.appel('DELETE', '/api/activites/' + id, {
      motif: 'Saisie faite sur le mauvais vehicule',
    });
    assert.equal(suppression.statut, 200);

    v = await admin.appel('GET', '/api/vehicules/' + vehiculeId);
    assert.equal(v.donnees.vehicule.kilometrage, 152300, 'le compteur revient au relevé précédent');

    await admin.appel('POST', '/api/activites/' + id + '/restaurer', {});
    v = await admin.appel('GET', '/api/vehicules/' + vehiculeId);
    assert.equal(v.donnees.vehicule.kilometrage, 158000);

    await admin.appel('DELETE', '/api/activites/' + id, { motif: 'Nettoyage de la recette' });
  });

  test('une suppression sans motif est refusée', async () => {
    const r = await admin.appel('DELETE', '/api/activites/' + activiteId, {});
    assert.equal(r.statut, 422);
  });

  test('un montant négatif est refusé', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'AUTRE',
      prestation: 'Essai', depenseCents: -1,
    });
    assert.equal(r.statut, 422);
  });

  test('une date dans le futur est refusée', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: '2099-01-01', typeCode: 'AUTRE', prestation: 'Essai',
    });
    assert.equal(r.statut, 400);
  });

  test('un type inconnu est refusé', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'NEXISTE_PAS', prestation: 'Essai',
    });
    assert.equal(r.statut, 400);
  });

  test('un véhicule archivé n’accepte plus d’activité', async () => {
    const cree = await admin.appel('POST', '/api/vehicules', { immatriculation: 'ZZ-99-ZZ' });
    const id = cree.donnees.vehicule.id;
    await admin.appel('POST', '/api/vehicules/' + id + '/archiver', { motif: 'Vendu en septembre' });

    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId: id, date: dateDuJour(), typeCode: 'AUTRE', prestation: 'Essai',
    });
    assert.equal(r.statut, 409);
    assert.match(r.donnees.error.message, /archiv/i);
  });
});

/* ================================================================== */

describe('§4 — Cohérence du kilométrage', () => {
  test('un recul demande confirmation, il n’est pas refusé sèchement', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'DEPANNAGE',
      prestation: 'Depannage', kilometrage: 149000, recetteCents: 18000,
    });
    assert.equal(r.statut, 409);
    assert.equal(r.donnees.error.code, 'KILOMETRAGE_RECUL');
    assert.match(r.donnees.error.message, /152 300/);
    assert.match(r.donnees.error.message, /149 000/);
  });

  test('confirmé, il passe, et l’activité garde la trace du forçage', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'DEPANNAGE',
      prestation: 'Depannage confirme', kilometrage: 149000, recetteCents: 18000,
      confirmerKilometrage: true,
    });
    assert.equal(r.statut, 201);
    assert.equal(r.donnees.activite.kilometrageForce, true);
  });

  test('une saisie rétroactive cohérente ne dit rien', async () => {
    // Le piège que la comparaison au seul dernier relevé aurait tendu : une
    // intervention du mois dernier a forcément un kilométrage inférieur.
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: ilYADesJours(45), typeCode: 'CARBURANT',
      prestation: 'Plein du mois dernier', kilometrage: 148000, depenseCents: 35000,
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    assert.equal(r.donnees.activite.kilometrageForce, false);
  });

  test('un bond aberrant demande confirmation lui aussi', async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'AUTRE',
      prestation: 'Faute de frappe', kilometrage: 1523000,
    });
    assert.equal(r.statut, 409);
    assert.equal(r.donnees.error.code, 'KILOMETRAGE_SAUT');
  });
});

/* ================================================================== */

describe('Perte réseau : le double envoi (§32, usage mobile)', () => {
  test('la même clé d’idempotence ne crée qu’une activité', async () => {
    const corps = {
      vehiculeId, date: dateDuJour(), typeCode: 'CARBURANT',
      prestation: 'Plein station', depenseCents: 40000,
      idempotencyKey: 'reseau-instable-42',
    };
    const un = await admin.appel('POST', '/api/activites', corps);
    const deux = await admin.appel('POST', '/api/activites', corps);

    assert.equal(un.statut, 201);
    assert.equal(deux.statut, 200, 'le rejeu répond, sans créer');
    assert.equal(deux.donnees.rejeu, true);
    assert.equal(deux.donnees.activite.id, un.donnees.activite.id);

    const liste = await admin.appel('GET', '/api/activites?q=Plein%20station');
    assert.equal(liste.donnees.totaux.nb, 1);
  });
});

/* ================================================================== */

describe('§47 — Entretien et échéances', () => {
  let vidangeId;

  test('vidange à 162 300 km : « 10 000 km restants »', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'VIDANGE', libelle: 'Vidange',
      dernierKm: 152300, prochainKm: 162300,
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    vidangeId = r.donnees.entretien.id;
    assert.equal(r.donnees.entretien.etat.km.texte, '10 000 km restants');
    assert.equal(r.donnees.entretien.etat.niveau, 'NORMAL');
  });

  test('§11 : l’intervalle propose, la saisie l’emporte', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'REVISION', libelle: 'Revision',
      dernierKm: 150000, intervalleKm: 10000, prochainKm: 158000,
    });
    assert.equal(r.statut, 201);
    assert.equal(r.donnees.entretien.prochainKm, 158000, 'et non 160 000');
  });

  test('§12 : une échéance de date saisie s’applique telle quelle', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'ASSURANCE', libelle: 'Assurance',
      derniereDate: '2026-09-15', prochaineDate: '2027-09-15',
    });
    assert.equal(r.statut, 201);
    assert.equal(String(r.donnees.entretien.prochaineDate).slice(0, 10), '2027-09-15');
    assert.match(r.donnees.entretien.etat.date.texte, /jours restants/);
  });

  test('une échéance qui ne surveille rien est refusée', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'AUTRE', libelle: 'Sans echeance',
    });
    assert.equal(r.statut, 400);
    assert.match(r.donnees.error.message, /surveille rien/);
  });

  test('une prochaine échéance antérieure à la dernière réalisation est refusée', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'PNEUS', libelle: 'Pneus',
      dernierKm: 150000, prochainKm: 140000,
    });
    assert.equal(r.statut, 400);
  });

  test('§47 : atteindre 162 300 km met la vidange au rouge', async () => {
    await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'LOCATION',
      prestation: 'Location 3 jours', kilometrage: 162300, recetteCents: 90000,
      confirmerKilometrage: true,
    });
    const r = await admin.appel('GET', '/api/entretiens/' + vidangeId);
    assert.equal(r.donnees.entretien.etat.niveau, 'DEPASSE');
    assert.equal(r.donnees.entretien.etat.km.texte, 'Échéance atteinte');
  });

  test('§34 : « entretien effectué » enregistre la dépense ET reporte l’échéance', async () => {
    const r = await admin.appel('POST', '/api/entretiens/' + vidangeId + '/effectue', {
      date: dateDuJour(), kilometrage: 162300, coutCents: 18000,
      notes: 'Garage central', prochainKm: 172300,
    });
    assert.equal(r.statut, 200, JSON.stringify(r.donnees));
    assert.equal(r.donnees.entretien.prochainKm, 172300);
    assert.equal(r.donnees.entretien.etat.niveau, 'NORMAL', 'l’alerte est levée');

    // L'activité correspondante existe, avec son coût : c'est elle qui fait
    // que l'entretien apparaît dans les comptes du véhicule.
    const activites = await admin.appel('GET', '/api/activites?q=Vidange');
    assert.equal(activites.donnees.totaux.nb, 1);
    assert.equal(activites.donnees.activites[0].depenseCents, 18000);
    assert.equal(activites.donnees.activites[0].entretienId, vidangeId);
  });

  test('une prochaine échéance déjà dépassée à la clôture est refusée', async () => {
    const r = await admin.appel('POST', '/api/entretiens/' + vidangeId + '/effectue', {
      date: dateDuJour(), kilometrage: 165000, prochainKm: 160000,
    });
    assert.equal(r.statut, 400);
    assert.match(r.donnees.error.message, /dépassée aussitôt/);
  });

  test('sans intervalle ni échéance saisie, la clôture demande une décision', async () => {
    const cree = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'FREINS', libelle: 'Freins', prochainKm: 200000,
    });
    const id = cree.donnees.entretien.id;
    const r = await admin.appel('POST', '/api/entretiens/' + id + '/effectue', {
      date: dateDuJour(), kilometrage: 162400,
    });
    assert.equal(r.statut, 400);
    assert.equal(r.donnees.error.code, 'ECHEANCE_INDETERMINEE');

    // Avec la décision explicite, elle passe.
    const clos = await admin.appel('POST', '/api/entretiens/' + id + '/effectue', {
      date: dateDuJour(), kilometrage: 162400, clore: true,
    });
    assert.equal(clos.statut, 200);
    assert.equal(clos.donnees.entretien.statut, 'CLOS');
  });

  test('une échéance déjà réalisée ne se supprime pas, elle se clôture', async () => {
    const r = await admin.appel('DELETE', '/api/entretiens/' + vidangeId, {
      motif: 'Essai de suppression',
    });
    assert.equal(r.statut, 409);
    assert.match(r.donnees.error.message, /historique/);
  });
});

/* ================================================================== */

describe('§15 — Les seuils sont configurables', () => {
  test('relever le seuil d’attention change le niveau affiché', async () => {
    // La révision est à 158 000 km, le véhicule à 162 300 : elle est déjà
    // dépassée. On prend plutôt une échéance lointaine et l'on rapproche le
    // seuil pour la faire passer en attention.
    const cree = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'DISTRIBUTION', libelle: 'Distribution',
      prochainKm: 172300, // 10 000 km au-dessus du compteur
    });
    const id = cree.donnees.entretien.id;
    assert.equal(cree.donnees.entretien.etat.niveau, 'NORMAL');

    const avant = await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 20000 });
    assert.equal(avant.statut, 200);

    const apres = await admin.appel('GET', '/api/entretiens/' + id);
    assert.equal(apres.donnees.entretien.etat.niveau, 'ATTENTION',
      'le nouveau seuil s’applique sans redémarrage');

    await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 2000 });
  });

  test('une valeur hors bornes est refusée', async () => {
    const r = await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 999999 });
    assert.equal(r.statut, 422);
  });

  test('un paramètre inconnu est refusé', async () => {
    const r = await admin.appel('PATCH', '/api/reglages/alerte.invente', { valeur: 10 });
    assert.equal(r.statut, 404);
  });
});

/* ================================================================== */

describe('§41 — Pièces jointes', () => {
  let activiteId;

  before(async () => {
    const r = await admin.appel('POST', '/api/activites', {
      vehiculeId, date: dateDuJour(), typeCode: 'AUTRE',
      prestation: 'Activite portant des pieces',
    });
    activiteId = r.donnees.activite.id;
  });

  const envoyer = (fichiers, entite = 'activite', id = null) => {
    const form = new FormData();
    form.append('entity', entite);
    form.append('entityId', id ?? activiteId);
    for (const [nom, contenu, type] of fichiers) {
      form.append('fichier', new Blob([contenu], { type }), nom);
    }
    return admin.appel('POST', '/api/fichiers', form);
  };

  test('un PNG valide est accepté', async () => {
    const r = await envoyer([['compteur.png', pngFactice(), 'image/png']]);
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    assert.equal(r.donnees.pieces.length, 1);
    assert.equal(r.donnees.pieces[0].mime, 'image/png');
    assert.equal(r.donnees.pieces[0].previsualisable, true);
  });

  test('plusieurs pièces en un envoi', async () => {
    const r = await envoyer([
      ['facture.png', pngFactice(), 'image/png'],
      ['huile.png', pngFactice(), 'image/png'],
    ]);
    assert.equal(r.statut, 201);
    assert.equal(r.donnees.pieces.length, 2);
  });

  test('un format interdit est refusé, quel que soit son nom', async () => {
    // Un exécutable renommé « .png » et annoncé « image/png » : les deux
    // mensonges portent sur ce que le serveur NE regarde pas.
    const exe = Buffer.alloc(64);
    Buffer.from([0x4d, 0x5a, 0x90, 0x00]).copy(exe, 0);
    const r = await envoyer([['innocent.png', exe, 'image/png']]);
    assert.equal(r.statut, 415);
  });

  test('un envoi mixte est rejeté en entier, pas à moitié', async () => {
    const avant = await admin.appel('GET', '/api/fichiers?entity=activite&entityId=' + activiteId);
    const nAvant = avant.donnees.pieces.length;

    const exe = Buffer.alloc(64);
    Buffer.from([0x4d, 0x5a]).copy(exe, 0);
    const r = await envoyer([
      ['bonne.png', pngFactice(), 'image/png'],
      ['mauvaise.png', exe, 'image/png'],
    ]);
    assert.equal(r.statut, 415);

    const apres = await admin.appel('GET', '/api/fichiers?entity=activite&entityId=' + activiteId);
    assert.equal(apres.donnees.pieces.length, nAvant, 'rien n’a été écrit');
  });

  test('un fichier trop volumineux est refusé', async () => {
    const enorme = pngFactice(11 * 1024 * 1024);
    const r = await envoyer([['enorme.png', enorme, 'image/png']]);
    assert.ok([413, 400].includes(r.statut), 'statut ' + r.statut);
  });

  test('la restitution force le téléchargement et interdit le reniflage', async () => {
    const liste = await admin.appel('GET', '/api/fichiers?entity=activite&entityId=' + activiteId);
    const id = liste.donnees.pieces[0].id;
    const r = await admin.appel('GET', '/api/fichiers/' + id);
    assert.equal(r.statut, 200);
    assert.equal(r.entetes.get('x-content-type-options'), 'nosniff');
    assert.match(r.entetes.get('content-disposition') || '', /attachment/);
  });

  test('une entité inconnue est refusée', async () => {
    const form = new FormData();
    form.append('entity', 'facture');
    form.append('entityId', activiteId);
    form.append('fichier', new Blob([pngFactice()], { type: 'image/png' }), 'x.png');
    const r = await admin.appel('POST', '/api/fichiers', form);
    assert.equal(r.statut, 422, 'entite hors de la liste blanche');
  });

  test('une pièce rattachée à une activité qui n’existe pas est refusée', async () => {
    const r = await envoyer([['x.png', pngFactice(), 'image/png']], 'activite',
      '00000000-0000-7000-8000-000000000000');
    assert.equal(r.statut, 404);
  });
});

/* ================================================================== */

describe('§41 — Sécurité', () => {
  test('sans authentification, rien ne se lit', async () => {
    for (const chemin of ['/api/activites', '/api/vehicules', '/api/tableau-de-bord',
      '/api/statistiques', '/api/audit', '/api/utilisateurs']) {
      const r = await app.appelAnonyme('GET', chemin);
      assert.equal(r.statut, 401, chemin + ' répond ' + r.statut);
    }
  });

  test('une écriture sans jeton CSRF est refusée', async () => {
    const r = await admin.appel('POST', '/api/vehicules', { immatriculation: 'AA-11-BB' },
      { entetes: { 'X-CSRF-Token': '' } });
    assert.equal(r.statut, 403);
  });

  test('une écriture depuis une origine étrangère est refusée', async () => {
    const r = await admin.appel('POST', '/api/vehicules', { immatriculation: 'AA-22-BB' },
      { entetes: { Origin: 'https://mechant.example' } });
    assert.equal(r.statut, 403);
  });

  test('un identifiant mal formé rend 400, pas 500', async () => {
    const r = await admin.appel('GET', '/api/vehicules/pas-un-uuid');
    assert.equal(r.statut, 400);
  });

  test('un véhicule inexistant rend 404', async () => {
    const r = await admin.appel('GET', '/api/vehicules/00000000-0000-7000-8000-000000000000');
    assert.equal(r.statut, 404);
  });

  describe('un compte sans droits n’accède à rien de ce qui ne le regarde pas', () => {
    let lecteur;

    before(async () => {
      const roles = await admin.appel('GET', '/api/utilisateurs/roles');
      const lecture = roles.donnees.roles.find((r) => r.code === 'LECTURE');

      const cree = await admin.appel('POST', '/api/utilisateurs', {
        username: 'observateur', fullName: 'Observateur', roleId: lecture.id,
      });
      assert.equal(cree.statut, 201, JSON.stringify(cree.donnees));

      // Le nouveau mot de passe ne doit pas contenir l'identifiant : la
      // politique du socle le refuse, et elle a raison.
      lecteur = await app.connexion('observateur', cree.donnees.motDePasseProvisoire,
        { nouveau: 'LectureSeule2026!' });
    });

    test('il lit les véhicules', async () => {
      const r = await lecteur.appel('GET', '/api/vehicules');
      assert.equal(r.statut, 200);
    });

    test('il ne crée pas de véhicule', async () => {
      const r = await lecteur.appel('POST', '/api/vehicules', { immatriculation: 'BB-33-CC' });
      assert.equal(r.statut, 403);
    });

    test('il n’enregistre pas d’activité', async () => {
      const r = await lecteur.appel('POST', '/api/activites', {
        vehiculeId, date: dateDuJour(), typeCode: 'AUTRE', prestation: 'Essai',
      });
      assert.equal(r.statut, 403);
    });

    test('il ne lit ni les comptes, ni le journal, ni les paramètres', async () => {
      for (const chemin of ['/api/utilisateurs', '/api/audit', '/api/reglages']) {
        const r = await lecteur.appel('GET', chemin);
        assert.equal(r.statut, 403, chemin + ' répond ' + r.statut);
      }
    });

    test('il ne modifie aucun seuil', async () => {
      const r = await lecteur.appel('PATCH', '/api/reglages/alerte.km_urgent', { valeur: 100 });
      assert.equal(r.statut, 403);
    });

    test('il ne joint aucune pièce', async () => {
      const form = new FormData();
      form.append('entity', 'vehicule');
      form.append('entityId', vehiculeId);
      form.append('fichier', new Blob([pngFactice()], { type: 'image/png' }), 'x.png');
      const r = await lecteur.appel('POST', '/api/fichiers', form);
      assert.equal(r.statut, 403);
    });

    test('son refus laisse une trace dans le journal', async () => {
      // C'est ce qu'un contrôle cherche : non pas ce qui a marché, mais qui
      // a tenté ce qu'il n'avait pas le droit de faire.
      await new Promise((r) => setTimeout(r, 400));
      const journal = await admin.appel('GET', '/api/audit?action=acces.refuse');
      assert.ok(journal.donnees.entrees.length > 0, 'aucun refus tracé');
      assert.match(journal.donnees.entrees[0].resume, /refusé/i);
    });
  });
});

/* ================================================================== */

describe('§19 et §21 — Filtres et exports', () => {
  test('les filtres se combinent', async () => {
    const r = await admin.appel('GET',
      '/api/activites?vehicule=' + vehiculeId + '&sens=DEPENSE&du=' + ilYADesJours(60) + '&au=' + dateDuJour());
    assert.equal(r.statut, 200);
    assert.ok(r.donnees.totaux.nb > 0);
    // Le filtre « avec dépense » ne doit ramener que des lignes qui en ont une.
    for (const a of r.donnees.activites) assert.ok(a.depenseCents > 0, a.prestation);
  });

  test('les totaux portent sur le filtre entier, pas sur la page', async () => {
    const page = await admin.appel('GET', '/api/activites?limit=1');
    assert.equal(page.donnees.activites.length, 1);
    assert.ok(page.donnees.totaux.nb > 1, 'le total compte toutes les lignes du filtre');
  });

  test('la recherche textuelle trouve une prestation', async () => {
    const r = await admin.appel('GET', '/api/activites?q=Nice');
    assert.equal(r.donnees.totaux.nb, 1);
  });

  test('une période inversée est refusée en statistiques', async () => {
    const r = await admin.appel('GET', '/api/statistiques?du=2026-12-31&au=2026-01-01');
    assert.equal(r.statut, 400);
  });

  test('le classeur Excel se télécharge', async () => {
    const r = await admin.appel('GET', '/api/exports/activites.xlsx');
    assert.equal(r.statut, 200);
    assert.match(r.entetes.get('content-type') || '', /spreadsheet/);
    assert.ok(r.donnees.byteLength > 1000);
    // Un .xlsx est une archive ZIP : ses deux premiers octets sont « PK ».
    const debut = Buffer.from(r.donnees.slice(0, 2));
    assert.equal(debut.toString('ascii'), 'PK');
  });

  test('le CSV se télécharge', async () => {
    const r = await admin.appel('GET', '/api/exports/activites.csv');
    assert.equal(r.statut, 200);
    assert.match(r.entetes.get('content-type') || '', /csv/);
  });

  test('l’état imprimable d’un véhicule est du HTML lisible', async () => {
    const r = await admin.appel('GET', '/api/exports/vehicule/' + vehiculeId);
    assert.equal(r.statut, 200);
    const html = Buffer.from(r.donnees).toString('utf8');
    assert.match(html, /Renault Master/);
    assert.match(html, /non déclarée/, 'la mention du §7 doit figurer sur le document');
  });
});

/* ================================================================== */

describe('§16 — Tableau de bord', () => {
  test('un seul appel rend la flotte, les chiffres, les alertes et l’historique', async () => {
    const r = await admin.appel('GET', '/api/tableau-de-bord');
    assert.equal(r.statut, 200);
    const d = r.donnees;
    assert.ok(d.flotte.nbVehicules >= 1);
    assert.ok(Array.isArray(d.flotte.vehicules));
    assert.ok(Array.isArray(d.alertes));
    assert.ok(Array.isArray(d.activitesRecentes));
    assert.equal(typeof d.chiffres.resultatCents, 'number');
    assert.equal(d.chiffres.resultatCents, d.chiffres.recettesCents - d.chiffres.depensesCents);
  });

  test('les alertes sont rendues déjà triées, la plus grave en tête', async () => {
    const r = await admin.appel('GET', '/api/tableau-de-bord');
    const rang = { DEPASSE: 0, URGENT: 1, ATTENTION: 2, NORMAL: 3 };
    const niveaux = r.donnees.alertes.map((a) => rang[a.niveau]);
    const trie = [...niveaux].sort((a, b) => a - b);
    assert.deepEqual(niveaux, trie);
  });
});

/* ================================================================== */

describe('Le journal d’audit', () => {
  test('la chaîne se vérifie', async () => {
    const r = await admin.appel('GET', '/api/audit/verifier');
    assert.equal(r.statut, 200, JSON.stringify(r.donnees));
    assert.equal(r.donnees.valid, true);
    assert.ok(r.donnees.checked > 0);
  });

  test('chaque écriture a laissé une trace lisible', async () => {
    const r = await admin.appel('GET', '/api/audit?entity=activite');
    assert.ok(r.donnees.entrees.length > 0);
    for (const e of r.donnees.entrees.slice(0, 5)) {
      assert.ok(e.resume.length > 10, 'résumé trop court : ' + e.resume);
      assert.ok(e.par, 'entrée sans auteur');
    }
  });

  test('une modification garde l’avant et l’après', async () => {
    const r = await admin.appel('GET', '/api/audit?action=activite.update');
    const avecDiff = r.donnees.entrees.find((e) => e.changements);
    assert.ok(avecDiff, 'aucune modification ne porte de diff');
  });
});

/* ------------------------------------------------------------------ */

function dateDuJour() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function ilYADesJours(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
