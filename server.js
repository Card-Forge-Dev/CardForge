const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "18mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const VERSION = "V13";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;

const EBAY_ENDPOINT =
  "https://cardforge-0s37.onrender.com/api/ebay/account-deletion";

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

let ebayToken = null;
let ebayTokenExpiry = 0;

console.log(`CardForge ${VERSION} starting on ${PORT}`);
console.log(
  `OpenAI configured: ${!!OPENAI_API_KEY}; eBay configured: ${!!(
    EBAY_APP_ID && EBAY_CERT_ID
  )}`
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    openAIConfigured: !!OPENAI_API_KEY,
    ebayConfigured: !!(EBAY_APP_ID && EBAY_CERT_ID),
  });
});

/* eBay account deletion verification endpoint */

app.get("/api/ebay/account-deletion", (req, res) => {
  const challenge = req.query.challenge_code;

  if (!challenge) {
    return res.status(200).send("CardForge eBay endpoint active.");
  }

  if (!EBAY_VERIFICATION_TOKEN) {
    return res.status(500).send("Verification token not configured.");
  }

  try {
    const hash = crypto.createHash("sha256");

    hash.update(String(challenge));
    hash.update(EBAY_VERIFICATION_TOKEN);
    hash.update(EBAY_ENDPOINT);

    console.log("eBay endpoint verification challenge received.");

    return res.status(200).json({
      challengeResponse: hash.digest("hex"),
    });
  } catch (error) {
    console.error("eBay verification error:", error.message);

    return res.status(500).send("Verification failed.");
  }
});

app.post("/api/ebay/account-deletion", (_req, res) => {
  console.log("eBay account deletion notification received.");
  res.status(200).send("OK");
});

/* eBay authentication */

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry - 60000) {
    return ebayToken;
  }

  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    throw new Error("eBay credentials are not configured.");
  }

  const basic = Buffer.from(
    `${EBAY_APP_ID}:${EBAY_CERT_ID}`
  ).toString("base64");

  const response = await fetch(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=client_credentials&scope=" +
        encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = { message: raw };
  }

  if (!response.ok) {
    console.error("eBay OAuth error:", data);

    throw new Error(
      `eBay authentication failed (${response.status}). Check server credentials.`
    );
  }

  ebayToken = data.access_token;

  ebayTokenExpiry =
    Date.now() + (Number(data.expires_in) || 7200) * 1000;

  return ebayToken;
}

/* Search active eBay listings */

async function searchEbay(query) {
  const token = await getEbayToken();

  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search" +
    `?q=${encodeURIComponent(query)}&limit=25&sort=price&autocorrect=true`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.error(`eBay search ${response.status} for "${query}"`, data);

    throw new Error(`eBay search failed (${response.status})`);
  }

  return Array.isArray(data.itemSummaries)
    ? data.itemSummaries
    : [];
}

/* Card identification and listing matching */

const norm = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stopWords = new Set([
  "the",
  "a",
  "an",
  "card",
  "cards",
  "trading",
  "tcg",
  "collectible",
  "base",
  "rookie",
  "new",
  "rare",
  "of",
  "and",
]);

const useful = (value) =>
  norm(value)
    .split(" ")
    .filter((token) => token.length > 1 && !stopWords.has(token));

const hasPhrase = (text, value) =>
  !!norm(value) && (` ${text} `).includes(` ${norm(value)} `);

function buildQueries(card) {
  const candidates = [
    [card.player, card.cardNumber],
    [card.cardName, card.cardNumber],
    [card.cardName, card.set, card.cardNumber],
    [card.player, card.insert, card.cardNumber],
    [card.player, card.parallel, card.cardNumber],
    [card.manufacturer, card.year, card.cardName],
    [card.year, card.set, card.cardName],
    [card.franchise, card.cardName, card.cardNumber],
    [card.series, card.cardName, card.cardNumber],
    [card.player, card.set],
    [card.cardName, card.set],
    [card.franchise, card.cardName],
    [card.team, card.player, card.cardNumber],
  ]
    .map((parts) =>
      parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
    )
    .filter(Boolean);

  return [
    ...new Map(candidates.map((query) => [norm(query), query])).values(),
  ].slice(0, 8);
}

