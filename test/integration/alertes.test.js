/**
 * Les alertes, éprouvées de bout en bout.
 *
 * `test/echeances.test.js` vérifie déjà le calcul, en fonctions pures et
 * sans base. Ce fichier vérifie autre chose, et c'est ce qui manquait :
 * que la chaîne ENTIÈRE fonctionne — la base rend les bons nombres, le
 * domaine en tire le bon niveau, la route le rend, et le tableau de bord
 * le compte.
 *
 * Un calcul juste sur une valeur qui n'arrive jamais ne protège de rien.
 *
 * Le scénario fait traverser à un véhicule les quatre niveaux, sur les deux
 * axes, en ne touchant qu'aux données réelles : on ajoute des activités
 * pour faire monter le compteur, on pose des échéances à des dates
 * calculées depuis aujourd'hui.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { monterApplication } from './aide.js';

let app;
let admin;
let vehiculeId;

/** Une date à N jours d'aujourd'hui, au format ISO. */
function dans(jours) {
  const d = new Date();
  d.setDate(d.getDate() + jours);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const aujourdhui = () => dans(0);

/** Fait monter le compteur du véhicule en enregistrant une activité. */
async function porterLeCompteurA(km) {
  const r = await admin.appel('POST', '/api/activites', {
    vehiculeId,
    date: aujourdhui(),
    typeCode: 'LOCATION',
    prestation: 'Trajet de recette',
    kilometrage: km,
    recetteCents: 1000,
    confirmerKilometrage: true,
  });
  assert.equal(r.statut, 201, JSON.stringify(r.donnees));
}

/** Le niveau et le détail d'une échéance, relus depuis l'API. */
async function etatDe(entretienId) {
  const r = await admin.appel('GET', '/api/entretiens/' + entretienId);
  assert.equal(r.statut, 200, JSON.stringify(r.donnees));
  return r.donnees.entretien.etat;
}

before(async () => {
  // Un port à part : cette suite peut tourner à côté de l'autre.
  app = await monterApplication({ port: 8201 });
  admin = await app.connexion('essai', 'MotDePasseEssai2026!', { nouveau: 'RecetteFlotte2026!' });

  const v = await admin.appel('POST', '/api/vehicules', {
    immatriculation: 'AL-77-RT',
    libelle: 'Camion des alertes',
    kilometrageInitial: 100000,
  });
  assert.equal(v.statut, 201, JSON.stringify(v.donnees));
  vehiculeId = v.donnees.vehicule.id;
}, { timeout: 90000 });

after(async () => { await app?.arreter(); }, { timeout: 30000 });

/* ================================================================== */

describe('L’axe kilométrique traverse les quatre niveaux', () => {
  let vidangeId;

  test('posée à 2 500 km de distance : normal', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'VIDANGE', libelle: 'Vidange',
      dernierKm: 100000, prochainKm: 102500,
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    vidangeId = r.donnees.entretien.id;

    const etat = await etatDe(vidangeId);
    assert.equal(etat.km.restant, 2500);
    assert.equal(etat.niveau, 'NORMAL');
  });

  test('à 1 900 km : attention', async () => {
    await porterLeCompteurA(100600);
    const etat = await etatDe(vidangeId);
    assert.equal(etat.km.restant, 1900);
    assert.equal(etat.niveau, 'ATTENTION');
  });

  test('à 400 km : urgent', async () => {
    await porterLeCompteurA(102100);
    const etat = await etatDe(vidangeId);
    assert.equal(etat.km.restant, 400);
    assert.equal(etat.niveau, 'URGENT');
  });

  test('pile à l’échéance : dépassé — « atteindre, c’est devoir faire »', async () => {
    await porterLeCompteurA(102500);
    const etat = await etatDe(vidangeId);
    assert.equal(etat.km.restant, 0);
    assert.equal(etat.niveau, 'DEPASSE');
  });

  test('au-delà : dépassé, et de combien', async () => {
    await porterLeCompteurA(102850);
    const etat = await etatDe(vidangeId);
    assert.equal(etat.km.restant, -350);
    assert.equal(etat.niveau, 'DEPASSE');
  });

  test('la clôture lève l’alerte et reporte l’échéance', async () => {
    const r = await admin.appel('POST', '/api/entretiens/' + vidangeId + '/effectue', {
      date: aujourdhui(), kilometrage: 102850, coutCents: 20000, prochainKm: 112850,
    });
    assert.equal(r.statut, 200, JSON.stringify(r.donnees));

    const etat = await etatDe(vidangeId);
    assert.equal(etat.km.restant, 10000);
    assert.equal(etat.niveau, 'NORMAL', 'l’alerte doit retomber');
  });
});

