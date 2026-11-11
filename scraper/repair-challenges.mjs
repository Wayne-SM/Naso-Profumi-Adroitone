/**
 * Re-fetches Cloudflare-challenged pages using a warm session.
 *
 * The origin serves a challenge to high-rate clients. A browser-like session
 * (homepage first, then the target page, carrying cf cookies) clears it.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, PUBLIC, ORIGIN, writeJson, grab, sleep } from "./lib.mjs";

const routes = JSON.parse(fs.readFileSync(path.join(DATA, "routes.json"), "utf8"));

const fileFor = (route) =>
  route === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, route.replace(/^\//, "").replace(/\//g, "__") + ".html");

const isChallenge = (html) =>
  /cdn-cgi\/challenge-platform/.test(html) || /Your connection needs to be verified/.test(html) || /cf_chl_opt/.test(html);

const bad = routes.filter((r) => {
  const f = fileFor(r.route);
  return fs.existsSync(f) && isChallenge(fs.readFileSync(f, "utf8"));
});
console.log(`challenged: ${bad.length}`);

// A shared session: warm it with the homepage, keep the cf cookies.
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}

async function warm() {
  const res = await grab(ORIGIN + "/", { headers: { Cookie: cookieHeader() } });
  absorb(res);
  await res.text();
}

const headers = () => ({
  Cookie: cookieHeader(),
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
});

let fixed = 0;
const stillBad = [];

for (const r of bad) {
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    try {
      await warm();
      await sleep(1200 + Math.random() * 1500);
      const res = await grab(ORIGIN + r.route, { headers: headers() });
      absorb(res);
      const html = await res.text();
      if (!isChallenge(html) && html.length > 20000) {
        fs.writeFileSync(fileFor(r.route), html);
        ok = true;
        fixed++;
        console.log(`  fixed ${r.route} (${html.length})`);
        break;
      }
    } catch (e) {
      /* retry */
    }
  }
  if (!ok) stillBad.push(r.route);
}

console.log(`\nrepaired ${fixed}/${bad.length}`);
if (stillBad.length) console.log("still:", stillBad.join(", "));
writeJson(path.join(DATA, "challenged.json"), stillBad);
