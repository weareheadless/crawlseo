/**
 * Acceptance fixtures for the customer-centred recommendation brief (§1).
 *
 * These are sanitised reconstructions of the expert review, not copies of customer
 * data. Each carries enough page content and source text to evaluate a conclusion,
 * so a test cannot pass merely because a model returned the expected JSON.
 *
 * Tenant names appear only here. Production logic must never branch on them.
 */

export type FixturePage = {
  url: string;
  title: string;
  contentText: string;
  statusCode?: number;
};

export type FixtureAssessment = {
  needState: "supported" | "unverified" | "contradicted";
  offerFitState: "supported" | "unverified" | "contradicted";
  coverage: Array<{
    pageUrl: string;
    state: "answers" | "partially_answers" | "does_not_answer" | "unassessable";
    note: string;
    excerpts?: string[];
  }>;
  intervention: "maintain" | "update_page" | "improve_journey" | "create_asset" | "investigate";
  change: string;
  targetPages?: string[];
  expectedBenefit?: string;
  successMeasure?: string;
  review?: "none" | "subject_matter_expert" | "legal" | "medical";
};

export type FixtureFinding = {
  type: "CONCERN" | "CONTENT_GAP" | "POSITIONING_GAP" | "QUESTION";
  theme: string;
  summary: string;
  /** The site claim the finding makes, when it makes one. */
  claim?: { kind: "missing_page_type" | "missing_answer" | "absent_offering"; pageType?: string; statement: string };
  /** Business fit the fixture establishes. Defaults to supported. */
  businessFit?: "supported" | "contradicted";
  /**
   * A pre-made assessment for the deterministic regression suite.
   *
   * This is fixture reasoning, not evidence that the model reasons well. The real
   * assessment is exercised by `scripts/evaluate-need-assessment.ts`; keeping the
   * two separate stops a fixture from being reported as live quality.
   */
  assessment?: FixtureAssessment;
};

export type TenantFixture = {
  name: string;
  domain: string;
  crawlComplete: boolean;
  pages: FixturePage[];
  findings: FixtureFinding[];
  /** What a correct system must decide for each finding theme. */
  expectations: Record<string, { readiness: string; reasonContains: string }>;
};

const susiPages: FixturePage[] = [
  {
    url: "https://www.susimacdonald.com/post/how-to-buy-your-dream-home-in-mexico-as-a-foreigner",
    title: "How to buy your dream home in Mexico as a foreigner",
    contentText:
      "Areas within 50 kilometers of the coast are the restricted zone. If you want to buy property in the restricted zone you have two options: a trust deed or a permit. A trust deed (fideicomiso) allows a Mexican bank to hold the title on your behalf. You have full rights to use, sell or inherit the property but you pay an annual fee. Budget for the appraisal, the inspection, the closing, the registration and the taxes.",
  },
  {
    url: "https://www.susimacdonald.com/post/fideicomisos-unlocking-real-estate-opportunities-in-mexico-s-restricted-zones",
    title: "Fideicomisos: Unlocking Real Estate Opportunities in Mexico's Restricted Zones",
    contentText:
      "A fideicomiso is a bank trust that lets a foreign buyer hold residential property inside the restricted zone. This article explains the trust deed, the permit alternative, renewal and annual fees for foreign buyers.",
  },
  {
    url: "https://www.susimacdonald.com/post/beachfront-homes-for-sale-under-100k-in-mexico-exploring-the-reality-and-alternatives-in-riviera-m",
    title: "Beachfront Homes for Sale Under $100K in Mexico",
    contentText:
      "Beachfront property under one hundred thousand dollars is rare in the Riviera Maya. This guide explains what that budget can realistically buy, the alternatives inland, and how to evaluate a listing.",
  },
];