/* ================================================================== */

describe('L’axe des dates traverse les quatre niveaux', () => {
  const poses = {};

  before(async () => {
    const cas = [
      ['normal', dans(60)],
      ['attention', dans(25)],
      ['urgent', dans(5)],
      ['depasse', dans(-3)],
    ];
    for (const [cle, date] of cas) {
      const r = await admin.appel('POST', '/api/entretiens', {
        vehiculeId, typeCode: 'ASSURANCE', libelle: 'Assurance ' + cle,
        prochaineDate: date,
      });
      assert.equal(r.statut, 201, cle + ' : ' + JSON.stringify(r.donnees));
      poses[cle] = r.donnees.entretien.id;
    }
  });

  test('60 jours : normal', async () => {
    const etat = await etatDe(poses.normal);
    assert.equal(etat.date.restant, 60);
    assert.equal(etat.niveau, 'NORMAL');
  });

  test('25 jours : attention', async () => {
    const etat = await etatDe(poses.attention);
    assert.equal(etat.date.restant, 25);
    assert.equal(etat.niveau, 'ATTENTION');
  });

  test('5 jours : urgent', async () => {
    const etat = await etatDe(poses.urgent);
    assert.equal(etat.date.restant, 5);
    assert.equal(etat.niveau, 'URGENT');
  });

  test('échue depuis 3 jours : dépassé', async () => {
    const etat = await etatDe(poses.depasse);
    assert.equal(etat.date.restant, -3);
    assert.equal(etat.niveau, 'DEPASSE');
  });
});

/* ================================================================== */

describe('Les deux axes ensemble : le pire l’emporte (§9)', () => {
  test('kilométrage tranquille, date urgente : urgent', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'REVISION', libelle: 'Révision mixte',
      prochainKm: 200000,        // très loin
      prochaineDate: dans(4),    // tout près
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));

    const etat = await etatDe(r.donnees.entretien.id);
    assert.equal(etat.km.niveau, 'NORMAL');
    assert.equal(etat.date.niveau, 'URGENT');
    assert.equal(etat.niveau, 'URGENT',
      'une seule des deux conditions suffit à déclencher');
  });

  test('date tranquille, kilométrage dépassé : dépassé', async () => {
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'FREINS', libelle: 'Freins mixte',
      prochainKm: 101000,        // déjà franchi
      prochaineDate: dans(200),  // très loin
    });
    const etat = await etatDe(r.donnees.entretien.id);
    assert.equal(etat.date.niveau, 'NORMAL');
    assert.equal(etat.niveau, 'DEPASSE');
  });
});

/* ================================================================== */

