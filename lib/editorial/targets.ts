export type EditorialTargetClass =
  | "landing"
  | "category"
  | "blog"
  | "product"
  | "listing"
  | "system"
  | "unknown";

export type EditorialTargetInfo = {
  targetClass: EditorialTargetClass;
  durable: boolean;
  reason: string;
};

function pathOf(url: string): string {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  return path.replace(/^\/(?:en|fr|es|de|it|pt)(?=\/)/i, "");
}

export function classifyEditorialTarget(url: string | null | undefined): EditorialTargetInfo {
  if (!url) return { targetClass: "unknown", durable: false, reason: "no target URL" };
  const path = pathOf(url);

  if (/^\/(?:cart|checkout|account|my-|search|login|profile|thank-you|book-online|booking)(?:\/|$)/i.test(path)
    || /^\/my-(?:account|orders|bookings|addresses|subscriptions|wallet)(?:\/|$)/i.test(path)) {
    return { targetClass: "system", durable: false, reason: "account, checkout, or system page" };
  }
  if (/^\/(?:product-page|product|products)\//i.test(path)) {
    return { targetClass: "product", durable: false, reason: "individual product page" };
  }
  if (/^\/(?:real-estate-listings|listings|listing|properties|property)\//i.test(path)) {
    return { targetClass: "listing", durable: false, reason: "individual listing page" };
  }
  if (/[?&]page=/.test(url) || /^\/category\/all-products(?:\/|$)/i.test(path)) {
    return { targetClass: "listing", durable: false, reason: "paginated product catalog" };
  }
  if (/^\/(?:post|blog)\//i.test(path)) {
    return { targetClass: "blog", durable: true, reason: "blog post" };
  }
  if (/^\/(?:category|collections?|categorie|categories)\//i.test(path)
    || /^\/lampes\/[^/]+\/?$/i.test(path)) {
    return { targetClass: "category", durable: true, reason: "category landing page" };
  }
  return { targetClass: "landing", durable: true, reason: "durable landing page" };
}

export function isDurableEditorialTarget(url: string | null | undefined): boolean {
  return classifyEditorialTarget(url).durable;
}
