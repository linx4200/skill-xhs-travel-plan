const LODGING_SUFFIX_RE = /\s*(?:[-－–—]|[|｜])\s*宿\s*[^-|｜－–—]+$/u;

export function cleanDayTitle(title) {
  return String(title ?? "").replace(LODGING_SUFFIX_RE, "").trim();
}

export function dayDisplayTitle(title, lodgingCity) {
  const baseTitle = cleanDayTitle(title);
  const city = String(lodgingCity ?? "").trim();
  if (!city) return baseTitle;
  if (!baseTitle) return `宿${city}`;
  return `${baseTitle} ｜ 宿${city}`;
}
