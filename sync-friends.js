/**
 * WC2026 Friends Game Auto-Sync Script
 * Fetches completed results from openfootball/worldcup.json
 * and writes them to the friends Firebase project (wc2026-friends)
 *
 * Friends app stores results differently:
 *   Collection: gang_meta / Document: state
 *   Field: results → { A1:{h,a}, A2:{h,a}, ... }
 * Match IDs: A1-A6, B1-B6 ... L1-L6 (uppercase, no zero-pad)
 */

const https = require("https");
const admin = require("firebase-admin");

// ── Firebase init — friends project ──────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_FRIENDS);
const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
}, "friends"); // named app to avoid conflict if both run together
const db = app.firestore();

const API_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

// ── Match ID mapping ──────────────────────────────────────────────────────────
// Friends app uses PAIRINGS = [[0,1],[2,3],[0,2],[3,1],[3,0],[1,2]]
// applied to GROUPS: { A:[team0,team1,team2,team3], ... }
// Generating match IDs: A1-A6, B1-B6 ... L1-L6

const GROUPS = {
  A:["Mexico","South Africa","South Korea","Czech Republic"],
  B:["Canada","Bosnia & Herzegovina","Qatar","Switzerland"],
  C:["Brazil","Morocco","Haiti","Scotland"],
  D:["United States","Paraguay","Australia","Turkey"],
  E:["Germany","Curaçao","Ivory Coast","Ecuador"],
  F:["Netherlands","Japan","Sweden","Tunisia"],
  G:["Belgium","Egypt","Iran","New Zealand"],
  H:["Spain","Cape Verde","Saudi Arabia","Uruguay"],
  I:["France","Senegal","Iraq","Norway"],
  J:["Argentina","Algeria","Austria","Jordan"],
  K:["Portugal","DR Congo","Uzbekistan","Colombia"],
  L:["England","Croatia","Ghana","Panama"],
};
const PAIRINGS = [[0,1],[2,3],[0,2],[3,1],[3,0],[1,2]];

// Build match map: "HomeTeam|AwayTeam" → "A1"
const MATCH_MAP = {};
Object.keys(GROUPS).forEach(g => {
  const teams = GROUPS[g];
  PAIRINGS.forEach((p, i) => {
    const home = teams[p[0]];
    const away = teams[p[1]];
    const id   = `${g}${i + 1}`;
    MATCH_MAP[`${home}|${away}`] = id;
    MATCH_MAP[`${away}|${home}`] = id; // reverse lookup
  });
});

// Team name aliases (API uses "USA", friends app uses "United States")
const ALIASES = {
  "USA":                    "United States",
  "US":                     "United States",
  "Curacao":                "Curaçao",
  "Côte d'Ivoire":          "Ivory Coast",
  "DR Congo":               "DR Congo",
  "Congo, DR":              "DR Congo",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Bosnia-Herzegovina":     "Bosnia & Herzegovina",
  "Korea Republic":         "South Korea",
  "Republic of Korea":      "South Korea",
  "Czechia":                "Czech Republic",
  "Czech Rep.":             "Czech Republic",
  "IR Iran":                "Iran",
  "Cabo Verde":             "Cape Verde",
};

function normalise(n){ return ALIASES[n] || n; }
function lookupMatchId(team1, team2){
  const h = normalise(team1), a = normalise(team2);
  return MATCH_MAP[`${h}|${a}`] || null;
}



// ── Fetch JSON ────────────────────────────────────────────────────────────────
function fetchJSON(url){
  return new Promise((resolve, reject) => {
    https.get(url, { headers:{"User-Agent":"wc2026-sync/1.0"} }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e){ reject(new Error(`JSON parse: ${e.message}`)); }
      });
    })
    .on("error", reject)
    .setTimeout(15000, function(){ this.destroy(); reject(new Error("Timeout")); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  console.log(`\n🕐 Friends sync started: ${new Date().toISOString()}`);
  console.log("📡 Fetching from openfootball/worldcup.json...");

  let data;
  try { data = await fetchJSON(API_URL); }
  catch(e){ console.error(`❌ Fetch failed: ${e.message}`); process.exit(1); }

  const matches   = data.matches || [];
  const completed = matches.filter(m => m.score && m.score.ft);
  console.log(`📊 ${matches.length} total · ${completed.length} completed`);

  // Build results object to merge into gang_meta/state
  const newResults = {};
  let updated = 0, noMatch = 0;
  const logged = [];

  for(const m of completed){
    const [hg, ag] = m.score.ft;
    const mid = lookupMatchId(m.team1, m.team2);
    if(!mid){
      console.log(`  ⚠️  No match ID: "${m.team1}" vs "${m.team2}"`);
      noMatch++;
      continue;
    }

    newResults[mid] = { h: Number(hg), a: Number(ag) };
    const line = `  ✅ ${mid.padEnd(3)} ${m.team1} ${hg}–${ag} ${m.team2}`;
    console.log(line);
    logged.push(line);
    updated++;
  }

  if(updated > 0){
    // Friends app stores all results as a single nested object in gang_meta/state
    // Use dot-notation merge so we only update results fields, not wipe bonuses/locked
    const updatePayload = {};
    Object.keys(newResults).forEach(mid => {
      updatePayload[`results.${mid}`] = newResults[mid];
    });
    await db.collection("gang_meta").doc("state").set(
      { results: newResults },
      { merge: true }
    );
    console.log(`\n✅ Committed ${updated} result(s) to gang_meta/state`);
  } else {
    console.log("\nℹ️  No completed results to write");
  }

  // Write sync metadata
  await db.collection("gang_meta").doc("syncStatus").set({
    lastSync: new Date().toISOString(),
    updated, noMatch,
    source:   "github-actions / openfootball",
    log:      logged,
  }, { merge: true });

  console.log(`📈 Summary: ${updated} written, ${noMatch} unmapped`);
  console.log(`🕐 Friends sync complete: ${new Date().toISOString()}\n`);
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
