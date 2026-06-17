/**
 * WC2026 Auto-Sync Script
 * Fetches completed match results from worldcup26.ir (free, no API key)
 * and writes them to Firebase Firestore.
 *
 * Run by GitHub Actions every hour automatically.
 */

const https    = require("https");
const admin    = require("firebase-admin");

// ── Firebase init using service account from GitHub Secret ────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
});
const db = admin.firestore();

// ── Match ID mapping ──────────────────────────────────────────────────────────
// "HomeTeam|AwayTeam" → your Firestore match document ID
const MATCH_MAP = {
  // Group A
  "Mexico|South Africa":            "a01",
  "South Korea|Czech Republic":     "a02",
  "Czech Republic|South Africa":    "a03",
  "Mexico|South Korea":             "a04",
  "Czech Republic|Mexico":          "a05",
  "South Africa|South Korea":       "a06",
  // Group B
  "Canada|Bosnia-Herzegovina":      "b01",
  "Qatar|Switzerland":              "b02",
  "Switzerland|Bosnia-Herzegovina": "b03",
  "Canada|Qatar":                   "b04",
  "Bosnia-Herzegovina|Qatar":       "b05",
  "Switzerland|Canada":             "b06",
  // Group C
  "Brazil|Morocco":                 "c01",
  "Haiti|Scotland":                 "c02",
  "Scotland|Morocco":               "c03",
  "Brazil|Haiti":                   "c04",
  "Morocco|Haiti":                  "c05",
  "Scotland|Brazil":                "c06",
  // Group D
  "United States|Paraguay":         "d01",
  "Australia|Turkey":               "d02",
  "United States|Australia":        "d03",
  "Turkey|Paraguay":                "d04",
  "Paraguay|Australia":             "d05",
  "Turkey|United States":           "d06",
  // Group E
  "Germany|Curaçao":                "e01",
  "Ivory Coast|Ecuador":            "e02",
  "Germany|Ivory Coast":            "e03",
  "Ecuador|Curaçao":                "e04",
  "Curaçao|Ivory Coast":            "e05",
  "Ecuador|Germany":                "e06",
  // Group F
  "Netherlands|Japan":              "f01",
  "Sweden|Tunisia":                 "f02",
  "Netherlands|Sweden":             "f03",
  "Tunisia|Japan":                  "f04",
  "Japan|Sweden":                   "f05",
  "Tunisia|Netherlands":            "f06",
  // Group G
  "Belgium|Egypt":                  "g01",
  "Iran|New Zealand":               "g02",
  "Belgium|Iran":                   "g03",
  "New Zealand|Egypt":              "g04",
  "Egypt|Iran":                     "g05",
  "New Zealand|Belgium":            "g06",
  // Group H
  "Spain|Cape Verde":               "h01",
  "Saudi Arabia|Uruguay":           "h02",
  "Spain|Saudi Arabia":             "h03",
  "Uruguay|Cape Verde":             "h04",
  "Cape Verde|Saudi Arabia":        "h05",
  "Uruguay|Spain":                  "h06",
  // Group I
  "France|Senegal":                 "i01",
  "Iraq|Norway":                    "i02",
  "France|Iraq":                    "i03",
  "Norway|Senegal":                 "i04",
  "Norway|France":                  "i05",
  "Senegal|Iraq":                   "i06",
  // Group J
  "Argentina|Algeria":              "j01",
  "Austria|Jordan":                 "j02",
  "Argentina|Austria":              "j03",
  "Jordan|Algeria":                 "j04",
  "Algeria|Austria":                "j05",
  "Jordan|Argentina":               "j06",
  // Group K
  "Portugal|Congo DR":              "k01",
  "Uzbekistan|Colombia":            "k02",
  "Portugal|Uzbekistan":            "k03",
  "Colombia|Congo DR":              "k04",
  "Colombia|Portugal":              "k05",
  "Congo DR|Uzbekistan":            "k06",
  // Group L
  "England|Croatia":                "l01",
  "Ghana|Panama":                   "l02",
  "England|Ghana":                  "l03",
  "Panama|Croatia":                 "l04",
  "Croatia|Ghana":                  "l05",
  "Panama|England":                 "l06",
};

