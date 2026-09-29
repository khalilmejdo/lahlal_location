/**
 * Validation declarative des donnees entrantes.
 *
 * Principe : aucun gestionnaire de route ne lit `ctx.body` directement. Il
 * declare un schema, et ne manipule ensuite que le resultat valide et
 * normalise. Ce qui n'est pas declare est ecarte, ce qui interdit qu'un champ
 * inattendu ("status", "total_ttc_cents", "role_id"...) se glisse dans une
 * mise a jour.
 *
 * Les messages sont rediges en francais et destines a l'utilisateur final.
 */
import { ValidationError } from './errors.js';
import { isUuid } from './crypto.js';
import { parseAmountToCents } from './money.js';
import { cleanSpaces, isValidIsoDate } from './text.js';

/* ------------------------------------------------------------------ */
/*  Convertisseurs par type                                            */
/* ------------------------------------------------------------------ */

/**
 * Un entier, et rien d'autre.
 *
 * Number.parseInt() s'arrete au premier caractere qu'il ne comprend pas :
 * « 0x3E8 » valait 0 (un taux de TVA exonere sur une facture qui n'avait
 * rien demande), « 1000abc » valait 1000, « 2030abc » creait l'exercice 2030.
 * Et Number() comprend trop : « 1e2 », « 0x10 », et un TABLEAU — String([100])
 * fait « 100 » — devenaient un montant. Une valeur qui n'est pas un nombre
 * JavaScript doit etre une chaine qui n'ecrit qu'un entier, signe compris.
 */
export function entierStrict(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const texte = value.trim();
  return /^[+-]?\d+$/.test(texte) ? Number(texte) : Number.NaN;
}

