/**
 * dsh-model-fold — host half.
 *
 * A pure UI plugin: every behaviour lives in the browser bundle declared by
 * `dsh.client` in package.json. This host half exists so the package can be
 * mounted as an ordinary Cordis row in a profile — the client-modules Node half
 * scans the Loader's entries for packages declaring `dsh.client` and only then
 * serves `/plugins/<package>/client.js` to the page.
 *
 * The empty `apply` is therefore load-bearing: mounting the row is what makes
 * the browser half reachable.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