describe('Le tableau de bord compte ce qui presse', () => {
  test('les quatre compteurs correspondent aux échéances réelles', async () => {
    const tb = await admin.appel('GET', '/api/tableau-de-bord');
    assert.equal(tb.statut, 200);

    const liste = await admin.appel('GET', '/api/entretiens?statut=ACTIF');
    const attendu = { NORMAL: 0, ATTENTION: 0, URGENT: 0, DEPASSE: 0 };
    for (const e of liste.donnees.entretiens) {
      if (e.etat.surveille) attendu[e.etat.niveau] += 1;
    }

    assert.deepEqual(tb.donnees.compteurs, attendu,
      'le tableau de bord doit compter exactement ce que la liste contient');
  });

  test('les alertes sont rendues triées, la plus grave en tête', async () => {
    const tb = await admin.appel('GET', '/api/tableau-de-bord');
    const rang = { DEPASSE: 0, URGENT: 1, ATTENTION: 2, NORMAL: 3 };
    const niveaux = tb.donnees.alertes.map((a) => rang[a.niveau]);
    assert.deepEqual(niveaux, [...niveaux].sort((a, b) => a - b));
  });

  test('aucune échéance « normale » ne figure parmi les alertes', async () => {
    // Le bloc d'alertes montre ce qui demande une décision. Y mettre ce qui
    // va bien le rendrait illisible, et on cesserait de le regarder.
    const tb = await admin.appel('GET', '/api/tableau-de-bord');
    const normales = tb.donnees.alertes.filter((a) => a.niveau === 'NORMAL');
    assert.deepEqual(normales, []);
  });

  test('chaque alerte porte les nombres, pas seulement la phrase', async () => {
    // C'est à partir d'eux que l'écran écrit le compte à rebours dans la
    // langue de celui qui regarde.
    const tb = await admin.appel('GET', '/api/tableau-de-bord');
    assert.ok(tb.donnees.alertes.length > 0);
    for (const a of tb.donnees.alertes) {
      assert.ok(a.etat, a.libelle + ' : état absent');
      assert.equal(a.etat.surveille, true);
      assert.ok(a.etat.km || a.etat.date, a.libelle + ' : aucun axe exploitable');
    }
  });

  test('le véhicule porte le pire niveau de ses échéances', async () => {
    const r = await admin.appel('GET', '/api/vehicules/' + vehiculeId);
    const pires = r.donnees.vehicule.entretiens
      .filter((e) => e.etat.surveille)
      .map((e) => e.etat.niveau);
    assert.ok(pires.includes('DEPASSE'));
    assert.equal(r.donnees.vehicule.niveau, 'DEPASSE');
  });
});

/* ================================================================== */

describe('Les seuils commandent vraiment les niveaux (§15)', () => {
  let temoinId;

  before(async () => {
    // Une échéance à 1 200 km : normale avec le seuil par défaut (2 000),
    // puisque 1 200 < 2 000 — non : elle est déjà en attention. On la pose
    // donc nettement plus loin, et c'est le seuil qu'on déplace.
    await porterLeCompteurA(103000);
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'DISTRIBUTION', libelle: 'Distribution témoin',
      prochainKm: 108000, // 5 000 km de distance
    });
    assert.equal(r.statut, 201, JSON.stringify(r.donnees));
    temoinId = r.donnees.entretien.id;
  });

  test('à 5 000 km de distance, seuil 2 000 : normal', async () => {
    const etat = await etatDe(temoinId);
    assert.equal(etat.km.restant, 5000);
    assert.equal(etat.niveau, 'NORMAL');
  });

  test('on relève le seuil d’attention à 8 000 : la même échéance passe en attention', async () => {
    const r = await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 8000 });
    assert.equal(r.statut, 200, JSON.stringify(r.donnees));

    const etat = await etatDe(temoinId);
    assert.equal(etat.km.restant, 5000, 'la distance n’a pas bougé');
    assert.equal(etat.niveau, 'ATTENTION', 'c’est le seuil qui a bougé');
  });

  test('on relève l’urgence à 6 000 : elle passe en urgent, sans redémarrage', async () => {
    const r = await admin.appel('PATCH', '/api/reglages/alerte.km_urgent', { valeur: 6000 });
    assert.equal(r.statut, 200);

    const etat = await etatDe(temoinId);
    assert.equal(etat.niveau, 'URGENT');
  });

  test('un seuil urgent plus lointain que l’attention est rabattu, pas accepté tel quel', async () => {
    // Sans ce rabattement, on passerait au rouge AVANT l'orange, puis on
    // reviendrait à l'orange en se rapprochant : les couleurs s’inverseraient.
    await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 3000 });
    const r = await admin.appel('GET', '/api/reglages');
    assert.ok(r.donnees.seuilsAppliques.kmUrgent <= r.donnees.seuilsAppliques.kmAttention,
      'urgent=' + r.donnees.seuilsAppliques.kmUrgent
      + ' attention=' + r.donnees.seuilsAppliques.kmAttention);
  });

  test('une valeur hors bornes ne s’applique pas', async () => {
    const r = await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 999999 });
    assert.equal(r.statut, 422);

    const lu = await admin.appel('GET', '/api/reglages');
    assert.ok(lu.donnees.seuilsAppliques.kmAttention <= 100000);
  });

  after(async () => {
    // On remet les valeurs du cahier des charges.
    await admin.appel('PATCH', '/api/reglages/alerte.km_urgent', { valeur: 500 });
    await admin.appel('PATCH', '/api/reglages/alerte.km_attention', { valeur: 2000 });
  });
});

