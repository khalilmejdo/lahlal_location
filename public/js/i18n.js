/**
 * Traduction de l'interface, sans tiers.
 *
 * Le premier réflexe serait le widget de Google Traduction. Il est exclu
 * pour deux raisons qui ne se négocient pas : la politique de sécurité du
 * contenu interdit tout script d'une autre origine, et le widget enverrait
 * chez un tiers le contenu de chaque page — immatriculations, montants,
 * noms de clients. Traduire l'interface ne doit pas exporter les données
 * qu'elle affiche.
 *
 * COMMENT ÇA MARCHE, ET POURQUOI AUCUN ÉCRAN N'EST RÉÉCRIT
 *
 * Tout le texte de l'application passe par `h()` et `fill()` : chaque
 * chaîne y devient un nœud de texte, sans exception, puisque rien n'est
 * inséré via innerHTML. Il suffit donc d'intercepter la création de ces
 * nœuds. Le dictionnaire est indexé par la chaîne FRANÇAISE elle-même : pas
 * de clés à inventer, et une chaîne ajoutée demain reste lisible en
 * français tant que personne ne l'a traduite — jamais vide, jamais
 * « MISSING_KEY ».
 *
 * LE PIÈGE, ET SON GARDE-FOU
 *
 * Cette interception traduit TOUT ce qui passe, y compris ce que
 * l'utilisateur a écrit. Une prestation nommée « Vidange » deviendrait
 * « تبديل الزيت » sur l'écran de celui qui relit sa propre saisie. C'est un
 * défaut connu du socle (O-3 de lahlal_samuplus), et la parade est
 * `donnee()` : elle rend un nœud de texte que l'interception laisse passer
 * intact. Toute donnée affichée doit y passer.
 *
 * LA DARIJA, EN CARACTÈRES ARABES
 *
 * C'est la langue parlée, écrite comme elle s'écrit au Maroc — pas de
 * l'arabe standard. « الطوموبيل » et non « المركبة », « الفيدانج » et non
 * « تغيير الزيت ». Les mots empruntés au français le restent : c'est ainsi
 * qu'on les dit sur le terrain.
 */

/* ------------------------------------------------------------------ */
/*  Langues                                                            */
/* ------------------------------------------------------------------ */

export const LANGUES = [
  { code: 'fr', nom: 'Français', sens: 'ltr' },
  // « ary » est le code ISO 639-3 de l'arabe marocain. Pas « ar », qui
  // désigne l'arabe standard : un navigateur réglé en arabe standard ne
  // doit pas recevoir de la darija sans l'avoir demandé.
  { code: 'ary', nom: 'الدارجة', sens: 'rtl' },
];

const CLE_LANGUE = 'flotte:langue';

let courante = 'fr';

/** Langue en vigueur. */
export const langue = () => courante;

/** Sens d'écriture de la langue en vigueur. */
export const sensEcriture = () => LANGUES.find((l) => l.code === courante)?.sens || 'ltr';

/**
 * Applique une langue.
 *
 * Le document porte `lang` et `dir` : c'est de là que le navigateur tire la
 * coupure des mots, l'alignement par défaut et le sens des listes. Poser
 * seulement une classe CSS donnerait de la darija alignée à gauche,
 * illisible.
 *
 * Le rechargement est assumé. Les écrans déjà construits portent des nœuds
 * de texte figés ; les retraduire en place demanderait de retenir, pour
 * chaque nœud, la chaîne d'origine — donc d'alourdir chaque rendu de
 * l'application pour un geste qu'on fait deux fois par an.
 */
export function definirLangue(code, { recharger = true } = {}) {
  courante = LANGUES.some((l) => l.code === code) ? code : 'fr';
  try {
    localStorage.setItem(CLE_LANGUE, courante);
  } catch {
    // Navigation privée : la langue vaudra pour cette session seulement.
  }
  appliquerAuDocument();
  if (recharger) window.location.reload();
}

