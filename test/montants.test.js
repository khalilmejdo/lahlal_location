/**
 * Les montants (§41 : « calcul résultat », « validation des montants »).
 *
 * Deux exigences, et la seconde est la plus importante.
 *
 *   - Le résultat est recette moins dépense, au centime, quel que soit le
 *     nombre de lignes additionnées.
 *   - AUCUNE NOTION FISCALE. Le §7 est explicite. Ce fichier vérifie que le
 *     module ne porte ni taux, ni barème, ni TVA — pas seulement qu'il ne
 *     s'en sert pas aujourd'hui, mais qu'il n'en offre pas la surface à
 *     l'écran suivant.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as money from '../server/core/money.js';

const { parseAmountToCents, formatCents, resultatCents, roundHalfUp, centsToNumber } = money;

/* ------------------------------------------------------------------ */

describe('Lecture d’un montant saisi', () => {
  test('les écritures humaines courantes sont acceptées', () => {
    assert.equal(parseAmountToCents('1035,50'), 103550);
    assert.equal(parseAmountToCents('1035.5'), 103550);
    assert.equal(parseAmountToCents('1 035,50'), 103550);
    assert.equal(parseAmountToCents('1 035,50'), 103550, 'espace fine insécable');
    assert.equal(parseAmountToCents('1 035,50'), 103550, 'espace insécable');
    assert.equal(parseAmountToCents(1035.5), 103550);
    assert.equal(parseAmountToCents('250'), 25000);
    assert.equal(parseAmountToCents('0'), 0);
  });

  test('une saisie illisible rend null, pas zéro', () => {
    // La distinction compte : zéro est un montant, « illisible » n'en est
    // pas un. Les confondre enregistrerait 0,00 DH sans rien dire.
    assert.equal(parseAmountToCents('abc'), null);
    assert.equal(parseAmountToCents('12,34,56'), null);
    assert.equal(parseAmountToCents('-'), null);
    assert.equal(parseAmountToCents('.'), null);
  });

  test('l’absence de valeur rend null', () => {
    assert.equal(parseAmountToCents(''), null);
    assert.equal(parseAmountToCents(null), null);
    assert.equal(parseAmountToCents(undefined), null);
  });

  test('un débordement n’est pas un montant : il se refuse', () => {
    // roundHalfUp(Infinity) rend 0 : sans ce garde-fou, un montant démesuré
    // deviendrait zéro sans un mot.
    assert.equal(parseAmountToCents(Number.MAX_VALUE), null);
    assert.equal(parseAmountToCents(Infinity), null);
    assert.equal(parseAmountToCents(Number.NaN), null);
  });

  test('l’arrondi commercial s’éloigne de zéro', () => {
    assert.equal(roundHalfUp(2.5), 3);
    assert.equal(roundHalfUp(-2.5), -3);
    assert.equal(roundHalfUp(2.4), 2);
  });
});

/* ------------------------------------------------------------------ */

describe('Le résultat d’une activité', () => {
  test('§47 : dépense 50, recette 250, résultat +200', () => {
    assert.equal(resultatCents(25000, 5000), 20000);
    assert.equal(formatCents(20000, { withCurrency: true }), '200,00 DH');
  });

  test('une activité qui ne rapporte rien donne un résultat négatif', () => {
    assert.equal(resultatCents(0, 18000), -18000);
    assert.equal(formatCents(-18000, { withCurrency: true }), '-180,00 DH');
  });

  test('zéro des deux côtés donne zéro, pas null', () => {
    assert.equal(resultatCents(0, 0), 0);
    assert.equal(resultatCents(null, undefined), 0);
  });

  test('mille activités s’additionnent au centime', () => {
    // C'est la raison d'être des entiers de centimes : la même somme en
    // flottants dérive. On la mesure pour que la garantie soit explicite.
    let cumulExact = 0;
    let cumulFlottant = 0;
    for (let i = 0; i < 1000; i += 1) {
      cumulExact += resultatCents(1010, 990);   // +0,20 DH a chaque tour
      cumulFlottant += 10.10 - 9.90;
    }
    assert.equal(cumulExact, 20000, 'exactement 200,00 DH');
    assert.notEqual(cumulFlottant * 100, 20000, 'le calcul en flottants, lui, dérive');
  });
});

/* ------------------------------------------------------------------ */

describe('Affichage', () => {
  test('les milliers sont séparés par une espace fine insécable', () => {
    assert.equal(formatCents(103550), '1 035,50');
    assert.equal(formatCents(100000000), '1 000 000,00');
  });

  test('les centimes sont toujours sur deux chiffres', () => {
    assert.equal(formatCents(5), '0,05');
    assert.equal(formatCents(50), '0,50');
    assert.equal(formatCents(500), '5,00');
  });

  test('le signe précède le nombre, pas le groupe', () => {
    assert.equal(formatCents(-103550), '-1 035,50');
  });

  test('la conversion pour l’export rend un décimal', () => {
    assert.equal(centsToNumber(103550), 1035.5);
    assert.equal(centsToNumber(0), 0);
    assert.equal(centsToNumber(null), 0);
  });
});

/* ------------------------------------------------------------------ */

describe('§7 : aucune notion fiscale dans le module', () => {
  test('le module n’exporte ni taux, ni barème, ni TVA', () => {
    const exportes = Object.keys(money);
    const fiscaux = exportes.filter((n) => /tva|taux|bareme|ht|ttc/i.test(n));
    assert.deepEqual(fiscaux, [],
      'exports à caractère fiscal trouvés : ' + fiscaux.join(', '));
  });

  test('le code source du module ne mentionne aucun taux', () => {
    // Le commentaire d'en-tête explique pourquoi la TVA est absente : on
    // cherche donc du CODE, pas des mots. Une ligne qui n'est pas un
    // commentaire et qui parle de TVA serait une régression.
    const source = fs.readFileSync(new URL('../server/core/money.js', import.meta.url), 'utf8');
    const lignesDeCode = source
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .filter((l) => /\bTVA\b|tauxTva|_bp\b|rateBp/.test(l));
    assert.deepEqual(lignesDeCode, [],
      'lignes de code fiscales : ' + lignesDeCode.join(' | '));
  });

  test('la borne haute d’un montant est déclarée', () => {
    assert.equal(money.MONTANT_MAX_CENTS, 1000000000, 'dix millions de dirhams');
  });
});
