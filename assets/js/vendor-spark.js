/**
 * vendor-spark.js - the one door to the vendored splat renderer.
 *
 * spark.module.js is 5.2 MB of third-party code and it is the only file in this
 * repo that is not ours. Everything that needs it imports from here instead, so
 * there is exactly one path to update when it moves and one place to read to
 * find out what version is on disk.
 *
 * @sparkjsdev/spark 2.1.0, MIT. Vendored, not fetched: REQUIREMENTS.md forbids
 * a build step and a CDN, and the import map in index.html resolves `three` and
 * `three/addons/` for it exactly the way it resolves them for our own modules.
 * Spark imports `three/addons/postprocessing/Pass.js`, which is already
 * vendored for the bloom chain, so it costs no additional addon.
 */

export { SplatMesh, SparkRenderer } from '../vendor/spark.module.js';