/** Le choix enregistré, ou le français. */
export function langueRetenue() {
  let enregistree = null;
  try {
    enregistree = localStorage.getItem(CLE_LANGUE);
  } catch {
    // Stockage indisponible.
  }
  return LANGUES.some((l) => l.code === enregistree) ? enregistree : 'fr';
}

/** Pose la langue au démarrage, avant tout rendu. */
export function initLangue() {
  courante = langueRetenue();
  appliquerAuDocument();
  return courante;
}

function appliquerAuDocument() {
  const racine = document.documentElement;
  if (!racine) return;
  racine.setAttribute('lang', courante);
  racine.setAttribute('dir', sensEcriture());
}

/* ------------------------------------------------------------------ */
/*  Traduction                                                         */
/* ------------------------------------------------------------------ */

/**
 * Traduit une chaîne, ou la rend telle quelle.
 *
 * L'absence de traduction n'est pas une erreur : c'est l'état normal d'une
 * chaîne ajoutée récemment. Elle s'affiche alors en français, ce qui reste
 * compréhensible — à l'inverse d'une clé technique ou d'un vide.
 */
export function t(texte) {
  if (courante === 'fr') return texte;

  const dictionnaire = DICTIONNAIRES[courante];
  if (!dictionnaire) return texte;

  const brut = String(texte ?? '');
  const direct = dictionnaire[brut];
  if (direct !== undefined) return direct;

  // Les espaces de bordure sont fréquents dans les compositions (« · », les
  // séparateurs) : les ignorer évite de dupliquer chaque entrée.
  const ajuste = brut.trim();
  if (ajuste !== brut && dictionnaire[ajuste] !== undefined) {
    return brut.replace(ajuste, dictionnaire[ajuste]);
  }

  return texte;
}

/**
 * Chaînes rencontrées et non traduites, pour compléter le dictionnaire.
 *
 * Rien n'est envoyé nulle part : la liste se lit dans la console du
 * navigateur, par `window.chainesManquantes()`. C'est le moyen le plus
 * court de savoir ce qui reste à faire, sans relire vingt fichiers de vues.
 */
const manquantes = new Set();

export function noterManquante(texte) {
  if (courante === 'fr') return;

  const original = String(texte ?? '');
  const brut = original.trim();

  // Les nombres, les montants et les dates ne se traduisent pas : les noter
  // noierait la liste sous du bruit.
  if (!brut || brut.length < 2 || /^[\d\s.,:/()%+·—–-]+$/.test(brut)) return;

  // Ce qui porte déjà des caractères arabes est traduit — ou composé à
  // partir de morceaux qui le sont, comme « شتنبر 26 ». Le signaler
  // enverrait chercher une entrée qui n'a pas lieu d'être.
  if (/[؀-ۿ]/.test(brut)) return;

  // La recherche se fait sur les DEUX formes, exactement comme t() : une
  // entrée écrite avec ses espaces de bordure — « Recettes : » — couvre
  // bien la chaîne, et ne doit pas être réclamée une seconde fois.
  const dictionnaire = DICTIONNAIRES[courante];
  if (dictionnaire?.[original] !== undefined || dictionnaire?.[brut] !== undefined) return;

  manquantes.add(brut);
}

export const chainesManquantes = () => [...manquantes].sort();

/* ------------------------------------------------------------------ */
/*  Dictionnaire — darija marocaine                                    */
/* ------------------------------------------------------------------ */

