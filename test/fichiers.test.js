/**
 * Les pieces jointes : ce qui est accepte, et ce qui ne l'est pas (§41).
 *
 * La regle sous test tient en une phrase : le type d'un fichier est celui de
 * ses OCTETS, jamais celui de son nom. Chaque cas ci-dessous est une facon
 * de mentir sur un fichier — extension trompeuse, type MIME annonce,
 * en-tete tronque — et doit echouer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detecterType, examiner, nomSur, estPrevisualisable,
  SIGNATURES, MAX_FICHIERS_PAR_ENVOI,
} from '../server/domain/fichiers.js';

/** Fabrique un tampon commencant par ces octets, complete a la longueur voulue. */
const avecEnTete = (octets, longueur = 64) => {
  const b = Buffer.alloc(longueur);
  Buffer.from(octets).copy(b, 0);
  return b;
};

const JPEG = avecEnTete([0xff, 0xd8, 0xff, 0xe0]);
const PNG = avecEnTete([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = avecEnTete([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

const WEBP = (() => {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  return b;
})();

const HEIC = (() => {
  const b = Buffer.alloc(64);
  b.write('ftyp', 4, 'ascii');
  b.write('heic', 8, 'ascii');
  return b;
})();

/* ------------------------------------------------------------------ */

describe('Detection du type reel', () => {
  test('reconnait les cinq formats acceptes', () => {
    assert.equal(detecterType(JPEG)?.mime, 'image/jpeg');
    assert.equal(detecterType(PNG)?.mime, 'image/png');
    assert.equal(detecterType(WEBP)?.mime, 'image/webp');
    assert.equal(detecterType(HEIC)?.mime, 'image/heic');
    assert.equal(detecterType(PDF)?.mime, 'application/pdf');
  });

  test('un exécutable renommé « photo.jpg » est refusé', () => {
    // MZ : l'en-tete d'un binaire Windows.
    const binaire = avecEnTete([0x4d, 0x5a, 0x90, 0x00]);
    assert.equal(detecterType(binaire), null);
    const verdict = examiner({ filename: 'photo.jpg', content: binaire });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'TYPE_REFUSE');
  });

  test('du HTML renommé en image est refusé', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    assert.equal(detecterType(html), null);
    assert.equal(examiner({ filename: 'recu.png', content: html }).ok, false);
  });

  test('un fichier trop court n’est aucun des formats', () => {
    assert.equal(detecterType(Buffer.from([0xff, 0xd8, 0xff])), null);
  });

  test('ce qui n’est pas un tampon n’est pas un fichier', () => {
    assert.equal(detecterType('ffd8ff'), null);
    assert.equal(detecterType(null), null);
  });
});

/* ------------------------------------------------------------------ */

describe('Bornes de taille', () => {
  test('un fichier vide est refusé', () => {
    const v = examiner({ filename: 'vide.jpg', content: Buffer.alloc(0) });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'VIDE');
  });

  test('au-delà de la limite, refusé, et le message donne les deux tailles', () => {
    const gros = Buffer.concat([JPEG, Buffer.alloc(3000)]);
    const v = examiner({ filename: 'grande-photo.jpg', content: gros }, 1024);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'TROP_GROS');
    assert.match(v.motif, /Ko/);
  });

  test('la taille est vérifiée AVANT le type', () => {
    // Inutile d'inspecter cent mégaoctets pour découvrir ensuite qu'ils sont
    // refusés — et un fichier énorme au type inconnu doit dire sa taille,
    // pas son type.
    const gros = Buffer.alloc(5000, 0x41);
    const v = examiner({ filename: 'x.bin', content: gros }, 1024);
    assert.equal(v.code, 'TROP_GROS');
  });

  test('pile à la limite, accepté', () => {
    const v = examiner({ filename: 'p.jpg', content: JPEG }, JPEG.length);
    assert.equal(v.ok, true);
  });
});