/* ================================================================== */

describe('Ce qui ne doit PAS déclencher d’alerte', () => {
  test('une échéance close sort des alertes sans sortir de l’historique', async () => {
    const cree = await admin.appel('POST', '/api/entretiens', {
      vehiculeId, typeCode: 'PNEUS', libelle: 'Pneus à clore', prochainKm: 100001,
    });
    const id = cree.donnees.entretien.id;
    assert.equal((await etatDe(id)).niveau, 'DEPASSE');

    const clos = await admin.appel('POST', '/api/entretiens/' + id + '/clore',
      { motif: 'Véhicule changé de pneus hors suivi' });
    assert.equal(clos.statut, 200);

    const etat = await etatDe(id);
    assert.equal(etat.surveille, false, 'une échéance close ne surveille plus');

    // Mais elle reste consultable.
    const liste = await admin.appel('GET', '/api/entretiens?statut=CLOS');
    assert.ok(liste.donnees.entretiens.some((e) => e.id === id));
  });

  test('une échéance kilométrique sur un véhicule sans relevé n’est pas « normale »', async () => {
    // Elle n'est pas saine : elle n'est pas surveillable. Le dire évite de
    // la compter comme une échéance sous contrôle.
    const v = await admin.appel('POST', '/api/vehicules', {
      immatriculation: 'NO-00-KM', libelle: 'Sans relevé', kilometrageInitial: 0,
    });
    const r = await admin.appel('POST', '/api/entretiens', {
      vehiculeId: v.donnees.vehicule.id, typeCode: 'VIDANGE',
      libelle: 'Vidange sans relevé', prochaineDate: dans(90),
    });
    const etat = await etatDe(r.donnees.entretien.id);
    assert.equal(etat.km, null, 'aucun axe kilométrique sans prochain_km');
    assert.equal(etat.niveau, 'NORMAL');
  });

  test('un véhicule archivé disparaît du tableau de bord', async () => {
    const v = await admin.appel('POST', '/api/vehicules', {
      immatriculation: 'AR-11-CH', libelle: 'À archiver', kilometrageInitial: 50000,
    });
    const id = v.donnees.vehicule.id;
    await admin.appel('POST', '/api/entretiens', {
      vehiculeId: id, typeCode: 'ASSURANCE', libelle: 'Assurance échue', prochaineDate: dans(-10),
    });

    let tb = await admin.appel('GET', '/api/tableau-de-bord');
    assert.ok(tb.donnees.alertes.some((a) => a.vehiculeId === id), 'l’alerte doit d’abord exister');

    await admin.appel('POST', '/api/vehicules/' + id + '/archiver', { motif: 'Vendu' });

    tb = await admin.appel('GET', '/api/tableau-de-bord');
    assert.ok(!tb.donnees.alertes.some((a) => a.vehiculeId === id),
      'un véhicule archivé ne doit plus alerter');
    assert.ok(!tb.donnees.flotte.vehicules.some((x) => x.id === id));
  });
});