const ARY = {
  /* --- Navigation et ossature --- */
  'Tableau de bord': 'لوحة القيادة',
  Accueil: 'الرئيسية',
  'Véhicules': 'الطوموبيلات',
  'Activités': 'الخدمات',
  Entretiens: 'الصيانة',
  'Échéances': 'الآجال',
  'Entretiens et échéances': 'الصيانة والآجال',
  Statistiques: 'الإحصائيات',
  'Paramètres': 'الإعدادات',
  Comptes: 'الحسابات',
  'Journal': 'السجل',
  'Journal d’audit': 'سجل العمليات',
  Plus: 'زيد',
  'Gestion de flotte': 'تدبير الطوموبيلات',
  'Thème': 'الشكل',
  'Se déconnecter': 'خرج',
  'Aller au contenu principal': 'سير للمحتوى',
  'Navigation principale': 'التنقل',
  'Afficher le menu': 'وري القائمة',
  'Chargement…': 'كايشارجي...',
  'Chargement de l’application…': 'التطبيق كايشارجي...',

  /* --- Gestes courants --- */
  Enregistrer: 'سجّل',
  Annuler: 'ألغي',
  Fermer: 'سد',
  Confirmer: 'أكّد',
  Modifier: 'بدّل',
  Supprimer: 'مسح',
  Ajouter: 'زيد',
  Rechercher: 'قلّب',
  'Rechercher…': 'قلّب...',
  'Réessayer': 'عاود',
  'Tout voir': 'شوف الكل',
  'Précédent': 'اللي قبل',
  Suivant: 'اللي من بعد',
  Exporter: 'صدّر',
  Excel: 'إكسل',
  Corbeille: 'المهملات',
  Restaurer: 'رجّع',
  Archiver: 'أرشيف',
  'Réactiver': 'رجّعو خدّام',
  'J’ai noté': 'كتبتو',
  Copier: 'نسخ',
  'Copié': 'تنسخ',
  Droits: 'الحقوق',
  'Détail': 'التفاصيل',
  'État imprimable': 'ورقة للطبع',
  'Imprimer / enregistrer en PDF': 'طبع ولا سجّل PDF',
  'Vérifier la chaîne': 'تحقق من السلسلة',

  /* --- Le tableau de bord --- */
  'Échéances à traiter': 'آجال خاصها تتدار',
  'à surveiller': 'خاص تعسّو',
  'Dépassées': 'فات وقتها',
  Urgentes: 'مستعجلة',
  'À surveiller': 'عسّ عليها',
  'Sous contrôle': 'كلشي مزيان',
  'Recettes du mois': 'المداخيل ديال الشهر',
  'Dépenses du mois': 'المصاريف ديال الشهر',
  'Résultat': 'النتيجة',
  Recettes: 'المداخيل',
  'Dépenses': 'المصاريف',
  'Dernières activités': 'آخر الخدمات',
  'Activité récente': 'آخر الخدمات',
  'Aucune échéance suivie.': 'ماكاين حتى أجل متتبّع.',
  'Aucune échéance suivie. Ajoutez-en depuis la fiche d’un véhicule.':
    'ماكاين حتى أجل متتبّع. زيدو من ورقة الطوموبيل.',
  'Rien d’enregistré pour l’instant. Le bouton « Nouvelle activité » est en bas à droite.':
    'ماكاين والو دابا. زر « خدمة جديدة » كاين تحت على اليمين.',
  'Aucun véhicule. Commencez par en créer un : tout le reste s’y rattache.':
    'ماكاين حتى طوموبيل. بدا بواحدة : كلشي كايمشي معاها.',
  'Créer un véhicule': 'زيد طوموبيل',
  'Créer le premier véhicule': 'زيد أول طوموبيل',

  /* --- Les niveaux d'alerte --- */
  Normal: 'عادي',
  Attention: 'رد بالك',
  Urgent: 'مستعجل',
  'Dépassé': 'فات وقتو',
  'Toutes gravités': 'كل الدرجات',
  'Tous les états': 'كل الحالات',

  /* --- Véhicules --- */
  'Nouveau véhicule': 'طوموبيل جديدة',
  'Modifier le véhicule': 'بدّل الطوموبيل',
  Immatriculation: 'اللوحة',
  'Nom d’usage': 'السمية',
  Marque: 'الماركة',
  'Modèle': 'الموديل',
  'Année': 'العام',
  Statut: 'الحالة',
  Notes: 'ملاحظات',
  Note: 'ملاحظة',
  Compteur: 'الكونتور',
  'Kilométrage': 'الكيلوميتراج',
  'Kilométrage au compteur': 'الكيلوميتراج فالكونتور',
  Parcourus: 'اللي تقطعو',
  'Kilomètres': 'الكيلوميترات',
  Disponible: 'خدّامة',
  'En service': 'فالخدمة',
  'En maintenance': 'فالصيانة',
  'Immobilisé': 'واقفة',
  Vendu: 'تباعت',
  'Afficher les archivés': 'وري المؤرشفين',
  'Archivé': 'مؤرشف',
  'Immatriculation, marque, modèle…': 'اللوحة، الماركة، الموديل...',
  'Documents du véhicule': 'وثائق الطوموبيل',
  'Aucun véhicule.': 'ماكاين حتى طوموبيل.',

  /* --- Activités --- */
  'Nouvelle activité': 'خدمة جديدة',
  'Modifier l’activité': 'بدّل الخدمة',
  'Type d’activité': 'نوع الخدمة',
  Type: 'النوع',
  Prestation: 'الخدمة اللي تدارت',
  Date: 'التاريخ',
  'Dépense (DH)': 'المصروف (درهم)',
  'Recette (DH)': 'المدخول (درهم)',
  'Coût (DH)': 'الثمن (درهم)',
  'Dépense': 'المصروف',
  Recette: 'المدخول',
  'Pièces': 'الوثائق',
  Actions: 'العمليات',
  'Tous les véhicules': 'كل الطوموبيلات',
  'Tous les types': 'كل الأنواع',
  'Tous les montants': 'كل المبالغ',
  'Avec dépense': 'فيها مصروف',
  'Avec recette': 'فيها مدخول',
  'Résultat positif': 'النتيجة إيجابية',
  'Résultat négatif': 'النتيجة سلبية',
  'Aujourd’hui': 'اليوم',
  'Cette semaine': 'هاد السيمانة',
  '7 derniers jours': 'آخر 7 أيام',
  'Ce mois': 'هاد الشهر',
  'Mois précédent': 'الشهر اللي فات',
  'Cette année': 'هاد العام',
  Tout: 'الكل',
  Du: 'من',
  Au: 'إلى',
  'Prestation, note, immatriculation…': 'الخدمة، ملاحظة، اللوحة...',
  Montants: 'المبالغ',
  'Aucune activité sur cette sélection.': 'ماكاين حتى خدمة فهاد الاختيار.',
  'La corbeille est vide.': 'المهملات خاوية.',
  'Facultatif. Sans rien, le type sert de libellé.':
    'ماشي إجباري. إلا خليتيه خاوي، غادي يتكتب نوع الخدمة.',
  'Ce que vous avez fait': 'شنو دّرتي',
  'Montant payé': 'شحال خلّصتي',
  'Montant encaissé': 'شحال دّيتي',
  'Ajouter une note': 'زيد ملاحظة',
  'Recette moins dépense. Activité non déclarée : aucune TVA n’est appliquée.':
    'المدخول ناقص المصروف. هاد الخدمة ماشي مصرّح بيها : ماكاين حتى TVA.',
  'Activité non déclarée : montants réellement engagés et perçus, sans TVA.':
    'خدمة ماشي مصرّح بيها : المبالغ اللي تخلصو وتدّاو بصح، بلا TVA.',
  'Véhicule, ce que vous avez fait, ce que cela a coûté et rapporté.':
    'الطوموبيل، شنو دّرتي، شحال كلّفك وشحال جابلك.',
  'Mettre à la corbeille': 'دّيه للمهملات',
  'Mettre à la corbeille ?': 'نديه للمهملات؟',
  'Kilométrage à confirmer': 'الكيلوميتراج خاصو تأكيد',
  'Confirmer ce kilométrage': 'أكّد هاد الكيلوميتراج',
  'kilométrage confirmé manuellement': 'الكيلوميتراج تأكد باليد',

  /* --- Entretiens --- */
  'Nouvelle échéance': 'أجل جديد',
  'Modifier l’échéance': 'بدّل الأجل',
  'Échéance': 'الأجل',
  'Effectué': 'تدار',
  'Libellé': 'السمية',
  'Dernière réalisation': 'آخر مرة تدارت',
  'Date de réalisation': 'تاريخ اللي تدارت فيه',
  'Intervalle habituel': 'كل شحال',
  'Tous les… (km)': 'كل... (كم)',
  'Tous les… (mois)': 'كل... (شهر)',
  'Prochaine échéance': 'الأجل الجاي',
  'Au kilométrage': 'فالكيلوميتراج',
  'À la date': 'فالتاريخ',
  'Ne pas reconduire : clôturer cette échéance': 'ماتعاودش : سد هاد الأجل',
  'Garage, pièces changées…': 'الݣاراج، القطع اللي تبدلو...',
  'Facture, photos (facultatif)': 'الفاكتورة، تصاور (ماشي إجباري)',
  Suivies: 'متتبّعة',
  Closes: 'مسدودة',
  Suivi: 'التتبع',
  'Laissez vide pour appliquer l’intervalle. Une valeur saisie ici est respectée telle quelle.':
    'خليه خاوي باش يتحسب بوحدو. إلا كتبتي شي حاجة، غادي تتحسب هي.',
  'Un kilométrage, une date, ou les deux : l’alerte se déclenche dès que l’une arrive.':
    'كيلوميتراج، ولا تاريخ، ولا بجوج : التنبيه كايخرج أول ما يوصل واحد فيهم.',
  'La dépense est enregistrée comme activité du véhicule, et l’échéance est reportée.':
    'المصروف كايتسجل كخدمة ديال الطوموبيل، والأجل كايتأجل.',
  'Ce qui arrive à échéance, au kilométrage ou à la date.':
    'اللي قرب يوصل أجلو، بالكيلوميتراج ولا بالتاريخ.',

  /* --- Pièces jointes --- */
  'Photos et justificatifs': 'التصاور والوثائق',
  'Pièces jointes': 'الوثائق',
  'Prendre une photo': 'صوّر',
  'Prendre une autre photo': 'صوّر وحدة أخرى',
  'Choisir un fichier': 'ختار ملف',
  'Ajouter un fichier': 'زيد ملف',
  'Ajouter une photo': 'زيد تصويرة',
  'Aucune pièce jointe.': 'ماكاين حتى وثيقة.',
  'Aucune pièce. Vous pouvez enregistrer sans.': 'ماكاين حتى وثيقة. تقدر تسجل بلاها.',
  'Supprimer cette pièce ?': 'نمسح هاد الوثيقة؟',

  /* --- Statistiques --- */
  'Par véhicule': 'حسب الطوموبيل',
  'Par type d’activité': 'حسب نوع الخدمة',
  'Mois par mois': 'شهر بشهر',
  'Semaine par semaine': 'سيمانة بسيمانة',
  'Détail par véhicule': 'التفاصيل حسب الطوموبيل',
  'Découpage': 'التقسيم',
  'Par mois': 'حسب الشهر',
  'Par semaine': 'حسب السيمانة',
  'Ce que la flotte a coûté et rapporté, par véhicule et par type.':
    'شحال كلفو الطوموبيلات وشحال جابو، حسب كل وحدة وكل نوع.',
  'Aucune activité sur cette période.': 'ماكاين حتى خدمة فهاد المدة.',

  /* --- Paramètres --- */
  'Seuils d’alerte': 'حدود التنبيه',
  'Sécurité': 'الأمان',
  Types: 'الأنواع',
  'Nouveau type': 'نوع جديد',
  'Modifier le type': 'بدّل النوع',
  'Types d’activité': 'أنواع الخدمات',
  'Types d’entretien': 'أنواع الصيانة',
  Code: 'الكود',
  'Ordre d’affichage': 'ترتيب العرض',
  'Oriente vers': 'كايوجه ل',
  'Oriente la saisie vers': 'كايوجه الكتابة ل',
  Usages: 'الاستعمالات',
  Actif: 'خدّام',
  'Désactivé': 'مطفي',
  'Désactiver': 'طفّيه',
  'Ce qui s’applique aujourd’hui': 'اللي خدّام دابا',
  'Les seuils d’alerte et les listes de types, réglables sans redéploiement.':
    'حدود التنبيه ولوائح الأنواع، كايتبدلو بلا ما تعاود تنستالي.',

  /* --- Comptes --- */
  'Nouveau compte': 'حساب جديد',
  Identifiant: 'المعرف',
  'Nom complet': 'الاسم الكامل',
  'Nom': 'الاسم',
  'Rôle': 'الدور',
  'Rôles': 'الأدوار',
  Rang: 'الرتبة',
  'Mot de passe': 'كلمة السر',
  'Mot de passe actuel': 'كلمة السر ديالك دابا',
  'Nouveau mot de passe': 'كلمة السر الجديدة',
  Confirmation: 'التأكيد',
  'Mot de passe provisoire': 'كلمة سر مؤقتة',
  'Adresse électronique': 'الإيميل',
  'Téléphone': 'التيليفون',
  'Compte actif': 'الحساب خدّام',
  'Dernière connexion': 'آخر دخول',
  jamais: 'عمرو',
  'État': 'الحالة',
  'Se connecter': 'دخل',
  'Choisissez un mot de passe': 'ختار كلمة السر',
  'Mot de passe à changer': 'خاصك تبدل كلمة السر',
  'Vos véhicules, ce qu’ils coûtent, ce qu’ils rapportent, et ce qui arrive à échéance.':
    'الطوموبيلات ديالك، شحال كايكلفو، شحال كايجيبو، وشنو قرب يوصل أجلو.',

  /* --- Journal --- */
  'Qui a changé quoi, quand, et pourquoi. Ce journal ne se modifie pas.':
    'شكون بدّل شنو، إمتى، وعلاش. هاد السجل ماكايتبدلش.',
  'Toutes les entités': 'كل العناصر',
  Critique: 'خطير',
  Avertissement: 'تنبيه',
  Notable: 'مهم',
  Information: 'معلومة',

  /* --- Messages --- */
  'Aucune ligne.': 'ماكاين حتى سطر.',
  'Vous n’avez pas accès à cet écran.': 'ماعندكش الحق تشوف هاد الشاشة.',
  'Cette adresse n’existe pas.': 'هاد العنوان ماكاينش.',
  'Cet écran n’a pas pu être affiché.': 'هاد الشاشة ماتقدرش تتعرض.',
  'Le serveur ne répond pas.': 'السيرفور ماكايجاوبش.',
  'Opération impossible': 'ماتقدرش هاد العملية',
  'Enregistrement impossible': 'ماتسجلش',
  'Enregistrement impossible.': 'ماتسجلش.',
  'Aucune modification demandée.': 'ماطلبتي حتى تبديل.',
  'Session expirée': 'الجلسة سالات',
  'Motif (obligatoire, au moins 3 caractères)': 'السبب (إجباري، على الأقل 3 حروف)',
  'Le motif doit comporter au moins trois caractères.': 'السبب خاصو على الأقل 3 حروف.',

  /* --- Morceaux de phrases composées --- */
  // Les compositions ne peuvent pas être des clés : « Lignes 1 à 5 sur 5 »
  // change à chaque page. Les écrans les découpent, et ce sont les
  // morceaux qui figurent ici.
  Lignes: 'سطور',
  'Entrées': 'مدخلات',
  sur: 'من',
  Du: 'من',
  au: 'إلى',
  Entre: 'بين',
  et: 'و',
  'Dernier relevé connu : ': 'آخر كيلوميتراج معروف : ',
  'Aucun relevé connu pour ce véhicule.': 'ماكاين حتى كيلوميتراج معروف لهاد الطوموبيل.',
  ' · compteur ': ' · الكونتور ',
  ' · dernière fois le ': ' · آخر مرة ف ',
  'Depuis le ': 'من ',
  'Pas d’échéance exploitable.': 'ماكاين أجل صالح للحساب.',

  /* --- Les mois, pour le graphique --- */
  'janv.': 'يناير',
  'févr.': 'فبراير',
  mars: 'مارس',
  'avr.': 'أبريل',
  mai: 'ماي',
  juin: 'يونيو',
  'juil.': 'يوليوز',
  'août': 'غشت',
  'sept.': 'شتنبر',
  'oct.': 'أكتوبر',
  'nov.': 'نونبر',
  'déc.': 'دجنبر',
  S: 'س',

  /* --- Paramètres : les trois lignes du résumé --- */
  'Attention à partir de': 'رد بالك من',
  'Urgent en dessous de': 'مستعجل أقل من',
  'Recul du compteur toléré': 'تراجع الكونتور المسموح',
  Normales: 'عادية',

  /* --- Divers --- */
  'Véhicule': 'الطوموبيل',
  Langue: 'اللغة',
  'Français': 'الفرنسية',
  'Ouvrir la fiche du véhicule': 'حل ورقة الطوموبيل',
  'Voir le détail': 'شوف التفاصيل',
  'Précision utile (facultatif)': 'شي توضيح (ماشي إجباري)',
  'aucun champ': 'حتى خانة',
  'la dépense': 'المصروف',
  'la recette': 'المدخول',
  tous: 'الكل',
  'Trier par date': 'رتّب بالتاريخ',
  'Trier par véhicule': 'رتّب بالطوموبيل',
  'Trier par type': 'رتّب بالنوع',
  'Trier par prestation': 'رتّب بالخدمة',
  'Trier par kilométrage': 'رتّب بالكيلوميتراج',
  'Trier par dépense': 'رتّب بالمصروف',
  'Trier par recette': 'رتّب بالمدخول',
  'Trier par résultat': 'رتّب بالنتيجة',

  /* --- Le compte à rebours, composé à l'écran (§14, §36) --- */
  // Les nombres sont posés à part, entre ces morceaux : « 1 250 » +
  // « km restants ». C'est ce qui permet de les traduire sans toucher aux
  // chiffres, qui se lisent de gauche à droite même en darija.
  restants: 'باقي',
  'Dépassée de': 'فات ب',
  'Échéance atteinte': 'وصل الأجل',
  'Échéance aujourd’hui': 'الأجل اليوم',
  'jours restants': 'يوم باقي',
  '1 jour restant': 'يوم واحد باقي',
  'Échue depuis 1 jour': 'فات من نهار',
  'Échue depuis': 'فات من',
  jours: 'أيام',
  'véhicule': 'طوموبيل',
  'véhicules': 'طوموبيلات',

  /* --- Étiquettes des infobulles du graphique --- */
  'Recettes : ': 'المداخيل : ',
  'Dépenses : ': 'المصاريف : ',
  'Résultat : ': 'النتيجة : ',

  /* --- Textes explicatifs des écrans --- */
  'À partir de quelle distance ou de quel délai une échéance change de couleur. Ils s’appliquent immédiatement, sans redémarrage.':
    'من شحال من كيلوميتر ولا شحال من نهار الأجل كايبدل اللون. كايخدمو دغيا، بلا ما تعاود تشعل التطبيق.',
  'Réservé au super-administrateur. Ces valeurs ferment l’application : les desserrer a un coût.':
    'خاص بالمدير العام. هاد القيم كايسدّو التطبيق : إلا رخّيتيهم غادي تخسر شي حاجة.',
  'Les permissions disent ce qu’on peut faire ; le rang dit sur qui. Un compte n’agit que sur un rang strictement inférieur au sien.':
    'الصلاحيات كايقولو شنو تقدر دير ؛ الرتبة كاتقول على شكون. الحساب كايخدم غير على رتبة قل من ديالو.',
};

export const DICTIONNAIRES = { ary: ARY };