// Alternative spellings the API might use
const ALIASES = {
  "USA":                      "United States",
  "US":                       "United States",
  "Curacao":                  "Curaçao",
  "Côte d'Ivoire":            "Ivory Coast",
  "DR Congo":                 "Congo DR",
  "Congo, DR":                "Congo DR",
  "Bosnia and Herzegovina":   "Bosnia-Herzegovina",
  "Bosnia & Herzegovina":     "Bosnia-Herzegovina",
  "Korea Republic":           "South Korea",
  "Republic of Korea":        "South Korea",
  "Czechia":                  "Czech Republic",
  "Czech Rep.":               "Czech Republic",
  "IR Iran":                  "Iran",
  "New Zealand":              "New Zealand",
  "Saudi Arabia":             "Saudi Arabia",
  "Cape Verde":               "Cape Verde",
  "Cabo Verde":               "Cape Verde",
};

function normalise(name) {
  return ALIASES[name] || name;
}

function lookupMatchId(home, away) {
  const h = normalise(home);
  const a = normalise(away);
  return MATCH_MAP[`${h}|${a}`] || MATCH_MAP[`${a}|${h}`] || null;
}

// ── Fetch completed matches from API ─────────────────────────────────────────
function fetchGames() {
  return new Promise((resolve, reject) => {
    const req = https.get("https://worldcup26.ir/get/games", {
      headers: { "User-Agent": "wc2026-sync/1.0" }
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}\nRaw: ${data.substring(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("API request timed out after 15s"));
    });
  });
}

// ── Main sync logic ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🕐 Sync started: ${new Date().toISOString()}`);
  console.log("📡 Fetching from worldcup26.ir...");

  let raw;
  try {
    raw = await fetchGames();
  } catch (e) {
    console.error(`❌ Fetch failed: ${e.message}`);
    process.exit(1);
  }

  // API may return array or wrapped object
  const games = Array.isArray(raw) ? raw
    : (raw.games || raw.matches || raw.data || raw.results || []);

  console.log(`📊 Got ${games.length} total matches from API`);

  const FINISHED_STATUSES = ["completed","finished","ft","full time","ended","complete","played"];

  let updated  = 0;
  let skipped  = 0;
  let noMatch  = 0;
  const batch  = db.batch();
  const logged = [];

  for (const m of games) {
    // Check match is finished
    const status = (m.status || m.state || m.match_status || "").toLowerCase().trim();
    const isFinished = FINISHED_STATUSES.some(s => status.includes(s));
    if (!isFinished) { skipped++; continue; }

    // Extract scores — handle multiple API field name formats
    const hg = m.homeScore  ?? m.home_score  ?? m.score1
            ?? m.goals_home ?? m.home_goals  ?? m.hs ?? null;
    const ag = m.awayScore  ?? m.away_score  ?? m.score2
            ?? m.goals_away ?? m.away_goals  ?? m.as ?? null;

    if (hg === null || hg === undefined || ag === null || ag === undefined) {
      skipped++; continue;
    }
    if (isNaN(Number(hg)) || isNaN(Number(ag))) { skipped++; continue; }

    // Extract team names — handle multiple formats
    const home = m.homeTeam?.name || m.home_team?.name || m.home_team
              || m.team1?.name    || m.home            || m.team_home
              || m.hometeam       || "";
    const away = m.awayTeam?.name || m.away_team?.name || m.away_team
              || m.team2?.name    || m.away            || m.team_away
              || m.awayteam       || "";

    if (!home || !away) { skipped++; continue; }

    // Map to Firestore document ID
    const mid = lookupMatchId(home, away);
    if (!mid) {
      console.log(`  ⚠️  No match ID: "${home}" vs "${away}" (status: ${status})`);
      noMatch++;
      continue;
    }

    // Write to batch
    batch.set(db.collection("results").doc(mid), {
      hg:       Number(hg),
      ag:       Number(ag),
      syncedAt: new Date().toISOString(),
      source:   "worldcup26.ir",
    });

    const line = `  ✅ ${mid.padEnd(4)} ${home} ${hg}–${ag} ${away}`;
    console.log(line);
    logged.push(line);
    updated++;
  }

  // Commit all results in one Firestore batch write
  if (updated > 0) {
    await batch.commit();
    console.log(`\n✅ Committed ${updated} result(s) to Firestore`);
  } else {
    console.log("\nℹ️  No new completed results to write");
  }

  // Write sync metadata to Firestore so Admin tab can show last-sync time
  await db.collection("meta").doc("syncStatus").set({
    lastSync:  new Date().toISOString(),
    updated,
    skipped,
    noMatch,
    source:    "github-actions",
    log:       logged,
  }, { merge: true });

  console.log(`📈 Summary: ${updated} written, ${skipped} skipped, ${noMatch} unmapped`);
  console.log(`🕐 Sync complete: ${new Date().toISOString()}\n`);
}

main().catch(e => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});