/* ------------------------------------------------------------------ */

describe('Le nom du fichier', () => {
  test('l’extension est réécrite d’après le type réel', () => {
    const v = examiner({ filename: 'facture.jpg', content: PDF });
    assert.equal(v.ok, true);
    assert.equal(v.fichier.nom, 'facture.pdf');
    assert.equal(v.fichier.mime, 'application/pdf');
  });

  test('les séparateurs de chemin ne survivent pas', () => {
    // On vérifie les PROPRIÉTÉS exigées, pas une chaîne exacte : ce qui
    // compte est qu'aucun séparateur ne subsiste et que le nom ne commence
    // pas par un point. La forme précise du remplacement peut changer sans
    // que la garantie change.
    for (const brut of ['../../etc/passwd', 'C:\\Windows\\systeme.ini', '/var/log/x.jpg']) {
      const nom = nomSur(brut, 'jpg');
      assert.ok(!nom.includes('/'), brut + ' -> ' + nom);
      assert.ok(!nom.includes('\\'), brut + ' -> ' + nom);
      assert.ok(!nom.startsWith('.'), brut + ' -> ' + nom);
      assert.ok(nom.endsWith('.jpg'), brut + ' -> ' + nom);
    }
  });

  test('l’octet nul et les caractères de contrôle disparaissent', () => {
    // « x.php\0.jpg » a servi mille fois a faire passer un script pour une
    // image ; un retour a la ligne permettrait d'injecter un en-tete HTTP.
    assert.equal(nomSur('x.php\u0000.jpg', 'jpg'), 'x.php.jpg');
    assert.ok(!nomSur('recu\r\nSet-Cookie: a=b', 'jpg').includes('\n'));
  });

  test('un nom vide reçoit un nom utilisable', () => {
    assert.equal(nomSur('', 'jpg'), 'piece-jointe.jpg');
    assert.equal(nomSur('....', 'pdf'), 'piece-jointe.pdf');
  });

  test('un nom très long est borné', () => {
    const nom = nomSur('a'.repeat(400) + '.jpg', 'jpg');
    assert.ok(nom.length <= 84, 'le nom mesure ' + nom.length);
  });
});

/* ------------------------------------------------------------------ */

describe('Prévisualisation (§30)', () => {
  test('les images que le navigateur sait peindre sont prévisualisables', () => {
    assert.equal(estPrevisualisable('image/jpeg'), true);
    assert.equal(estPrevisualisable('image/png'), true);
    assert.equal(estPrevisualisable('image/webp'), true);
  });

  test('le PDF et le HEIC reçoivent l’icône générique', () => {
    // Le HEIC est accepté — c'est le format natif des photos d'iPhone —
    // mais aucun navigateur hors Safari ne sait l'afficher.
    assert.equal(estPrevisualisable('application/pdf'), false);
    assert.equal(estPrevisualisable('image/heic'), false);
  });

  test('un type inconnu n’est pas prévisualisable', () => {
    assert.equal(estPrevisualisable('application/x-msdownload'), false);
  });
});

/* ------------------------------------------------------------------ */

describe('Cohérence du catalogue', () => {
  test('chaque signature déclare tout ce dont la route a besoin', () => {
    for (const s of SIGNATURES) {
      assert.equal(typeof s.mime, 'string');
      assert.match(s.ext, /^[a-z0-9]{2,5}$/);
      assert.equal(typeof s.previsualisable, 'boolean');
      assert.equal(typeof s.test, 'function');
    }
  });

  test('la borne d’envoi est un nombre utilisable', () => {
    assert.ok(MAX_FICHIERS_PAR_ENVOI >= 1 && MAX_FICHIERS_PAR_ENVOI <= 20);
  });

  test('aucun format n’est déclaré deux fois', () => {
    const mimes = SIGNATURES.map((s) => s.mime);
    assert.equal(new Set(mimes).size, mimes.length);
  });
});
