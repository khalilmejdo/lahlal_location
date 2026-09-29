/**
 * Les echeances : compte a rebours, niveaux d'alerte, propositions.
 *
 * Ce fichier exerce les criteres d'acceptation du §47 tels qu'ils sont
 * ecrits, avec leurs chiffres. Tout est pur : ni base, ni serveur, ni date
 * du jour implicite — « aujourd'hui » est toujours passe en argument, sans
 * quoi la suite changerait de verdict selon le jour ou on la lance.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  etatEcheance, niveauPourRestant, lireSeuils, pireNiveau, joursEntre,
  prochaineEcheanceProposee, reculKilometrage, sautKilometrage,
  SEUILS_PAR_DEFAUT, libelleAlerte,
} from '../server/domain/echeances.js';

const S = SEUILS_PAR_DEFAUT;

/* ------------------------------------------------------------------ */

describe('Les seuils du §15', () => {
  test('les valeurs par defaut sont celles du cahier des charges', () => {
    assert.equal(S.kmAttention, 2000);
    assert.equal(S.kmUrgent, 500);
    assert.equal(S.joursAttention, 30);
    assert.equal(S.joursUrgent, 15);
  });

  test('un seuil se regle depuis les parametres', () => {
    const seuils = lireSeuils([{ key: 'alerte.km_attention', value: '5000' }]);
    assert.equal(seuils.kmAttention, 5000);
    // Les autres gardent leur defaut.
    assert.equal(seuils.kmUrgent, 500);
  });

  test('une valeur hors bornes vaut absente, elle ne s’applique pas', () => {
    const seuils = lireSeuils([{ key: 'alerte.km_attention', value: '999999' }]);
    assert.equal(seuils.kmAttention, 2000);
  });

  test('une valeur illisible vaut absente', () => {
    const seuils = lireSeuils([{ key: 'alerte.jours_urgent', value: 'bientot' }]);
    assert.equal(seuils.joursUrgent, 15);
  });

  test('un seuil urgent plus lointain que l’attention est rabattu, pas refuse', () => {
    // Sans cela on passerait au rouge AVANT l'orange, puis on reviendrait a
    // l'orange en se rapprochant : les couleurs s'inverseraient.
    const seuils = lireSeuils([
      { key: 'alerte.km_attention', value: '1000' },
      { key: 'alerte.km_urgent', value: '3000' },
    ]);
    assert.equal(seuils.kmUrgent, 1000);
    assert.equal(seuils.kmAttention, 1000);
  });
});

/* ------------------------------------------------------------------ */

describe('Le niveau d’un axe (§15)', () => {
  const km = { attention: 2000, urgent: 500 };

  test('au-dela de 2 000 km : normal', () => {
    assert.equal(niveauPourRestant(2001, km), 'NORMAL');
    assert.equal(niveauPourRestant(10000, km), 'NORMAL');
  });

  test('de 500 a 2 000 km : attention', () => {
    assert.equal(niveauPourRestant(2000, km), 'ATTENTION');
    assert.equal(niveauPourRestant(1250, km), 'ATTENTION');
    assert.equal(niveauPourRestant(500, km), 'ATTENTION');
  });

  test('sous 500 km : urgent', () => {
    assert.equal(niveauPourRestant(499, km), 'URGENT');
    assert.equal(niveauPourRestant(1, km), 'URGENT');
  });

  test('zero est deja depasse : l’echeance est atteinte, pas proche', () => {
    // §47 : « lorsque le vehicule atteint 162 300 km, l'application doit
    // afficher Vidange a effectuer ». Atteindre, c'est devoir faire.
    assert.equal(niveauPourRestant(0, km), 'DEPASSE');
    assert.equal(niveauPourRestant(-350, km), 'DEPASSE');
  });

  test('le pire de deux niveaux l’emporte', () => {
    assert.equal(pireNiveau('NORMAL', 'URGENT'), 'URGENT');
    assert.equal(pireNiveau('DEPASSE', 'ATTENTION'), 'DEPASSE');
    assert.equal(pireNiveau(), 'NORMAL');
    assert.equal(pireNiveau(null, undefined), 'NORMAL');
  });
});

/* ------------------------------------------------------------------ */