const atelierPages: FixturePage[] = [
  {
    url: "https://www.atelier-harmonie.com/lampes/abat-jours",
    title: "Abat-jour artisanaux uniques et faits main",
    contentText:
      "Nous fabriquons des abat-jours artisanaux, sur mesure, dans notre atelier en Normandie. Chaque abat-jour est réalisé à la main, avec un choix de tissus et de finitions. Demandez un devis pour un abat-jour sur mesure.",
  },
  {
    url: "https://www.atelier-harmonie.com/devis",
    title: "Demande de Devis pour votre Projet sur Mesure",
    contentText:
      "Décrivez votre projet de restauration de siège ou de fabrication d'abat-jour sur mesure. Nous vous répondons avec un devis et un délai. Confiez-nous une pièce héritée ou une trouvaille de brocante.",
  },
  {
    url: "https://www.atelier-harmonie.com/b2b",
    title: "Tapisserie et luminaire sur mesure pour professionnels",
    contentText:
      "Nous travaillons avec les hôtels, les restaurants, les architectes d'intérieur et les décorateurs sur des projets de tapisserie et de luminaire sur mesure. Envoyez-nous votre projet, vos références et vos modalités pour recevoir un devis.",
  },
  {
    url: "https://www.atelier-harmonie.com/category/abat-jours",
    title: "Checking Your Request",
    contentText: "",
    statusCode: 429,
  },
];

const casamigoPages: FixturePage[] = [
  {
    url: "https://www.casamigo.net/cities/playa-del-carmen",
    title: "Playa del Carmen Market Analysis | Casamigo",
    contentText:
      "Playa del Carmen market analysis: prices by neighbourhood, rental yield, new developments and comparison of districts for buyers and investors.",
  },
  {
    url: "https://www.casamigo.net/cities/tulum",
    title: "Tulum Market Analysis | Casamigo",
    contentText:
      "Tulum market analysis: inventory, pricing and a comparison of beach and town districts for buyers considering Tulum.",
  },
  {
    url: "https://www.casamigo.net/property/aak-tulum",
    title: "Aak Tulum",
    contentText: "A named development in Tulum with unit types, prices and delivery dates.",
  },
];

const oceanicPages: FixturePage[] = [
  {
    url: "https://oceanicvibes.com/blog/how-to-choose-a-freediving-course-in-playa-del-carmen-a-local-s-guide",
    title: "How to choose a freediving course in Playa del Carmen",
    contentText:
      "Choosing a freediving course: certification level, instructor experience, group size, depth progression and safety supervision. This guide explains what to ask before booking a course.",
  },
  {
    url: "https://oceanicvibes.com/blog/cenote-or-ocean-first-freediving-course",
    title: "Cenote or ocean for your first freediving course",
    contentText:
      "Cenotes offer calm water and consistent depth; the ocean offers current and visibility. This page compares both for a first freediving course in the Riviera Maya.",
  },
];

const unseenPages: FixturePage[] = [
  {
    url: "https://unseen.example/",
    title: "Hartley & Sons — bespoke joinery",
    contentText:
      "We make fitted wardrobes, staircases and bespoke furniture for homes in Bristol. Every project starts with a survey and a written quotation.",
  },
  {
    url: "https://unseen.example/services",
    title: "Our joinery services",
    contentText: "Fitted wardrobes, staircases, kitchens and bespoke furniture. We work with homeowners and interior designers.",
  },
];