const CONVERTERS = {
  string(value, rule) {
    let text = String(value);
    if (rule.trim !== false) text = rule.collapse === false ? text.trim() : cleanSpaces(text);
    if (rule.upper) text = text.toUpperCase();
    if (rule.lower) text = text.toLowerCase();

    if (rule.min !== undefined && text.length < rule.min) {
      return { error: 'Ce champ doit comporter au moins ' + rule.min + ' caracteres.' };
    }
    if (rule.max !== undefined && text.length > rule.max) {
      return { error: 'Ce champ ne peut pas depasser ' + rule.max + ' caracteres.' };
    }
    if (rule.pattern && !rule.pattern.test(text)) {
      return { error: rule.patternMessage || 'Le format saisi n’est pas validé.' };
    }
    return { value: text };
  },

  text(value, rule) {
    // Texte libre multiligne : les sauts de ligne sont conserves.
    const text = String(value).replace(/\r\n/g, '\n').trim();
    // `min` se declare sur ce type comme sur `string`. Il n'etait pas lu : le
    // rabotage ci-dessus fait de « ␣␣␣ » une chaine vide, et « required » ne
    // la voyait pas passer puisqu'il compare AVANT le trim. Un motif de trois
    // espaces etait donc accepte sur les vingt-et-un gestes qui en exigent un
    // — suppression d'un reglement, remboursement, avoir, reouverture,
    // corbeille, restauration de sauvegarde, suppression de compte — et le
    // journal d'audit enregistrait « Motif : » suivi de rien, en severite
    // critique. La seule trace de la raison d'un mouvement d'argent etait
    // videe par l'API, alors que le schema la declarait obligatoire.
    if (rule.min !== undefined && text.length < rule.min) {
      return { error: 'Ce texte doit comporter au moins ' + rule.min + ' caracteres.' };
    }
    if (rule.max !== undefined && text.length > rule.max) {
      return { error: 'Ce texte ne peut pas depasser ' + rule.max + ' caracteres.' };
    }
    return { value: text };
  },

  int(value, rule) {
    const n = entierStrict(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: 'Un nombre entier est attendu.' };
    }
    if (rule.min !== undefined && n < rule.min) {
      return { error: 'La valeur doit être superieure ou egale a ' + rule.min + '.' };
    }
    if (rule.max !== undefined && n > rule.max) {
      return { error: 'La valeur doit être inferieure ou egale a ' + rule.max + '.' };
    }
    return { value: n };
  },

  number(value, rule) {
    // Un tableau ou un objet n'est pas un nombre, meme si sa forme texte en a
    // l'air (voir entierStrict).
    const n = typeof value === 'number' ? value
      : typeof value === 'string' ? Number(value.replace(',', '.').trim()) : Number.NaN;
    if (!Number.isFinite(n)) return { error: 'Un nombre est attendu.' };
    if (rule.min !== undefined && n < rule.min) {
      return { error: 'La valeur doit être superieure ou egale a ' + rule.min + '.' };
    }
    if (rule.max !== undefined && n > rule.max) {
      return { error: 'La valeur doit être inferieure ou egale a ' + rule.max + '.' };
    }
    return { value: n };
  },

  /**
   * Montant deja exprime en centimes.
   *
   * C'est le type a employer partout ou la valeur vient de l'interface :
   * celle-ci convertit la saisie de l'utilisateur avant l'envoi, et l'API
   * ne parle donc qu'en unites canoniques. Reconvertir ici multiplierait
   * le montant par cent.
   */
  cents(value, rule) {
    const n = entierStrict(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: 'Montant invalide : un nombre entier de centimes est attendu.' };
    }
    if (!rule.allowNegative && n < 0) return { error: 'Le montant ne peut pas être negatif.' };
    if (rule.max !== undefined && n > rule.max) {
      return { error: 'Le montant depasse la limite autorisée.' };
    }
    // Au-dela de dix milliards de centimes, on est hors du domaine metier :
    // erreur de saisie ou tentative de debordement.
    if (Math.abs(n) > 1_000_000_000_00) {
      return { error: 'Le montant saisi est hors des limites acceptables.' };
    }
    return { value: n };
  },

  /**
   * Montant saisi sous forme humaine ("1 035,50") -> entier de centimes.
   * Reserve aux rares points d'entree qui recoivent du texte brut, comme
   * une importation de fichier. L'interface, elle, envoie des `cents`.
   */
  amount(value, rule) {
    const cents = parseAmountToCents(value);
    if (cents === null) return { error: 'Montant invalide. Exemple attendu : 1 035,50' };
    if (!rule.allowNegative && cents < 0) return { error: 'Le montant ne peut pas être negatif.' };
    if (rule.max !== undefined && cents > rule.max) {
      return { error: 'Le montant depasse la limite autorisée.' };
    }
    // Garde-fou : au-dela de 10 milliards de centimes, on est hors du domaine
    // metier et probablement face a une erreur de saisie ou a une attaque.
    if (Math.abs(cents) > 1_000_000_000_00) {
      return { error: 'Le montant saisi est hors des limites acceptables.' };
    }
    return { value: cents };
  },

  bool(value) {
    if (typeof value === 'boolean') return { value };
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'oui', 'yes', 'on'].includes(text)) return { value: true };
    if (['0', 'false', 'non', 'no', 'off', ''].includes(text)) return { value: false };
    return { error: 'Valeur booleenne attendue.' };
  },

  uuid(value) {
    const text = String(value).trim();
    if (!isUuid(text)) return { error: 'Identifiant invalide.' };
    return { value: text };
  },

  date(value, rule) {
    const text = String(value).trim().slice(0, 10);
    if (!isValidIsoDate(text)) return { error: 'Date invalide. Format attendu : AAAA-MM-JJ' };
    if (rule.min && text < rule.min) return { error: 'La date ne peut pas être anterieure au ' + rule.min + '.' };
    if (rule.max && text > rule.max) return { error: 'La date ne peut pas être posterieure au ' + rule.max + '.' };
    // Classe 23 : une date peut etre future sans l'etre au point de trahir une
    // faute de frappe (2062 pour 2026). La borne se declare par regle, en jours,
    // avec la meme journee de tolerance de fuseau que notFuture.
    if (rule.maxFuturJours !== undefined) {
      const limite = new Date(Date.now() + (rule.maxFuturJours + 1) * 86400000).toISOString().slice(0, 10);
      if (text > limite) {
        return { error: 'La date ne peut pas être à plus de ' + rule.maxFuturJours + ' jours dans le futur.' };
      }
    }
    if (rule.notFuture) {
      const today = new Date().toISOString().slice(0, 10);
      // Une journee de tolerance couvre les ecarts de fuseau horaire.
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      if (text > tomorrow) return { error: 'La date ne peut pas être dans le futur.' };
      void today;
    }
    return { value: text };
  },

  email(value, rule) {
    const text = String(value).trim().toLowerCase();
    if (text.length > (rule.max ?? 254)) return { error: 'Adresse e-mail trop longue.' };
    // Controle volontairement simple : une validation exhaustive par expression
    // reguliere est une source classique de faux negatifs.
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text)) {
      return { error: 'Adresse e-mail invalide.' };
    }
    return { value: text };
  },

  /*
   * M-D6 : un type « phone » vivait ici, appele par aucune route.
   *
   * Il n'etait pas seulement inutilise : sa regle — six a quinze chiffres,
   * indicatif international facultatif — ne dit pas la meme chose que celle
   * qui s'applique reellement, telephonePlausible() dans routes/meta.js, qui
   * exige DIX chiffres et rend le numero extrait plutot qu'un verdict (O-6).
   * Deux regles concurrentes dont une morte, c'est le motif de B-D8 : celle
   * qui dort finit par etre reprise, et elle est la plus faible des deux.
   *
   * Les champs telephone internes restent volontairement du texte libre : un
   * exploitant y ecrit « 0661 23 45 67 / 0536 68 00 00 », et le contraindre a
   * un numero unique retirerait une facon de travailler qui a cours. C'est la
   * SAISIE PUBLIQUE, celle d'un inconnu, qui est normalisee — et elle l'est.
   */

  enum(value, rule) {
    // « upper » se declare comme sur le type string : sans lui, remplacer un
    // champ texte libre par une enumeration fermee aurait rejete les appels
    // qui envoient la valeur en minuscules, alors qu'ils etaient acceptes.
    let text = String(value).trim();
    if (rule.upper) text = text.toUpperCase();
    if (!rule.values.includes(text)) {
      return { error: 'Valeur attendue parmi : ' + rule.values.join(', ') + '.' };
    }
    return { value: text };
  },

  array(value, rule, path) {
    if (!Array.isArray(value)) return { error: 'Une liste est attendue.' };
    if (rule.min !== undefined && value.length < rule.min) {
      return { error: 'Au moins ' + rule.min + ' element(s) sont requis.' };
    }
    if (rule.max !== undefined && value.length > rule.max) {
      return { error: 'Pas plus de ' + rule.max + ' element(s) sont autorises.' };
    }

    const items = [];
    const errors = {};
    value.forEach((item, index) => {
      if (rule.of && typeof rule.of === 'object' && !rule.of.type) {
        // Schema d'objet
        try {
          items.push(validate(item, rule.of, { path: path + '[' + index + ']' }));
        } catch (err) {
          if (err instanceof ValidationError) Object.assign(errors, err.fields);
          else throw err;
        }
      } else if (rule.of) {
        const res = applyRule(item, rule.of, path + '[' + index + ']');
        // Un item de type 'object' ou 'array' rend { fieldErrors } sur un
        // echec, pas { error } : ne verifier que res.error laissait passer
        // res.value, absent dans ce cas, et poussait un undefined dans le
        // tableau valide au lieu de rejeter la requete.
        if (res.error) errors[path + '[' + index + ']'] = res.error;
        else if (res.fieldErrors) Object.assign(errors, res.fieldErrors);
        else items.push(res.value);
      } else {
        items.push(item);
      }
    });

    if (Object.keys(errors).length) return { fieldErrors: errors };
    return { value: items };
  },

  object(value, rule, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'Un objet est attendu.' };
    }
    if (!rule.of) return { value };
    try {
      return { value: validate(value, rule.of, { path }) };
    } catch (err) {
      if (err instanceof ValidationError) return { fieldErrors: err.fields };
      throw err;
    }
  },

  json(value, rule) {
    // Structure libre, bornee en taille pour ne pas stocker n'importe quoi.
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length > (rule.max ?? 20000)) {
      return { error: 'La structure envoyée est trop volumineuse.' };
    }
    return { value };
  },
};