describe('§47 — la vidange, de sa creation a son declenchement', () => {
  const vidange = { libelle: 'Vidange', prochainKm: 162300, prochaineDate: null };

  test('creee a 152 300 km pour 162 300 : « 10 000 km restants »', () => {
    const etat = etatEcheance(vidange, 152300, '2026-09-29', S);
    assert.equal(etat.km.restant, 10000);
    assert.equal(etat.km.texte, '10 000 km restants');
    assert.equal(etat.niveau, 'NORMAL');
    assert.equal(etat.date, null, 'aucune echeance de date sur cette vidange');
  });

  test('a 160 800 km : on entre dans l’attention', () => {
    const etat = etatEcheance(vidange, 160800, '2026-09-29', S);
    assert.equal(etat.km.restant, 1500);
    assert.equal(etat.niveau, 'ATTENTION');
  });

  test('a 162 000 km : urgent, 300 km restants', () => {
    const etat = etatEcheance(vidange, 162000, '2026-09-29', S);
    assert.equal(etat.km.restant, 300);
    assert.equal(etat.niveau, 'URGENT');
  });

  test('a 162 300 km pile : depasse, « Vidange a effectuer »', () => {
    const etat = etatEcheance(vidange, 162300, '2026-09-29', S);
    assert.equal(etat.niveau, 'DEPASSE');
    assert.equal(etat.km.texte, 'Échéance atteinte');
  });

  test('a 162 650 km : « Dépassée de 350 km » (§13)', () => {
    const etat = etatEcheance(vidange, 162650, '2026-09-29', S);
    assert.equal(etat.km.restant, -350);
    assert.equal(etat.km.texte, 'Dépassée de 350 km');
    assert.equal(etat.niveau, 'DEPASSE');
  });
});

/* ------------------------------------------------------------------ */

describe('§47 — l’assurance, echeance de date', () => {
  const assurance = { libelle: 'Assurance', prochainKm: null, prochaineDate: '2027-09-15' };

  test('affiche le nombre de jours restants', () => {
    const etat = etatEcheance(assurance, 152300, '2026-09-29', S);
    assert.equal(etat.date.restant, joursEntre('2026-09-29', '2027-09-15'));
    assert.equal(etat.date.restant, 351);
    assert.equal(etat.date.texte, '351 jours restants');
    assert.equal(etat.niveau, 'NORMAL');
  });

  test('passe en attention a 30 jours puis en urgent sous 15', () => {
    assert.equal(etatEcheance(assurance, 0, '2027-08-16', S).niveau, 'ATTENTION'); // 30 j
    assert.equal(etatEcheance(assurance, 0, '2027-09-05', S).niveau, 'URGENT');    // 10 j
  });

  test('« Échue depuis 3 jours » (§14)', () => {
    const etat = etatEcheance(assurance, 0, '2027-09-18', S);
    assert.equal(etat.date.restant, -3);
    assert.equal(etat.date.texte, 'Échue depuis 3 jours');
    assert.equal(etat.niveau, 'DEPASSE');
  });

  test('le singulier est respecte', () => {
    assert.equal(etatEcheance(assurance, 0, '2027-09-14', S).date.texte, '1 jour restant');
    assert.equal(etatEcheance(assurance, 0, '2027-09-15', S).date.texte, 'Échéance aujourd’hui');
    assert.equal(etatEcheance(assurance, 0, '2027-09-16', S).date.texte, 'Échue depuis 1 jour');
  });
});

/* ------------------------------------------------------------------ */

describe('§9 — les deux axes ensemble', () => {
  const revision = { libelle: 'Révision', prochainKm: 170000, prochaineDate: '2026-12-15' };

  test('les deux sont rendus, et le pire decide du niveau', () => {
    // Kilometrage tranquille (17 700 restants), date urgente (7 jours).
    const etat = etatEcheance(revision, 152300, '2026-12-08', S);
    assert.equal(etat.km.niveau, 'NORMAL');
    assert.equal(etat.date.niveau, 'URGENT');
    assert.equal(etat.niveau, 'URGENT', 'une seule des deux conditions suffit');
    assert.equal(etat.surveille, true);
  });

  test('le compte a rebours affiche les deux valeurs (§36)', () => {
    const etat = etatEcheance(revision, 169500, '2026-12-08', S);
    const ligne = libelleAlerte(revision, etat);
    assert.equal(ligne.titre, 'Révision');
    assert.equal(ligne.detail, '500 km restants · 7 jours restants');
    assert.equal(ligne.niveau, 'URGENT');
  });
});

/* ------------------------------------------------------------------ */

describe('Ce qui n’est pas surveille', () => {
  test('un entretien clos sort des alertes', () => {
    const etat = etatEcheance(
      { libelle: 'Vidange', prochainKm: 100, prochaineDate: null, statut: 'CLOS' },
      200000, '2026-09-29', S,
    );
    assert.equal(etat.surveille, false);
    assert.equal(etat.niveau, 'NORMAL');
    assert.equal(libelleAlerte({ libelle: 'Vidange' }, etat), null);
  });

  test('une echeance kilometrique sans releve n’est pas « normale », elle n’est pas surveillable', () => {
    // Le dire evite de la compter comme saine dans le tableau de bord.
    const etat = etatEcheance({ libelle: 'Vidange', prochainKm: 160000 }, null, '2026-09-29', S);
    assert.equal(etat.surveille, false);
  });

  test('un entretien sans aucune echeance ne surveille rien', () => {
    const etat = etatEcheance({ libelle: 'Autre', prochainKm: null, prochaineDate: null }, 1000, '2026-09-29', S);
    assert.equal(etat.surveille, false);
  });
});