export const TENANT_FIXTURES: TenantFixture[] = [
  {
    name: "susi",
    domain: "www.susimacdonald.com",
    crawlComplete: true,
    pages: susiPages,
    findings: [
      {
        type: "CONTENT_GAP",
        theme: "Foreign land ownership and fideicomiso",
        summary: "No candidate page addresses foreign ownership or restricted-zone land for international buyers.",
        claim: { kind: "missing_answer", statement: "No page addresses foreign ownership or restricted zone land." },
      },
      {
        type: "CONCERN",
        theme: "Closing and title process",
        summary: "Buyers ask what closing costs and title checks actually involve before they commit.",
        assessment: {
          needState: "supported",
          offerFitState: "supported",
          coverage: [{
            pageUrl: "https://www.susimacdonald.com/post/how-to-buy-your-dream-home-in-mexico-as-a-foreigner",
            state: "partially_answers",
            note: "It names the cost categories but gives no worked example or current figures.",
            excerpts: ["Budget for the appraisal, the inspection, the closing, the registration and the taxes."],
          }],
          intervention: "update_page",
          change: "Add a worked closing-cost example with the current fee ranges and the title-check steps.",
          targetPages: ["https://www.susimacdonald.com/post/how-to-buy-your-dream-home-in-mexico-as-a-foreigner"],
          expectedBenefit: "A buyer can judge the total cost and the title check before committing.",
          successMeasure: "A buyer can state the expected closing cost after reading the page.",
          review: "legal",
        },
      },
    ],
    expectations: {
      "Foreign land ownership and fideicomiso": { readiness: "rejected", reasonContains: "already answers" },
      "Closing and title process": { readiness: "actionable", reasonContains: "existing page" },
    },
  },
  {
    name: "atelier",
    domain: "atelier-harmonie.com",
    crawlComplete: false,
    pages: atelierPages,
    findings: [
      {
        type: "CONTENT_GAP",
        theme: "Corpus de sources hors sujet",
        summary: "Les sources portent sur des sièges parlementaires canadiens et non sur la tapisserie de siège. Aucune source ne documente la demande.",
      },
      {
        type: "CONTENT_GAP",
        theme: "Abat-jour sur mesure : offre dédiée absente",
        summary: "Aucune page service n'articule clairement l'offre d'abat-jour sur mesure.",
        claim: { kind: "missing_answer", statement: "Aucune page service n'articule clairement l'offre d'abat-jour sur mesure." },
      },
      {
        type: "CONCERN",
        theme: "Projets hôtels, restaurants et prescripteurs",
        summary: "Les prescripteurs attendent des références et des modalités de projet pour les commandes hôtelières.",
        assessment: {
          needState: "supported",
          offerFitState: "supported",
          coverage: [{
            pageUrl: "https://www.atelier-harmonie.com/b2b",
            state: "partially_answers",
            note: "The page states the B2B offer but gives no project references or delivery terms.",
            excerpts: ["Nous travaillons avec les hôtels, les restaurants, les architectes d'intérieur et les décorateurs"],
          }],
          intervention: "update_page",
          change: "Add two hotel project references and the lead time and delivery terms for professional orders.",
          targetPages: ["https://www.atelier-harmonie.com/b2b"],
          expectedBenefit: "A hotel buyer can judge whether the atelier can deliver their project.",
          successMeasure: "A hotel buyer can find a comparable project and the delivery terms on the page.",
          review: "none",
        },
      },
    ],
    expectations: {
      "Corpus de sources hors sujet": { readiness: "rejected", reasonContains: "pipeline-quality" },
      "Abat-jour sur mesure : offre dédiée absente": { readiness: "rejected", reasonContains: "already answers" },
      "Projets hôtels, restaurants et prescripteurs": { readiness: "actionable", reasonContains: "existing page" },
    },
  },
  {
    name: "casamigo",
    domain: "casamigo.net",
    crawlComplete: true,
    pages: casamigoPages,
    findings: [
      {
        type: "POSITIONING_GAP",
        theme: "Portal-style listing framing vs. development pages",
        summary: "The site does not articulate a city-level entry point that would match the aggregator framing.",
        claim: { kind: "missing_page_type", pageType: "cities", statement: "The site has no city-level entry point." },
      },
      {
        type: "CONTENT_GAP",
        theme: "Mexico City not covered by site inventory",
        summary: "The site has no Mexico City inventory or market page.",
        claim: { kind: "missing_page_type", pageType: "mexico-city", statement: "No Mexico City inventory." },
        // The business serves Riviera Maya inventory; nothing supports entering
        // Mexico City, so fit is contradicted rather than merely unproven.
        businessFit: "contradicted",
      },
    ],
    expectations: {
      "Portal-style listing framing vs. development pages": { readiness: "rejected", reasonContains: "cities page" },
      "Mexico City not covered by site inventory": { readiness: "rejected", reasonContains: "should not serve" },
    },
  },
  {
    name: "oceanic",
    domain: "oceanicvibes.com",
    crawlComplete: true,
    pages: oceanicPages,
    findings: [
      {
        type: "CONCERN",
        theme: "Beginner depth safety and lanyard use",
        summary: "A beginner asks about deep dives without a lanyard and supervised depth progression before booking a course.",
        assessment: {
          needState: "supported",
          offerFitState: "supported",
          coverage: [{
            pageUrl: "https://oceanicvibes.com/blog/how-to-choose-a-freediving-course-in-playa-del-carmen-a-local-s-guide",
            state: "partially_answers",
            note: "The guide covers safety supervision and depth progression but not lanyard use or a beginner depth limit.",
            excerpts: ["certification level, instructor experience, group size, depth progression and safety supervision"],
          }],
          intervention: "update_page",
          change: "Add a beginner section on lanyard use and the maximum supervised depth for a first course.",
          targetPages: ["https://oceanicvibes.com/blog/how-to-choose-a-freediving-course-in-playa-del-carmen-a-local-s-guide"],
          expectedBenefit: "A beginner can ask the right safety questions before booking.",
          successMeasure: "A beginner can state the lanyard rule and the supervised depth limit after reading.",
          review: "subject_matter_expert",
        },
      },
      {
        type: "QUESTION",
        theme: "How to start freediving",
        summary: "Someone new asks how to start freediving and what the first course involves.",
        claim: { kind: "missing_answer", statement: "No page answers how to start freediving." },
      },
    ],
    expectations: {
      "Beginner depth safety and lanyard use": { readiness: "actionable", reasonContains: "partly answers" },
      // The guide already covers it, so the claimed gap is contradicted: no new
      // asset is needed, which is a rejection of the gap rather than of the need.
      "How to start freediving": { readiness: "rejected", reasonContains: "already answers" },
    },
  },
  {
    name: "unseen",
    domain: "unseen.example",
    crawlComplete: true,
    pages: unseenPages,
    findings: [
      {
        type: "CONCERN",
        theme: "Customers cannot tell what a fitted wardrobe costs",
        summary: "Homeowners repeatedly ask what a fitted wardrobe costs before they will book a survey.",
        assessment: {
          needState: "supported",
          offerFitState: "supported",
          coverage: [{
            pageUrl: "https://unseen.example/services",
            state: "does_not_answer",
            note: "The page lists the services and a quotation, but gives no cost range or example.",
          }],
          intervention: "update_page",
          change: "Add a price range for a typical fitted wardrobe and what the written quotation includes.",
          targetPages: ["https://unseen.example/services"],
          expectedBenefit: "A homeowner can judge whether the budget is plausible before booking a survey.",
          successMeasure: "A homeowner can state a typical range and what the quote covers.",
          review: "none",
        },
      },
    ],
    expectations: {
      "Customers cannot tell what a fitted wardrobe costs": { readiness: "actionable", reasonContains: "existing page" },
    },
  },
];

/** Negative controls the decision contract must also get right. */
export const NEGATIVE_CONTROLS = {
  genuineGap: {
    statement: "No page explains how the warranty claim process works",
    pages: [unseenPages[1]],
  },
  multipleUrlsNoHarm: {
    query: "fitted wardrobes bristol",
    pages: [unseenPages[0], unseenPages[1]],
  },
  rateLimitedPage: {
    url: "https://www.atelier-harmonie.com/category/abat-jours",
    statusCode: 429,
  },
  highVolumeIncidental: {
    query: "hospital near me",
    impressions: 115,
    businessFit: "unknown",
  },
  strongNeedUnknownDemand: {
    statement: "Customers ask whether a fitted wardrobe can be moved to a new house",
    pages: [unseenPages[1]],
  },
};