function applyRule(value, rule, path) {
  const converter = CONVERTERS[rule.type];
  if (!converter) throw new Error('Type de validation inconnu : ' + rule.type + ' (' + path + ')');
  return converter(value, rule, path);
}

/* ------------------------------------------------------------------ */
/*  Validation d'un objet complet                                      */
/* ------------------------------------------------------------------ */

const EMPTY = (v) => v === undefined || v === null || v === '';

/**
 * Valide et normalise un objet selon un schema.
 *
 * @param {object} input
 * @param {Record<string, object>} schema
 * @param {{ path?: string, partial?: boolean }} [opts]
 *        partial : ignore les champs absents (mise a jour partielle)
 * @returns {object} objet ne contenant que les champs declares
 * @throws {ValidationError}
 */
export function validate(input, schema, opts = {}) {
  const { path = '', partial = false } = opts;
  const source = input && typeof input === 'object' ? input : {};

  const output = {};
  const errors = {};

  for (const [field, rule] of Object.entries(schema)) {
    const fieldPath = path ? path + '.' + field : field;
    const raw = source[field];

    if (EMPTY(raw)) {
      if (partial && !(field in source)) continue;

      if (rule.required) {
        errors[fieldPath] = rule.requiredMessage || 'Ce champ est obligatoire.';
        continue;
      }
      if (rule.default !== undefined) {
        output[field] = typeof rule.default === 'function' ? rule.default() : rule.default;
        continue;
      }
      if (rule.nullable !== false) {
        // Une chaine vide est normalisee en null : la base ne stocke pas de
        // valeurs vides ambigues.
        if (field in source) output[field] = null;
        continue;
      }
    }

    const result = applyRule(raw, rule, fieldPath);

    if (result.fieldErrors) {
      Object.assign(errors, result.fieldErrors);
      continue;
    }
    if (result.error) {
      errors[fieldPath] = result.error;
      continue;
    }

    output[field] = result.value;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return output;
}

/** Variante pour les mises a jour partielles (PATCH). */
export function validatePartial(input, schema) {
  return validate(input, schema, { partial: true });
}

/* ------------------------------------------------------------------ */
/*  Regles reutilisables                                               */
/* ------------------------------------------------------------------ */

export const rules = {
  id: { type: 'uuid', required: true },
  optionalId: { type: 'uuid' },
  shortText: (max = 120) => ({ type: 'string', max }),
  requiredText: (max = 120) => ({ type: 'string', required: true, max, min: 1 }),
  notes: { type: 'text', max: 4000 },
  date: { type: 'date', required: true },
  optionalDate: { type: 'date' },
  amount: { type: 'amount', required: true },
  optionalAmount: { type: 'amount' },
  sortOrder: { type: 'int', min: 0, max: 100000, default: 0 },
  // Le kilometrage : toujours facultatif au niveau du type, parce qu'une
  // prime d'assurance reglee au bureau n'en a pas. Trois millions de
  // kilometres est la borne haute d'un vehicule utilitaire, largement.
  kilometrage: { type: 'int', min: 0, max: 3000000 },
  // Un montant, deja converti en centimes par l'ecran. Le plafond vaut dix
  // millions de dirhams : au-dela, c'est une faute de frappe, et la laisser
  // passer fausserait toutes les sommes de la periode sans qu'on le voie.
  montant: { type: 'cents', max: 1000000000, default: 0 },
  // Un code de referentiel : majuscules, chiffres et tiret bas.
  codeType: { type: 'string', required: true, max: 40, min: 2 },
  reason: { type: 'text', max: 500 },
  requiredReason: { type: 'text', required: true, max: 500, min: 3,
    requiredMessage: 'Un motif est obligatoire pour cette opération.' },
};
