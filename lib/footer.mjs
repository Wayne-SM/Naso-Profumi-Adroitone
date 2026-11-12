/**
 * Footer corrections shared by the server and the build-time bake step.
 *
 * Two adjustments are made for a local demo:
 *
 *   1. The "Information" link is a dead `#` anchor on the origin (it opens a
 *      dropdown that is not part of the static build). It is pointed at the
 *      sitemap instead so it goes somewhere useful.
 *   2. A demo notice is appended below the footer.
 *
 * The function is idempotent: running it over already-processed HTML leaves it
 * unchanged, so the server can apply it at request time and the build can bake
 * it into the files without either doubling up.
 */

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
