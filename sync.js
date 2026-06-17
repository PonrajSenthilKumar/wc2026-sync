/**
 * WC2026 Auto-Sync Script
 * Fetches completed match results from worldcup26.ir (free, no API key)
 * and writes them to Firebase Firestore.
 */

const https  = require("https");
const admin  = require("firebase-admin");

// ── Firebase init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
});
const db = admin.firestore();

// ── Match ID mapping ──────────────────────────────────────────────────────────
const MATCH_MAP = {
  "Mexico|South Africa":"a01","South Korea|Czech Republic":"a02",
  "Czech Republic|South Africa":"a03","Mexico|South Korea":"a04",
  "Czech Republic|Mexico":"a05","South Africa|South Korea":"a06",
  "Canada|Bosnia-Herzegovina":"b01","Qatar|Switzerland":"b02",
  "Switzerland|Bosnia-Herzegovina":"b03","Canada|Qatar":"b04",
  "Bosnia-Herzegovina|Qatar":"b05","Switzerland|Canada":"b06",
  "Brazil|Morocco":"c01","Haiti|Scotland":"c02",
  "Scotland|Morocco":"c03","Brazil|Haiti":"c04",
  "Morocco|Haiti":"c05","Scotland|Brazil":"c06",
  "United States|Paraguay":"d01","Australia|Turkey":"d02",
  "United States|Australia":"d03","Turkey|Paraguay":"d04",
  "Paraguay|Australia":"d05","Turkey|United States":"d06",
  "Germany|Curaçao":"e01","Ivory Coast|Ecuador":"e02",
  "Germany|Ivory Coast":"e03","Ecuador|Curaçao":"e04",
  "Curaçao|Ivory Coast":"e05","Ecuador|Germany":"e06",
  "Netherlands|Japan":"f01","Sweden|Tunisia":"f02",
  "Netherlands|Sweden":"f03","Tunisia|Japan":"f04",
  "Japan|Sweden":"f05","Tunisia|Netherlands":"f06",
  "Belgium|Egypt":"g01","Iran|New Zealand":"g02",
  "Belgium|Iran":"g03","New Zealand|Egypt":"g04",
  "Egypt|Iran":"g05","New Zealand|Belgium":"g06",
  "Spain|Cape Verde":"h01","Saudi Arabia|Uruguay":"h02",
  "Spain|Saudi Arabia":"h03","Uruguay|Cape Verde":"h04",
  "Cape Verde|Saudi Arabia":"h05","Uruguay|Spain":"h06",
  "France|Senegal":"i01","Iraq|Norway":"i02",
  "France|Iraq":"i03","Norway|Senegal":"i04",
  "Norway|France":"i05","Senegal|Iraq":"i06",
  "Argentina|Algeria":"j01","Austria|Jordan":"j02",
  "Argentina|Austria":"j03","Jordan|Algeria":"j04",
  "Algeria|Austria":"j05","Jordan|Argentina":"j06",
  "Portugal|Congo DR":"k01","Uzbekistan|Colombia":"k02",
  "Portugal|Uzbekistan":"k03","Colombia|Congo DR":"k04",
  "Colombia|Portugal":"k05","Congo DR|Uzbekistan":"k06",
  "England|Croatia":"l01","Ghana|Panama":"l02",
  "England|Ghana":"l03","Panama|Croatia":"l04",
  "Croatia|Ghana":"l05","Panama|England":"l06",
};

const ALIASES = {
  "USA":"United States","US":"United States",
  "Curacao":"Curaçao","Côte d'Ivoire":"Ivory Coast",
  "DR Congo":"Congo DR","Congo, DR":"Congo DR",
  "Bosnia and Herzegovina":"Bosnia-Herzegovina",
  "Bosnia & Herzegovina":"Bosnia-Herzegovina",
  "Korea Republic":"South Korea","Republic of Korea":"South Korea",
  "Czechia":"Czech Republic","Czech Rep.":"Czech Republic",
  "IR Iran":"Iran","Cabo Verde":"Cape Verde",
};

function normalise(n){ return ALIASES[n] || n; }
function lookupMatchId(h,a){
  const hn=normalise(h), an=normalise(a);
  return MATCH_MAP[`${hn}|${an}`] || MATCH_MAP[`${an}|${hn}`] || null;
}

