/**
 * Vercel entry point.
 *
 * Vercel's Node.js runtime runs each file in `api/` as a serverless function.
 * The Express app is exported directly; Vercel handles the request/response
 * plumbing.
 *
 * The `.mjs` extension matters: the package is CommonJS, so a `.js` file here
 * would be parsed as CommonJS and the import below would fail.
 */
import app from "../server/server.mjs";

export default app;
