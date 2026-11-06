/**
 * Atelier Harmonie's taxonomy, kept as a test fixture.
 *
 * It used to live in the library with a domain check. The pipeline no longer
 * knows this tenant: the taxonomy is stored per project and proposed by the
 * model. These definitions are only used to exercise matching and reporting.
 */
import type { TopicDefinition } from "@/lib/research/topic-taxonomy";

export const ATELIER_TAXONOMY: TopicDefinition[] = [
  {
    slug: "restauration-siege",
    offerKey: "Restauration de siège",
    preferredPages: ["/tapisserie-restauration"],
    name: "Restauration de sièges & tapisserie d'ameublement",
    intent: "commercial",
    relevance: "high",
    coverageKind: "service",
    rationale:
      "Core service: restoring chairs, armchairs and sofas with traditional upholstery, including made-to-measure seating.",
    requireAny: [
      "fauteuil", "fauteuils", "chaise", "chaises", "siege", "sieges", "tapissier", "tapisserie",
      "garnissage", "canape", "retapisser", "tapisser", "monaco", "bridge", "voltaire", "cabriolet",
    ],
    terms: [
      "restauration", "restaurer", "refection", "tapissier", "tapisserie", "garnissage", "fauteuil",
      "fauteuils", "chaise", "chaises", "siege", "sieges", "canape", "retapisser", "tapisser",
      "monaco", "bridge", "voltaire", "cabriolet", "dossier", "assise", "devis",
    ],
    strongTerms: ["tapissier", "tapisserie", "retapisser", "garnissage"],
    coverageRequireAny: ["restauration", "tapisserie", "tapissier", "garnissage"],
    pageTerms: [
      "tapisserie", "restauration", "siege", "fauteuil", "chaise", "cabriolet", "tabouret",
      "garnissage", "assise",
    ],
    actionHint:
      "Protect the restoration service page and add local proof, process detail and a clear quote path.",
  },
  {
    slug: "creation-abat-jour",
    offerKey: "Création d'abat-jours",
    preferredPages: ["/lampes/abat-jours"],
    name: "Création d'abat-jours artisanaux & sur mesure",
    intent: "commercial",
    relevance: "high",
    coverageKind: "product",
    rationale:
      "Core product: handmade fabric lampshades, including pagode, drum and bespoke shapes in named collections.",
    requireAny: ["abat jour", "abats jour", "abbat jour", "abatjour"],
    terms: [
      "abat jour", "abbat jour", "sur mesure", "pagode", "tambour", "bauhaus", "empire", "cone", "cylindre",
      "forme", "tissu", "couture", "couleur", "collection", "unique", "artisanal", "fait main",
    ],
    strongTerms: ["sur mesure", "pagode", "tambour", "bauhaus"],
    coverageRequireAny: ["abat jour", "abat-jour"],
    pageTerms: ["abat-jour", "abat jour", "pagode", "tambour", "escale", "sur-mesure", "abat-jours"],
    actionHint:
      "Keep the abat-jour category strong; add a clear bespoke/shape guide if the 'sur mesure' queries remain uncovered.",
  },
  {
    slug: "restauration-abat-jour",
    offerKey: "Restauration d'abat-jour",
    name: "Restauration d'abat-jour",
    intent: "commercial",
    relevance: "high",
    coverageKind: "service",
    rationale:
      "Core service: repairing, re-covering and restoring old or damaged lampshades, including contrecollé and lining work.",
    requireAny: ["abat jour", "abats jour", "abbat jour", "abatjour"],
    terms: [
      "abat jour", "abbat jour", "reparer", "restaurer", "restauration", "renover", "reparation", "refection",
      "ancien", "cabosse", "contrecollé", "contrecolle", "doublure", "tissu",
    ],
    strongTerms: ["reparer", "restaurer", "restauration", "renover", "reparation", "refection"],
    coverageRequireAny: ["restauration", "reparation", "reparer", "renover", "contrecollé", "contrecolle"],
    coverageRequireGroups: [
      ["abat jour", "abat-jour", "abat jours"],
      ["restauration", "reparation", "reparer", "renover", "contrecollé", "contrecolle"],
    ],
    pageTerms: ["abat-jour", "abat jour", "restauration", "reparation", "contrecollé", "contrecolle"],
    actionHint:
      "Check whether a dedicated restoration page exists; a blog post alone is not a service landing page.",
  },
  {
    slug: "luminaires",
    offerKey: "Lampes & luminaires",
    preferredPages: ["/lampes"],
    name: "Lampes & luminaires artisanaux",
    intent: "commercial",
    relevance: "high",
    coverageKind: "product",
    rationale:
      "Core product range: handmade table lamps, pendants, portable lamps, wall lights and upcycled lighting.",
    requireAny: [
      "lampe", "lampes", "luminaire", "luminaires", "suspension", "suspensions", "plafonnier",
      "lustre", "lampadaire", "applique", "baladeuse", "eclairage",
    ],
    terms: [
      "lampe", "lampes", "luminaire", "luminaires", "suspension", "suspensions", "plafonnier",
      "lustre", "lampadaire", "applique", "baladeuse", "eclairage", "artisanal", "artisanale",
      "artisanales", "artisanaux", "fait main", "createur", "fabricant", "fabrication", "sur mesure",
      "upcycle", "upcycling", "unique", "original", "originales", "francais",
    ],
    strongTerms: [
      "lampe", "lampes", "luminaire", "luminaires", "suspension", "plafonnier", "lustre",
      "lampadaire", "applique", "baladeuse", "eclairage",
    ],
    coverageRequireAny: ["lampe", "luminaire", "suspension", "baladeuse", "applique"],
    pageTerms: ["lampe", "lampes", "luminaire", "suspension", "baladeuse", "applique", "upcycl"],
    actionHint:
      "The range is well covered, but check whether plafonnier, lustre and lampadaire demand has a matching product page.",
  },
  {
    slug: "kits-ateliers",
    offerKey: "Kits DIY & ateliers",
    preferredPages: ["/les-ateliers"],
    name: "Kits DIY & ateliers créatifs",
    intent: "transactional",
    relevance: "high",
    coverageKind: "mixed",
    exclusive: true,
    rationale:
      "Product and service: DIY lamp kits and small-group upholstery/lampshade workshops in Normandy.",
    requireAny: ["kit", "kits", "diy", "atelier", "ateliers"],
    requireGroups: [
      ["kit", "kits", "diy", "atelier", "ateliers"],
      ["kit", "kits", "diy", "tapisserie", "abat jour", "lampe", "lampes", "cours", "stage", "fabrication", "creation"],
    ],
    terms: [
      "kit", "kits", "diy", "atelier", "ateliers", "fabrication", "fabriquer", "faire soi meme",
      "cours", "stage", "lampe", "lampes", "luminaire", "luminaires", "tapisserie",
    ],
    strongTerms: ["kit", "kits", "diy", "atelier", "ateliers"],
    coverageRequireAny: ["kit", "diy"],
    pageTerms: ["kit", "diy", "ateliers diy", "atelier diy", "cours", "stage"],
    actionHint:
      "Keep the workshop page and the kit product linked; the query set is transactional and close to purchase.",
  },
  {
    slug: "carte-cadeau",
    offerKey: "Cartes cadeaux",
    preferredPages: ["/gift-card"],
    name: "Cartes cadeaux",
    intent: "transactional",
    relevance: "medium",
    coverageKind: "product",
    rationale:
      "Gift product: a way to buy the atelier's craftsmanship without choosing a specific piece.",
    requireAny: ["carte cadeau", "cartes cadeaux", "gift card"],
    terms: ["carte cadeau", "cartes cadeaux", "gift card", "artisanat", "decoration"],
    strongTerms: ["carte cadeau", "cartes cadeaux", "gift card"],
    coverageRequireAny: ["carte cadeau", "gift card"],
    pageTerms: ["gift-card", "carte cadeau", "carte-cadeau"],
    actionHint:
      "The gift-card page exists. Check whether the Le Mans/Sarthe queries are a real market or historical noise.",
  },
  {
    slug: "objets-deco",
    offerKey: "Objets déco",
    preferredPages: ["/objets-deco"],
    name: "Objets déco & coussins",
    intent: "transactional",
    relevance: "medium",
    coverageKind: "product",
    rationale:
      "Adjacent product: handmade cushions and decorative objects that support the lighting and seating offer.",
    requireAny: ["coussin", "coussins", "objet deco", "objets deco", "decoration", "deco"],
    terms: ["coussin", "coussins", "objet deco", "objets deco", "decoration", "deco", "chambre", "interieur"],
    strongTerms: ["coussin", "coussins", "objet deco", "objets deco"],
    coverageRequireAny: ["objet", "coussin", "decoration"],
    pageTerms: ["objets-deco", "coussin", "decoration", "objet"],
    actionHint:
      "Keep as a supporting range; it is unlikely to outrank the core service and lighting topics.",
  },
  {
    slug: "tissus-matieres",
    offerKey: "Tissus & matières",
    preferredPages: ["/les-tissus"],
    name: "Tissus & matières",
    intent: "informational",
    relevance: "medium",
    coverageKind: "content",
    rationale:
      "Supporting content: the fabrics, trims and materials customers ask about before choosing a restoration or lampshade.",
    requireAny: ["tissu", "tissus", "crin", "velours", "lin", "coton", "matiere", "matieres", "couture", "bouton"],
    terms: ["tissu", "tissus", "crin", "velours", "lin", "coton", "matiere", "matieres", "couture", "bouton", "ameublement"],
    strongTerms: ["tissu", "tissus", "crin", "velours"],
    coverageRequireAny: ["tissu"],
    pageTerms: ["tissus", "tissu", "matiere", "velours", "crin"],
    actionHint:
      "Check the fabric page's depth; a thin page cannot carry the material questions that support the core services.",
  },
  {
    slug: "local-normandie",
    offerKey: "Restauration de siège",
    preferredPages: ["/"],
    name: "Tapissier & atelier en Normandie",
    intent: "local",
    relevance: "high",
    coverageKind: "local",
    rationale:
      "Local intent: people searching for an upholsterer, workshop or fabric shop around Saint-Pierre-en-Port and Normandy.",
    requireAny: [
      "autour de moi", "normandie", "saint pierre", "saint-pierre", "fecamp", "sainte adresse",
      "saint germain en laye", "le mans", "sarthe", "rouen", "caen", "honfleur", "pays de caux",
    ],
    terms: [
      "autour de moi", "normandie", "saint pierre", "saint-pierre", "fecamp", "sainte adresse",
      "saint germain en laye", "le mans", "sarthe", "rouen", "caen", "honfleur", "pays de caux",
    ],
    strongTerms: [
      "autour de moi", "normandie", "saint pierre", "saint-pierre", "le mans", "sarthe",
      "saint germain en laye", "sainte adresse",
    ],
    coverageRequireAny: ["normandie", "saint pierre", "saint-pierre"],
    pageTerms: ["normandie", "saint-pierre", "saint pierre", "a-propos", "tapisserie-restauration"],
    actionHint:
      "Check whether a dedicated local landing page exists; the home page naming the village is not the same as a local service page.",
  },
  {
    slug: "marque",
    offerKey: "Marque",
    preferredPages: ["/"],
    name: "Marque Atelier de l'harmonie",
    intent: "mixed",
    relevance: "high",
    coverageKind: "brand",
    rationale:
      "Navigational brand demand: people looking for the atelier by name, including spelling variants.",
    requireAny: ["atelier harmonie", "atelier de l harmonie", "atelier d harmonie", "atelier harmony", "harmonie", "harmony", "harmoni", "atelier harmonia", "l atelier by harmonie"],
    terms: ["atelier harmonie", "atelier de l harmonie", "atelier d harmonie", "atelier harmony", "harmonie", "harmony", "harmoni", "atelier harmonia", "l atelier by harmonie"],
    exclusive: true,
    strongTerms: ["atelier harmonie", "atelier d harmonie", "atelier harmony", "harmonie", "harmony"],
    coverageRequireAny: ["harmonie"],
    pageTerms: ["atelier-harmonie", "harmonie"],
    actionHint:
      "Protect the brand result; no content action unless a spelling variant has a separate page or a conflicting result.",
  },
  {
    slug: "b2b",
    offerKey: "Projets professionnels",
    preferredPages: ["/b2b"],
    name: "Projets professionnels & hôtels",
    intent: "commercial",
    relevance: "medium",
    coverageKind: "business",
    rationale:
      "Business development: hotels, restaurants, architects and decorators buying bespoke restoration or lighting projects.",
    requireAny: ["b2b", "professionnel", "professionnels", "hotel", "hotels", "architecte", "architectes", "decorateur", "decorateurs", "restaurant", "restaurateur", "collaboration"],
    terms: ["b2b", "professionnel", "professionnels", "hotel", "hotels", "architecte", "architectes", "decorateur", "decorateurs", "restaurant", "restaurateur", "collaboration"],
    strongTerms: ["b2b", "professionnel", "professionnels", "hotel", "hotels"],
    coverageRequireAny: ["b2b", "professionnel", "hotel", "architecte", "decorateur"],
    pageTerms: ["b2b", "professionnel", "hotel", "architecte", "decorateur"],
    actionHint:
      "Keep as a business-development topic; if query demand stays unmeasured, do not force it into the SEO priority list.",
  },
  {
    slug: "blog-artisanat",
    offerKey: "Blog",
    preferredPages: ["/blog"],
    name: "Blog & culture artisanat",
    intent: "informational",
    relevance: "low",
    coverageKind: "content",
    exclusive: true,
    rationale:
      "Supporting content: craft, restoration stories and inspiration that build topical authority around the core services.",
    requireAny: ["blog", "blogging", "artisan d art", "art et tapisserie", "inspiration"],
    terms: ["blog", "blogging", "artisan d art", "art et tapisserie", "inspiration", "conseil", "guide"],
    strongTerms: ["blog", "blogging", "art et tapisserie"],
    coverageRequireAny: ["blog", "artisanat", "inspiration"],
    pageTerms: ["blog", "artisanat", "inspiration", "conseil"],
    actionHint:
      "Use as supporting authority, not as a commercial target; check that the posts link to the service and product pages.",
  },
];