// ── Fetch from API ────────────────────────────────────────────────────────────
function fetchGames(){
  return new Promise((resolve,reject)=>{
    const req = https.get("https://worldcup26.ir/get/games",{
      headers:{"User-Agent":"wc2026-sync/1.0"}
    },(res)=>{
      let data="";
      res.on("data",c=>{ data+=c; });
      res.on("end",()=>{
        try{ resolve(JSON.parse(data)); }
        catch(e){ reject(new Error(`JSON parse error: ${e.message}\nRaw: ${data.substring(0,300)}`)); }
      });
    });
    req.on("error",reject);
    req.setTimeout(15000,()=>{ req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  console.log(`\n🕐 Sync started: ${new Date().toISOString()}`);
  console.log("📡 Fetching from worldcup26.ir...");

  let raw;
  try{ raw = await fetchGames(); }
  catch(e){ console.error(`❌ Fetch failed: ${e.message}`); process.exit(1); }

  const games = Array.isArray(raw) ? raw
    : (raw.games || raw.matches || raw.data || raw.results || []);

  console.log(`📊 Got ${games.length} total matches from API`);

  // ── DEBUG: dump first 2 raw match objects so we can see ALL field names ──────
  console.log("\n🔍 RAW first 2 matches from API:");
  console.log(JSON.stringify(games.slice(0,2), null, 2));
  console.log("\n🔍 ALL keys in first match:", Object.keys(games[0]||{}));
  // ── END DEBUG ────────────────────────────────────────────────────────────────

  // Try every reasonable finished-status pattern
  const FINISHED = [
    "completed","finished","ft","full time","fulltime",
    "ended","complete","played","result","done",
    "full_time","post","fim","finalizado","terminado","1"
  ];

  let updated=0, skipped=0, noMatch=0;
  const batch = db.batch();
  const logged = [];

  for(const m of games){
    // Get status — try every known field name
    const rawStatus = (
      m.status ?? m.state ?? m.match_status ?? m.matchStatus ??
      m.statusCode ?? m.gameStatus ?? ""
    ).toString().toLowerCase().trim();

    // Check scores exist and are numbers — if scores present and non-null, treat as finished
    const hg = m.homeScore  ?? m.home_score  ?? m.score1
             ?? m.goals_home ?? m.home_goals  ?? m.hs ?? null;
    const ag = m.awayScore  ?? m.away_score  ?? m.score2
             ?? m.goals_away ?? m.away_goals  ?? m.as ?? null;

    const scoresPresent = hg !== null && hg !== undefined &&
                          ag !== null && ag !== undefined &&
                          !isNaN(Number(hg)) && !isNaN(Number(ag));

    const statusFinished = FINISHED.some(s => rawStatus.includes(s));

    // Accept match if EITHER status says finished OR scores are present and non-zero context
    const isFinished = statusFinished || (scoresPresent && rawStatus !== "scheduled"
      && rawStatus !== "upcoming" && rawStatus !== "fixture"
      && rawStatus !== "ns" && rawStatus !== "tbd" && rawStatus !== "0" && rawStatus !== "");

    if(!isFinished){ skipped++; continue; }
    if(!scoresPresent){ skipped++; continue; }

    // Extract team names
    const home = m.homeTeam?.name || m.home_team?.name || m.home_team
               || m.team1?.name   || m.home            || m.hometeam || "";
    const away = m.awayTeam?.name || m.away_team?.name || m.away_team
               || m.team2?.name   || m.away            || m.awayteam || "";

    if(!home || !away){ skipped++; continue; }

    const mid = lookupMatchId(home, away);
    if(!mid){
      console.log(`  ⚠️  No match ID: "${home}" vs "${away}" (status: ${rawStatus})`);
      noMatch++; continue;
    }

    batch.set(db.collection("results").doc(mid),{
      hg: Number(hg), ag: Number(ag),
      syncedAt: new Date().toISOString(),
      source: "worldcup26.ir",
    });

    const line = `  ✅ ${mid.padEnd(4)} ${home} ${hg}–${ag} ${away}`;
    console.log(line);
    logged.push(line);
    updated++;
  }

  if(updated > 0){
    await batch.commit();
    console.log(`\n✅ Committed ${updated} result(s) to Firestore`);
  } else {
    console.log("\nℹ️  No completed results found");
  }

  await db.collection("meta").doc("syncStatus").set({
    lastSync:  new Date().toISOString(),
    updated, skipped, noMatch,
    source:    "github-actions",
    log:       logged,
  },{ merge:true });

  console.log(`📈 Summary: ${updated} written, ${skipped} skipped, ${noMatch} unmapped`);
  console.log(`🕐 Sync complete: ${new Date().toISOString()}\n`);
}

main().catch(e=>{ console.error("❌ Fatal:",e); process.exit(1); });