function scoreListing(item, card) {
  const title = norm(item.title);
  const text = norm(
    `${item.title || ""} ${item.shortDescription || ""} ${
      item.condition || ""
    }`
  );

  let score = 0;
  const reasons = [];

  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };

  const player = norm(card.player);
  const cardName = norm(card.cardName);
  const number = norm(card.cardNumber);

  if (player) {
    hasPhrase(title, player)
      ? add(28, "name matched")
      : add(-28, "name not explicit");
  }

  if (number) {
    const compactNumber = number.replace(/[^a-z0-9]/g, "");
    const compactTitle = title.replace(/[^a-z0-9]/g, "");

    if (
      compactNumber.length >= 2 &&
      compactTitle.includes(compactNumber)
    ) {
      add(28, "card number matched");
    }
  }

  const nameTokens = useful(cardName);

  if (nameTokens.length) {
    const ratio =
      nameTokens.filter((token) => title.includes(token)).length /
      nameTokens.length;

    if (ratio >= 0.8) {
      add(22, "card name matched");
    } else if (ratio >= 0.5) {
      add(9, "partial card name");
    } else if (nameTokens.length > 1) {
      add(-12, "card name mismatch");
    }
  }

  const setTokens = useful(card.set);

  if (setTokens.length) {
    const ratio =
      setTokens.filter((token) => title.includes(token)).length /
      setTokens.length;

    if (ratio >= 0.75) {
      add(15, "set matched");
    } else if (ratio >= 0.5) {
      add(6, "partial set");
    }
  }

  if (card.manufacturer && hasPhrase(title, card.manufacturer)) {
    add(7, "manufacturer matched");
  }

  if (card.year && title.includes(norm(card.year))) {
    add(7, "year matched");
  }

  if (card.parallel && hasPhrase(title, card.parallel)) {
    add(16, "parallel matched");
  }

  if (card.insert && hasPhrase(title, card.insert)) {
    add(14, "insert matched");
  }

  if (card.franchise && hasPhrase(title, card.franchise)) {
    add(12, "franchise matched");
  }

  const suspiciousTerms = [
    "custom",
    "proxy",
    "reprint",
    "replica",
    "facsimile",
    "digital card",
    "empty box",
    "display only",
    "photo print",
    "you pick",
    "pick your card",
  ];

  for (const term of suspiciousTerms) {
    if (text.includes(term)) {
      add(-28, `possible mismatch: ${term}`);
    }
  }

  if (
    /\b(lot of|card lot|multiple cards|10 card|20 card|50 card)\b/.test(
      title
    )
  ) {
    add(-25, "possible lot listing");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

async function searchEbayListings(card) {
  const queries = buildQueries(card);

  console.log("V13 eBay queries:", queries);

  const batches = await Promise.all(
    queries.map(async (query) => {
      try {
        return await searchEbay(query);
      } catch (error) {
        console.error(`Query failed "${query}": ${error.message}`);
        return [];
      }
    })
  );

  const unique = new Map();

  for (const item of batches.flat()) {
    const key = item.itemId || item.itemWebUrl || item.title;

    if (key && !unique.has(key)) {
      unique.set(key, item);
    }
  }

  return [...unique.values()]
    .map((item) => ({
      item,
      match: scoreListing(item, card),
    }))
    .filter((entry) => entry.match.score >= 48)
    .sort(
      (a, b) =>
        b.match.score - a.match.score ||
        (Number(a.item.price?.value) || Infinity) -
          (Number(b.item.price?.value) || Infinity)
    )
    .slice(0, 30)
    .map(({ item, match }) => ({
      title: item.title || "eBay listing",
      price: item.price?.value || null,
      currency: item.price?.currency || "USD",
      priceDisplay: item.price
        ? `${item.price.value} ${item.price.currency || "USD"}`
        : "Price unavailable",
      image:
        item.image?.imageUrl ||
        item.thumbnailImages?.[0]?.imageUrl ||
        null,
      url: item.itemWebUrl || item.itemHref || null,
      condition: item.condition || "Unknown",
      itemId: item.itemId || null,
      matchScore: match.score,
      matchReasons: match.reasons,
    }));
}

/* AI card identification */

async function identifyCard(frontImage, backImage) {
  const prompt = `Identify this collectible card from the supplied front photo and optional back photo. Do not guess facts, condition grades, or value. Use empty strings when unsure. Return only JSON:
{
 "cardName":"","player":"","team":"","franchise":"","set":"","series":"","manufacturer":"","year":"","cardNumber":"",
 "insert":"","parallel":"","rarity":"","cardType":"","sport":"","category":"",
 "autograph":false,"relic":false,"rookie":false,"confidence":0,"identificationNotes":"",
 "visibleEvidence":[""],"alternatives":[{"candidate":"","whyItCouldFit":"","whatWouldConfirmIt":""}],
 "conditionObservations":[{"area":"corners/edges/surface/centering","observation":"","certainty":"low/medium/high"}],
 "conditionLimitations":""
}
Use category for broad TCG/sports/entertainment category. Evidence: 1-5 short observations grounded in visible details. At most 3 plausible alternatives. Condition observations must describe only visible features; if photo quality is insufficient, say so. Never predict a PSA/BGS/CGC grade or claim authenticity. Confidence is identification confidence, 0-100. No market value.`;

  const content = [
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: { url: frontImage },
    },
  ];

  if (backImage) {
    content.push({
      type: "image_url",
      image_url: { url: backImage },
    });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content,
      },
    ],
    max_tokens: 1600,
  });

  const raw = response.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error("AI did not return card information.");
  }

  const card = JSON.parse(raw);

  card.confidence = Math.max(
    0,
    Math.min(100, Number(card.confidence) || 0)
  );

  for (const key of [
    "visibleEvidence",
    "alternatives",
    "conditionObservations",
  ]) {
    card[key] = Array.isArray(card[key])
      ? card[key].slice(0, key === "visibleEvidence" ? 5 : 8)
      : [];
  }

  card.alternatives = card.alternatives.slice(0, 3);

  return card;
}

