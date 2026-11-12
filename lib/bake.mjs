/**
 * Build-time HTML transformations.
 *
 * The mirrored pages need a few adjustments before they can be served:
 *
 *   1. The Shopify "exit interstitial" script hijacks every outbound link and
 *      redirects it through the origin's /url endpoint. It is removed.
 *   2. The Shopify runtime globals point at the live shop. They are repointed
 *      at the clone.
 *   3. The footer's "Information" link is a dead `#` anchor, and a demo
 *      notice is appended below the footer.
 *
 * Applying these at build time means the server can serve the files as they
 * are, with no per-request rewriting — which keeps the memory footprint small
 * enough to run on a modest instance.
 *
 * Every transformation is idempotent, so the server can safely apply the same
 * function to a page that has not been baked.
 */

/** Marks a page as baked, so the server can skip the work. */
export const BAKED_MARKER = "<!-- naso-baked -->";

const NOTICE_MARKER = "naso-demo-notice";

export const DEMO_NOTICE = `
<div class="${NOTICE_MARKER}" role="note">
  <div class="${NOTICE_MARKER}__inner">
    <p class="${NOTICE_MARKER}__text">
      <strong>Demo clone only.</strong> This is a local, non-commercial replica of
      nasoprofumi.com built for demonstration and testing. It is not affiliated
      with, endorsed by, or connected to Naso Profumi. No orders are processed
      and no payments are taken &mdash; checkout is disabled.
    </p>
  </div>
</div>`;

/** Applies the footer corrections to a page's HTML. */
export function fixFooter(html) {
  if (!html || !html.includes("main-footer")) return html;

  let out = html;

  // 1. Replace the dead "Information" anchor with the collections link.
  out = out.replace(
    /(<a[^>]*href=)"#"([^>]*>\s*Information\s*<\/a>)/gi,
    (m, pre, post) => `${pre}"/collections"${post}`
  );

  // 2. Append the demo notice after the footer.
  if (!out.includes(NOTICE_MARKER)) {
    out = out.replace(/<\/footer>/, `</footer>${DEMO_NOTICE}`);
  }

  return out;
}

/**
 * Applies every build-time transformation to a page.
 */
export function bakePage(html) {
  if (!html) return html;
  let out = html;

  // Theme assets -> local /assets.
  out = out.replace(
    /(?:https?:)?\/\/www\.nasoprofumi\.com\/cdn\/shop\/t\/30\/assets\/([A-Za-z0-9._-]+)(\?v=\d+)?/g,
    (m, file) => {
      if (/\.(woff2?|ttf|otf)$/i.test(file)) return `/assets/fonts/${file}`;
      if (/\.css$/i.test(file)) return `/assets/css/${file}`;
      if (/\.js$/i.test(file)) return `/assets/js/${file}`;
      if (/\.(png|jpe?g|gif|svg|webp)$/i.test(file)) return `/assets/img/${file}`;
      return `/assets/js/${file}`;
    }
  );

  // Shopify CDN images -> local /assets/img.
  out = out.replace(
    /(?:https?:)?\/\/(?:www\.nasoprofumi\.com\/cdn\/shop\/(files|products|articles|collections)|cdn\.shopify\.com\/s\/files\/1\/\d+\/\d+\/\d+\/(files|products|articles|collections))\/([^"'?\s)]+)(\?v=\d+)?/g,
    (m, t1, t2, file) => {
      const type = t1 || t2;
      const clean = file.replace(/\?.*$/, "");
      const encoded = encodeURIComponent(clean).replace(/%7B/g, "{").replace(/%7D/g, "}");
      return `/assets/img/${type}/${encoded}`;
    }
  );

  // Remaining absolute same-site links -> relative.
  out = out.replace(/https?:\/\/www\.nasoprofumi\.com(?=\/)/g, "");

  // The exit-interstitial hijacks every outbound link; remove it.
  out = out.replace(
    /<script data-source-attribution="shopify\.exit_interstitial">[\s\S]*?<\/script>/g,
    ""
  );

  // Repoint the Shopify runtime globals at the clone.
  out = out.replace(/Shopify\.shop\s*=\s*"[^"]*"/g, 'Shopify.shop = "naso-profumi.myshopify.com"');
  out = out.replace(/Shopify\.cdnHost\s*=\s*"[^"]*"/g, 'Shopify.cdnHost = ""');
  out = out.replace(/"domain":"[^"]*"/g, '"domain":"localhost"');
  out = out.replace(/"backendHost":"[^"]*"/g, '"backendHost":""');

  out = fixFooter(out);

  // The demo notice's stylesheet.
  if (!out.includes("/assets/css/demo-notice.css")) {
    out = out.replace(
      "</head>",
      '  <link rel="stylesheet" href="/assets/css/demo-notice.css">\n</head>'
    );
  }

  if (!out.includes(BAKED_MARKER)) {
    out = out.includes("</head>")
      ? out.replace("</head>", `  ${BAKED_MARKER}\n</head>`)
      : BAKED_MARKER + out;
  }

  return out;
}
