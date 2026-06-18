/**
 * WC2026 Auto-Sync Script
 * Source: openfootball/worldcup.json on GitHub (raw.githubusercontent.com)
 * — always reachable from GitHub Actions, no API key, updated daily
 */

const https = require("https");
const admin = require("firebase-admin");

// ── Firebase init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
});
const db = admin.firestore();

// ── Data source ───────────────────────────────────────────────────────────────
// Hosted on GitHub — always reachable from GitHub Actions
// Schema: { matches: [{ team1, team2, score: { ft: [hg, ag] }, ... }] }
const API_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

// ── Match IDs to EXCLUDE from sync (results before the fresh-start date) ────────
// These are the first 20 matches played Jun 11-17 that we're not counting
const EXCLUDED_MATCH_IDS = new Set([
  "a01","a02",                          // Jun 11 — Mexico, South Korea
  "b01","d01",                          // Jun 12 — Canada, USA
  "b02","c01","c02",                    // Jun 13 — Qatar, Brazil, Haiti
  "d02","e01","e02","f01","f02",        // Jun 14 — Australia, Germany, Ivory Coast, Netherlands, Sweden
  "g01","g02","h01","h02",             // Jun 15 — Belgium, Iran, Spain, Saudi Arabia
  "i01","i02",                          // Jun 16 — France, Iraq
  "j01","j02","k01","l01","l02","k02", // Jun 17 — Argentina, Austria, Portugal, England, Ghana, Colombia
]);

// ── Match ID mapping ──────────────────────────────────────────────────────────
// "HomeTeam|AwayTeam" → Firestore document ID
const MATCH_MAP = {
  // Group A
  "Mexico|South Africa":              "a01",
  "South Korea|Czech Republic":       "a02",
  "Czech Republic|South Africa":      "a03",
  "Mexico|South Korea":               "a04",
  "Czech Republic|Mexico":            "a05",
  "South Africa|South Korea":         "a06",
  // Group B
  "Canada|Bosnia & Herzegovina":      "b01",
  "Qatar|Switzerland":                "b02",
  "Switzerland|Bosnia & Herzegovina": "b03",
  "Canada|Qatar":                     "b04",
  "Bosnia & Herzegovina|Qatar":       "b05",
  "Switzerland|Canada":               "b06",
  // Group C
  "Brazil|Morocco":                   "c01",
  "Haiti|Scotland":                   "c02",
  "Scotland|Morocco":                 "c03",
  "Brazil|Haiti":                     "c04",
  "Morocco|Haiti":                    "c05",
  "Scotland|Brazil":                  "c06",
  // Group D
  "USA|Paraguay":                     "d01",
  "Australia|Turkey":                 "d02",
  "USA|Australia":                    "d03",
  "Turkey|Paraguay":                  "d04",
  "Paraguay|Australia":               "d05",
  "Turkey|USA":                       "d06",
  // Group E
  "Germany|Curaçao":                  "e01",
  "Ivory Coast|Ecuador":              "e02",
  "Germany|Ivory Coast":              "e03",
  "Ecuador|Curaçao":                  "e04",
  "Curaçao|Ivory Coast":              "e05",
  "Ecuador|Germany":                  "e06",
  // Group F
  "Netherlands|Japan":                "f01",
  "Sweden|Tunisia":                   "f02",
  "Netherlands|Sweden":               "f03",
  "Tunisia|Japan":                    "f04",
  "Japan|Sweden":                     "f05",
  "Tunisia|Netherlands":              "f06",
  // Group G
  "Belgium|Egypt":                    "g01",
  "Iran|New Zealand":                 "g02",
  "Belgium|Iran":                     "g03",
  "New Zealand|Egypt":                "g04",
  "Egypt|Iran":                       "g05",
  "New Zealand|Belgium":              "g06",
  // Group H
  "Spain|Cape Verde":                 "h01",
  "Saudi Arabia|Uruguay":             "h02",
  "Spain|Saudi Arabia":               "h03",
  "Uruguay|Cape Verde":               "h04",
  "Cape Verde|Saudi Arabia":          "h05",
  "Uruguay|Spain":                    "h06",
  // Group I
  "France|Senegal":                   "i01",
  "Iraq|Norway":                      "i02",
  "France|Iraq":                      "i03",
  "Norway|Senegal":                   "i04",
  "Norway|France":                    "i05",
  "Senegal|Iraq":                     "i06",
  // Group J
  "Argentina|Algeria":                "j01",
  "Austria|Jordan":                   "j02",
  "Argentina|Austria":                "j03",
  "Jordan|Algeria":                   "j04",
  "Algeria|Austria":                  "j05",
  "Jordan|Argentina":                 "j06",
  // Group K
  "Portugal|DR Congo":                "k01",
  "Uzbekistan|Colombia":              "k02",
  "Portugal|Uzbekistan":              "k03",
  "Colombia|DR Congo":                "k04",
  "Colombia|Portugal":                "k05",
  "DR Congo|Uzbekistan":              "k06",
  // Group L
  "England|Croatia":                  "l01",
  "Ghana|Panama":                     "l02",
  "England|Ghana":                    "l03",
  "Panama|Croatia":                   "l04",
  "Croatia|Ghana":                    "l05",
  "Panama|England":                   "l06",
};