/* Active asking-price summary */

function priceSummary(listings) {
  const values = listings
    .map((listing) => Number(listing.price))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  if (!values.length) {
    return {
      listingCount: listings.length,
      pricedListingCount: 0,
      low: null,
      median: null,
      high: null,
      basis:
        "Active asking prices only; not sold prices or an appraisal.",
    };
  }

  const middle = Math.floor(values.length / 2);

  const median =
    values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2;

  return {
    listingCount: listings.length,
    pricedListingCount: values.length,
    low: values[0],
    median: Number(median.toFixed(2)),
    high: values[values.length - 1],
    basis:
      "Range and median of matched active eBay asking prices, not completed sales or an appraisal.",
  };
}

/* Main card-analysis endpoint */

app.post("/api/analyze-card", async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({
        error: "OpenAI is not configured on the server.",
      });
    }

    const { frontImage, backImage } = req.body || {};

    if (
      typeof frontImage !== "string" ||
      !frontImage.startsWith("data:image/")
    ) {
      return res.status(400).json({
        error: "A valid front image is required.",
      });
    }

    if (
      backImage &&
      (typeof backImage !== "string" ||
        !backImage.startsWith("data:image/"))
    ) {
      return res.status(400).json({
        error: "The back image must be a valid image.",
      });
    }

    console.log("Starting CardForge V13 analysis.");

    const card = await identifyCard(frontImage, backImage);

    let ebayListings = [];
    let ebayError = null;

    if (EBAY_APP_ID && EBAY_CERT_ID) {
      try {
        ebayListings = await searchEbayListings(card);
      } catch (error) {
        ebayError =
          "eBay search could not be completed. Check server logs.";

        console.error("eBay search failed:", error.message);
      }
    } else {
      ebayError = "eBay credentials are not configured on the server.";
    }

    res.json({
      success: true,
      version: VERSION,
      card,
      ebayListings,
      priceSummary: priceSummary(ebayListings),
      ebayError,
    });
  } catch (error) {
    console.error("CardForge analysis error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Something went wrong analyzing the card.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CardForge ${VERSION} listening on ${PORT}`);
});