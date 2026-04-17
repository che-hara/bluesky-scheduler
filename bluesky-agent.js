import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BLUESKY_USERNAME = process.env.BLUESKY_USERNAME;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;

const client = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// ============================================================================
// BLUESKY API HELPERS
// ============================================================================

let blueskySession = null;

async function blueskyLogin() {
  const response = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: BLUESKY_USERNAME,
      password: BLUESKY_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Bluesky login failed: ${response.statusText}`);
  }

  blueskySession = await response.json();
  console.log("✓ Logged into Bluesky");
  return blueskySession;
}

async function postToBluesky(text) {
  if (!blueskySession) {
    await blueskyLogin();
  }

  // Validate text length (Bluesky limit is 300 chars)
  if (text.length > 300) {
    text = text.substring(0, 297) + "...";
  }

  const response = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${blueskySession.accessJwt}`,
    },
    body: JSON.stringify({
      repo: blueskySession.did,
      collection: "app.bsky.feed.post",
      record: {
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to post to Bluesky: ${error}`);
  }

  const result = await response.json();
  console.log(`✓ Posted to Bluesky: "${text}"`);
  return result;
}

// ============================================================================
// MLB DATA FETCHING
// ============================================================================

async function findBlueJaysGameToday() {
  const today = new Date().toISOString().split("T")[0];
  const response = await fetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}`
  );
  const data = await response.json();

  // Find Blue Jays game
  const bjGames = data.dates[0]?.games || [];
  const blueJaysGame = bjGames.find(
    (game) => game.teams.away.team.name === "Toronto Blue Jays" || 
              game.teams.home.team.name === "Toronto Blue Jays"
  );

  return blueJaysGame;
}

async function getGamePlayByPlay(gameId) {
  try {
    const response = await fetch(
      `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
    );
    if (!response.ok) {
      console.log(`⏳ Play-by-play not ready (HTTP ${response.status})`);
      return [];
    }
    const data = await response.json();
    return data.allPlays || [];
  } catch (error) {
    console.error("Error fetching play-by-play:", error.message);
    return [];
  }
}

async function getGameLiveData(gameId) {
  try {
    const response = await fetch(`https://statsapi.mlb.com/api/v1/game/${gameId}`);
    const data = await response.json();
    // Return data if it has the basic structure we need
    if (data && data.gameData && data.liveData) {
      return data;
    }
    // Also try returning if we at least have gameData
    if (data && data.gameData) {
      console.log("⚠️ Limited game data available (liveData not ready)");
      return data;
    }
    return null;
  } catch (error) {
    console.error("Error fetching game data:", error.message);
    return null;
  }
}

// ============================================================================
// SENTIMENT ANALYSIS (Twitter/X simulation)
// ============================================================================

async function fetchLiveSentiment() {
  // In production, you'd use Twitter API or a sentiment API
  // For now, we'll simulate sentiment from sports news APIs
  try {
    const response = await fetch(
      "https://api.sportsdata.io/v3/mlb/scores/json/NewsHeadlinesByTeamID?teamID=26&key=DEMO_KEY"
    );
    if (response.ok) {
      const headlines = await response.json();
      return headlines.slice(0, 3).map((h) => h.headline || h.title);
    }
  } catch (e) {
    console.log("Note: Real sentiment requires API keys");
  }
  return ["Game in progress", "Blue Jays playing today"];
}

// ============================================================================
// CLAUDE AI AGENT - GENERATES SMART POSTS
// ============================================================================

async function generateBlueskyPost(gameState, recentPlays, sentimentData) {
  const prompt = `You are a witty, knowledgeable Toronto Blue Jays fan posting live updates to Bluesky during a game.

GAME STATE:
- Status: ${gameState.status}
- Blue Jays Score: ${gameState.blueJaysScore}
- Opponent Score: ${gameState.opponentScore}
- Opponent: ${gameState.opponent}
- Inning: ${gameState.inning}

RECENT PLAYS (last 3):
${recentPlays.map((p) => `- ${p}`).join("\n")}

LIVE SENTIMENT:
${sentimentData.map((s) => `- ${s}`).join("\n")}

Generate a SHORT, ENGAGING Bluesky post (max 300 characters) about the current game state. 
Be enthusiastic, use baseball emojis, and reference actual plays when possible. 
Keep it conversational and fun. NO HASHTAGS.

Respond with ONLY the post text, nothing else.`;

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return message.content[0].type === "text" ? message.content[0].text : "";
}

// ============================================================================
// GAME STATE PARSER
// ============================================================================

function parseGameState(gameData, playByPlayData) {
  const liveData = gameData.liveData;
  const gameStatus = gameData.gameData.status.abstractGameState;

  const awayTeam = gameData.gameData.teams.away;
  const homeTeam = gameData.gameData.teams.home;

  const isAwayBlueJays = awayTeam.name === "Toronto Blue Jays";
  const blueJaysTeam = isAwayBlueJays ? awayTeam : homeTeam;
  const opponentTeam = isAwayBlueJays ? homeTeam : awayTeam;

  const blueJaysScore = isAwayBlueJays
    ? liveData.linescore.teams.away.runs
    : liveData.linescore.teams.home.runs;

  const opponentScore = isAwayBlueJays
    ? liveData.linescore.teams.home.runs
    : liveData.linescore.teams.away.runs;

  const inning = liveData.linescore.currentInning || 0;
  const isTopInning = liveData.linescore.inningState === "Top";

  // Extract recent plays (last 3)
  const recentPlays = playByPlayData
    .slice(-3)
    .map((play) => {
      const description = play.result.description;
      const player = play.player?.person?.fullName || "Unknown";
      return `${player}: ${description}`;
    });

  return {
    status: gameStatus,
    blueJaysScore,
    opponentScore,
    opponent: opponentTeam.name,
    inning: `${inning} ${isTopInning ? "(T)" : "(B)"}`,
    recentPlays,
  };
}

// ============================================================================
// MAIN AGENT LOOP
// ============================================================================

async function runBlueJaysAgent() {
  console.log("🤖 Toronto Blue Jays Bluesky Agent Started");

  try {
    // Find today's Blue Jays game
    console.log("🔍 Looking for Blue Jays game today...");
    const game = await findBlueJaysGameToday();

    if (!game) {
      console.log("No Blue Jays game found today");
      return;
    }

    const gameId = game.gameId || game.id;
    console.log(`✓ Found game: ${game.teams.away.team.name} @ ${game.teams.home.team.name}`);

    // Poll game data periodically (every 5 minutes during game)
    let lastPlayCount = 0;
    let postCount = 0;
    const maxPosts = 5; // Limit posts to avoid spam

    const pollInterval = setInterval(async () => {
      try {
        // Fetch current game state
        const gameData = await getGameLiveData(gameId);
        if (!gameData) {
          console.log("⏳ Waiting for live game data...");
          return;
        }
        
        console.log("✓ Game data received");


        const status = gameData.gameData.status.abstractGameState;
        if (status === "Final" || status === "Completed Early") {
          console.log("🏁 Game finished!");
          clearInterval(pollInterval);
          return;
        }

        // Get play-by-play data
        const playByPlay = await getGamePlayByPlay(gameId);
        const currentPlayCount = playByPlay.length;

        // Only post if there are new plays
        if (currentPlayCount > lastPlayCount && postCount < maxPosts) {
          console.log(`\n📊 New play detected (${currentPlayCount} total plays)`);

          // Parse game state
          const gameState = parseGameState(gameData, playByPlay);

          // Fetch live sentiment
          const sentiment = await fetchLiveSentiment();

          // Generate and post
          const post = await generateBlueskyPost(
            gameState,
            gameState.recentPlays,
            sentiment
          );

          if (post) {
            await postToBluesky(post);
            postCount++;
            lastPlayCount = currentPlayCount;
          }
        }
      } catch (error) {
        console.error("Error in poll cycle:", error.message);
      }
    }, 300000); // Poll every 5 minutes
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// ============================================================================
// EXECUTION
// ============================================================================

runBlueJaysAgent().catch(console.error);