function lookupMatchId(team1, team2) {
  return MATCH_MAP[`${team1}|${team2}`]
      || MATCH_MAP[`${team2}|${team1}`]
      || null;
}

// ── Fetch JSON from URL ───────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "wc2026-sync/1.0" } }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    })
    .on("error", reject)
    .setTimeout(15000, function() { this.destroy(); reject(new Error("Timeout")); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🕐 Sync started: ${new Date().toISOString()}`);
  console.log(`📡 Fetching from openfootball/worldcup.json...`);

  let data;
  try { data = await fetchJSON(API_URL); }
  catch (e) { console.error(`❌ Fetch failed: ${e.message}`); process.exit(1); }

  // Schema: data.matches = array of match objects
  const matches = data.matches || [];
  const completed = matches.filter(m => m.score && m.score.ft);
  console.log(`📊 ${matches.length} total matches · ${completed.length} completed`);

  let updated = 0, skipped = 0, noMatch = 0;
  const batch  = db.batch();
  const logged = [];

  for (const m of completed) {
    const [hg, ag] = m.score.ft;   // full-time score array [homeGoals, awayGoals]
    const team1    = m.team1;       // home team name exactly as in MATCH_MAP
    const team2    = m.team2;       // away team name

    const mid = lookupMatchId(team1, team2);
    if(!mid){ console.log(`  ⚠️  No match ID: "${team1}" vs "${team2}"`); noMatch++; continue; }

    // Skip matches before the fresh-start cutoff
    if(EXCLUDED_MATCH_IDS.has(mid)){ skipped++; continue; }
    if (!mid) {
      console.log(`  ⚠️  No match ID: "${team1}" vs "${team2}"`);
      noMatch++;
      continue;
    }

    batch.set(db.collection("results").doc(mid), {
      hg:       Number(hg),
      ag:       Number(ag),
      syncedAt: new Date().toISOString(),
      source:   "openfootball/worldcup.json",
    });

    const line = `  ✅ ${mid.padEnd(4)} ${team1} ${hg}–${ag} ${team2}`;
    console.log(line);
    logged.push(line);
    updated++;
  }

  if (updated > 0) {
    await batch.commit();
    console.log(`\n✅ Committed ${updated} result(s) to Firestore`);
  } else {
    console.log("\nℹ️  No completed results to write");
  }

  // Write sync metadata so Admin tab can show last-sync time
  await db.collection("meta").doc("syncStatus").set({
    lastSync: new Date().toISOString(),
    updated, skipped, noMatch,
    source:   "github-actions / openfootball",
    log:      logged,
  }, { merge: true });

  console.log(`📈 Summary: ${updated} written, ${skipped} skipped, ${noMatch} unmapped`);
  console.log(`🕐 Sync complete: ${new Date().toISOString()}\n`);
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