/* ------------------------------------------------------------------ */

describe('§11 et §12 — l’intervalle propose, il n’impose pas', () => {
  test('vidange a 150 000 km, intervalle 10 000 : propose 160 000', () => {
    const p = prochaineEcheanceProposee({ km: 150000, intervalleKm: 10000 });
    assert.equal(p.prochainKm, 160000);
  });

  test('sans intervalle, rien n’est propose : c’est la saisie qui decide', () => {
    const p = prochaineEcheanceProposee({ km: 150000, intervalleKm: null });
    assert.equal(p.prochainKm, null);
  });

  test('une echeance saisie a la main s’applique telle quelle', () => {
    // §11 : l'utilisateur veut 158 000 alors que l'intervalle proposerait
    // 160 000. La proposition existe, la valeur retenue est la sienne.
    const propose = prochaineEcheanceProposee({ km: 150000, intervalleKm: 10000 });
    const saisi = 158000;
    const applique = saisi ?? propose.prochainKm;
    assert.equal(propose.prochainKm, 160000);
    assert.equal(applique, 158000);

    const etat = etatEcheance({ libelle: 'Vidange', prochainKm: applique }, 150000, '2026-09-29', S);
    assert.equal(etat.km.restant, 8000, 'le systeme respecte 158 000, pas 160 000');
  });

  test('intervalle en mois : 15/09/2026 + 12 mois = 15/09/2027', () => {
    const p = prochaineEcheanceProposee({ date: '2026-09-15', intervalleMois: 12 });
    assert.equal(p.prochaineDate, '2027-09-15');
  });

  test('le quantieme est borne en fin de mois : 31/01 + 1 mois = 28/02', () => {
    const p = prochaineEcheanceProposee({ date: '2026-01-31', intervalleMois: 1 });
    assert.equal(p.prochaineDate, '2026-02-28');
  });

  test('une date sans intervalle ne propose rien (§12)', () => {
    const p = prochaineEcheanceProposee({ date: '2026-09-15', intervalleMois: null });
    assert.equal(p.prochaineDate, null);
  });
});

/* ------------------------------------------------------------------ */

describe('§4 — la coherence du kilometrage', () => {
  test('152 300 connu, 149 000 saisi : l’ecart est signale', () => {
    const recul = reculKilometrage(149000, 152300, 0);
    assert.ok(recul, 'un recul doit etre signale');
    assert.equal(recul.ecart, 3300);
    assert.match(recul.message, /152 300 km/);
    assert.match(recul.message, /149 000 km/);
    assert.match(recul.message, /3 300 km de moins/);
  });

  test('une valeur en progression ne dit rien', () => {
    assert.equal(reculKilometrage(153000, 152300, 0), null);
  });

  test('la meme valeur ne dit rien', () => {
    assert.equal(reculKilometrage(152300, 152300, 0), null);
  });

  test('une tolerance reglee laisse passer les petits ecarts', () => {
    assert.equal(reculKilometrage(152290, 152300, 50), null);
    assert.ok(reculKilometrage(152200, 152300, 50));
  });

  test('sans releve anterieur, il n’y a rien a comparer', () => {
    assert.equal(reculKilometrage(149000, null, 0), null);
  });

  test('un bond aberrant est signale lui aussi', () => {
    // 1 523 000 pour 152 300 : un chiffre en trop, et toutes les echeances
    // du vehicule paraitraient depassees d'un coup.
    const saut = sautKilometrage(1523000, 152300);
    assert.ok(saut);
    assert.equal(saut.ecart, 1370700);
    assert.equal(sautKilometrage(155000, 152300), null, 'une progression normale ne dit rien');
  });
});

/* ------------------------------------------------------------------ */

describe('joursEntre', () => {
  test('compte en jours entiers', () => {
    assert.equal(joursEntre('2026-09-29', '2026-09-30'), 1);
    assert.equal(joursEntre('2026-09-30', '2026-09-29'), -1);
    assert.equal(joursEntre('2026-09-29', '2026-09-29'), 0);
  });

  test('traverse un changement d’heure sans se decaler', () => {
    // Fin mars et fin octobre : les deux bascules europeennes. Un calcul en
    // heure locale rendrait ici 30 ou 32 jours.
    assert.equal(joursEntre('2026-03-15', '2026-04-15'), 31);
    assert.equal(joursEntre('2026-10-15', '2026-11-15'), 31);
  });

  test('une date invalide ne rend pas un nombre', () => {
    assert.equal(joursEntre('2026-02-30', '2026-03-01'), null);
    assert.equal(joursEntre('pas une date', '2026-03-01'), null);
  });
});
