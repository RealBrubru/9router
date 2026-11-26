export function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) specifier = new URL(`../../src/${specifier.slice(2)}`, import.meta.url).href;
  return next(specifier, context);
}
