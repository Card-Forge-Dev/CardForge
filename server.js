const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;

const EBAY_ENDPOINT =
    "https://cardforge-0s37.onrender.com/api/ebay/account-deletion";

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

let ebayAccessToken = null;
let ebayTokenExpiresAt = 0;

console.log("");
console.log("======================================");
console.log("          CARDFORGE V12 BACKEND");
console.log("======================================");
console.log(`Server running on port ${PORT}`);
console.log(`AI model: gpt-4.1-mini`);
console.log(`eBay configured: ${!!(EBAY_APP_ID && EBAY_CERT_ID)}`);
console.log(
    `eBay verification configured: ${!!EBAY_VERIFICATION_TOKEN}`
);
console.log(`eBay endpoint: ${EBAY_ENDPOINT}`);
console.log("======================================");
console.log("");


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        version: "V12",
        ebayConfigured: !!(EBAY_APP_ID && EBAY_CERT_ID)
    });
});


// ============================================================
// EBAY ACCOUNT DELETION / ENDPOINT VERIFICATION
// ============================================================

app.get("/api/ebay/account-deletion", (req, res) => {
    const challengeCode = req.query.challenge_code;

    if (!challengeCode) {
        return res.status(200).send("CardForge eBay endpoint active.");
    }

    if (!EBAY_VERIFICATION_TOKEN) {
        return res.status(500).send("Verification token not configured.");
    }

    try {
        const hash = crypto.createHash("sha256");

        hash.update(challengeCode);
        hash.update(EBAY_VERIFICATION_TOKEN);
        hash.update(EBAY_ENDPOINT);

        const challengeResponse = hash.digest("hex");

        console.log("eBay endpoint verification challenge received.");

        res.status(200).json({
            challengeResponse
        });
    } catch (error) {
        console.error("eBay verification error:", error);

        res.status(500).send("Verification failed.");
    }
});


app.post("/api/ebay/account-deletion", (req, res) => {
    console.log("eBay account deletion notification received.");

    res.status(200).send("OK");
});


// ============================================================
// EBAY OAUTH
// ============================================================

async function getEbayAccessToken() {
    if (
        ebayAccessToken &&
        Date.now() < ebayTokenExpiresAt - 60 * 1000
    ) {
        return ebayAccessToken;
    }

    if (!EBAY_APP_ID || !EBAY_CERT_ID) {
        throw new Error("eBay credentials are not configured.");
    }

    console.log("Getting new eBay application access token...");

    const credentials = Buffer.from(
        `${EBAY_APP_ID}:${EBAY_CERT_ID}`
    ).toString("base64");

    const response = await fetch(
        "https://api.ebay.com/identity/v1/oauth2/token",
        {
            method: "POST",
            headers: {
                Authorization: `Basic ${credentials}`,
                "Content-Type":
                    "application/x-www-form-urlencoded"
            },
            body:
                "grant_type=client_credentials" +
                "&scope=" +
                encodeURIComponent(
                    "https://api.ebay.com/oauth/api_scope"
                )
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error("eBay OAuth error:", data);
        throw new Error(
            data.error_description ||
            "eBay authentication failed."
        );
    }

    ebayAccessToken = data.access_token;

    ebayTokenExpiresAt =
        Date.now() +
        (Number(data.expires_in) || 7200) * 1000;

    console.log("eBay access token obtained successfully.");

    return ebayAccessToken;
}


// ============================================================
// EBAY SEARCH
// ============================================================

async function searchEbaySingle(query, limit = 30) {
    const token = await getEbayAccessToken();

    console.log(`eBay search: ${query}`);

    const url =
        "https://api.ebay.com/buy/browse/v1/item_summary/search" +
        `?q=${encodeURIComponent(query)}` +
        `&limit=${limit}` +
        "&autocorrect=true";

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"
        }
    });

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = {
            raw: text
        };
    }

    console.log(
        `eBay response status: ${response.status}`
    );

    if (!response.ok) {
        console.error("eBay search error:", data);

        throw new Error(
            `eBay search failed with status ${response.status}`
        );
    }

    const count =
        Array.isArray(data.itemSummaries)
            ? data.itemSummaries.length
            : 0;

    console.log(
        `eBay results for "${query}": ${count}`
    );

    return data.itemSummaries || [];
}


// ============================================================
// NORMALIZE TEXT
// ============================================================

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}


// ============================================================
// TOKENIZE
// ============================================================

function tokenize(value) {
    return normalizeText(value)
        .split(" ")
        .filter(Boolean);
}


// ============================================================
// REMOVE GENERIC WORDS
// ============================================================

const STOP_WORDS = new Set([
    "the",
    "a",
    "an",
    "card",
    "cards",
    "trading",
    "tcg",
    "collectible",
    "collectibles",
    "base",
    "rc",
    "rookie",
    "mint",
    "gem",
    "rare",
    "new",
    "hot",
    "🔥"
]);

function usefulTokens(value) {
    return tokenize(value).filter(
        token =>
            token.length > 1 &&
            !STOP_WORDS.has(token)
    );
}


// ============================================================
// BUILD SEARCH QUERIES
// ============================================================

function buildEbayQueries(card) {
    const queries = [];

    const year = card.year || "";
    const manufacturer = card.manufacturer || "";
    const setName = card.set || "";
    const cardName = card.cardName || "";
    const cardNumber = card.cardNumber || "";
    const player = card.player || "";
    const team = card.team || "";
    const parallel = card.parallel || "";
    const insert = card.insert || "";
    const franchise = card.franchise || "";
    const series = card.series || "";

    function add(parts) {
        const clean = parts
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

        if (!clean) return;

        const normalized = normalizeText(clean);

        if (!queries.some(q => normalizeText(q) === normalized)) {
            queries.push(clean);
        }
    }

    // Strongest exact identifiers first
    add([cardName, cardNumber]);
    add([player, cardNumber]);
    add([cardName, setName, cardNumber]);

    // Insert / parallel specific
    add([player, insert, cardNumber]);
    add([player, parallel, cardNumber]);
    add([cardName, insert, parallel]);

    // Set / manufacturer
    add([manufacturer, setName, cardName]);
    add([year, manufacturer, setName, cardName]);

    // Sports fallback
    add([player, team, setName]);
    add([player, setName]);

    // Non-sports fallback
    add([franchise, cardName, cardNumber]);
    add([series, cardName, cardNumber]);
    add([setName, cardNumber]);

    // Final identity searches
    add([player, cardName]);
    add([franchise, cardName]);
    add([setName, cardName]);

    return queries.slice(0, 8);
}


// ============================================================
// LISTING TEXT
// ============================================================

function getListingText(item) {
    return normalizeText(
        [
            item.title,
            item.shortDescription,
            item.subtitle,
            item.condition
        ]
            .filter(Boolean)
            .join(" ")
    );
}


// ============================================================
// CHECK WHETHER A PHRASE EXISTS
// ============================================================

function containsPhrase(text, value) {
    const normalized = normalizeText(value);

    if (!normalized) {
        return false;
    }

    return text.includes(normalized);
}


// ============================================================
// SCORE EBAY LISTING
// ============================================================

function scoreEbayListing(item, card) {
    const titleText = normalizeText(item.title);
    const listingText = getListingText(item);

    let score = 0;

    const reasons = [];

    const player = normalizeText(card.player);
    const cardName = normalizeText(card.cardName);
    const setName = normalizeText(card.set);
    const manufacturer = normalizeText(card.manufacturer);
    const cardNumber = normalizeText(card.cardNumber);
    const year = normalizeText(card.year);
    const team = normalizeText(card.team);
    const parallel = normalizeText(card.parallel);
    const insert = normalizeText(card.insert);
    const franchise = normalizeText(card.franchise);
    const series = normalizeText(card.series);

    // --------------------------------------------------------
    // PLAYER
    // --------------------------------------------------------

    if (player) {
        if (containsPhrase(titleText, player)) {
            score += 35;
            reasons.push("player");
        } else {
            // A known player is critical.
            score -= 35;
            reasons.push("missing player");
        }
    }

    // --------------------------------------------------------
    // CARD NUMBER
    // --------------------------------------------------------

    if (cardNumber) {
        const numberClean = cardNumber
            .replace(/[^a-z0-9]/gi, "")
            .toLowerCase();

        const titleCompact = titleText
            .replace(/[^a-z0-9]/g, "");

        if (
            titleCompact.includes(numberClean)
        ) {
            score += 30;
            reasons.push("card number");
        }
    }

    // --------------------------------------------------------
    // CARD NAME
    // --------------------------------------------------------

    if (cardName) {
        const cardTokens = usefulTokens(cardName);

        let matches = 0;

        for (const token of cardTokens) {
            if (titleText.includes(token)) {
                matches++;
            }
        }

        if (cardTokens.length > 0) {
            const ratio =
                matches / cardTokens.length;

            if (ratio >= 0.8) {
                score += 25;
                reasons.push("card name");
            } else if (ratio >= 0.5) {
                score += 10;
                reasons.push("partial card name");
            } else if (cardTokens.length >= 2) {
                score -= 20;
                reasons.push("weak card name");
            }
        }
    }

    // --------------------------------------------------------
    // SET
    // --------------------------------------------------------

    if (setName) {
        const setTokens = usefulTokens(setName);

        let matches = 0;

        for (const token of setTokens) {
            if (titleText.includes(token)) {
                matches++;
            }
        }

        if (setTokens.length > 0) {
            const ratio =
                matches / setTokens.length;

            if (ratio >= 0.75) {
                score += 20;
                reasons.push("set");
            } else if (ratio >= 0.5) {
                score += 8;
                reasons.push("partial set");
            }
        }
    }

    // --------------------------------------------------------
    // MANUFACTURER
    // --------------------------------------------------------

    if (manufacturer) {
        if (containsPhrase(titleText, manufacturer)) {
            score += 10;
            reasons.push("manufacturer");
        }
    }

    // --------------------------------------------------------
    // YEAR
    // --------------------------------------------------------

    if (year) {
        if (titleText.includes(year)) {
            score += 10;
            reasons.push("year");
        }
    }

    // --------------------------------------------------------
    // TEAM
    // --------------------------------------------------------

    if (team) {
        if (containsPhrase(titleText, team)) {
            score += 8;
            reasons.push("team");
        }
    }

    // --------------------------------------------------------
    // INSERT
    // --------------------------------------------------------

    if (insert) {
        if (containsPhrase(titleText, insert)) {
            score += 20;
            reasons.push("insert");
        }
    }

    // --------------------------------------------------------
    // PARALLEL
    // --------------------------------------------------------

    if (parallel) {
        if (containsPhrase(titleText, parallel)) {
            score += 20;
            reasons.push("parallel");
        }
    }

    // --------------------------------------------------------
    // FRANCHISE
    // --------------------------------------------------------

    if (franchise) {
        if (containsPhrase(titleText, franchise)) {
            score += 15;
            reasons.push("franchise");
        }
    }

    // --------------------------------------------------------
    // SERIES
    // --------------------------------------------------------

    if (series) {
        if (containsPhrase(titleText, series)) {
            score += 12;
            reasons.push("series");
        }
    }

    // --------------------------------------------------------
    // STRONG NEGATIVE SIGNALS
    // --------------------------------------------------------

    const negativeTerms = [
        "lot",
        "reprint",
        "custom",
        "proxy",
        "digital",
        "replica",
        "facsimile",
        "sticker only",
        "empty",
        "display",
        "photo",
        "print"
    ];

    for (const term of negativeTerms) {
        if (listingText.includes(term)) {
            score -= 25;
            reasons.push(`negative:${term}`);
        }
    }

    // --------------------------------------------------------
    // SCORE NORMALIZATION
    // --------------------------------------------------------

    score = Math.max(0, Math.min(100, score));

    return {
        score,
        reasons
    };
}


// ============================================================
// SEARCH EBAY WITH MATCHING
// ============================================================

async function searchEbayListings(card) {
    const queries = buildEbayQueries(card);

    console.log("");
    console.log("======================================");
    console.log("CARD FORGE EBAY V12 SEARCH");
    console.log("======================================");
    console.log("Card:", {
        player: card.player,
        cardName: card.cardName,
        set: card.set,
        cardNumber: card.cardNumber,
        year: card.year,
        manufacturer: card.manufacturer
    });
    console.log("eBay queries:", queries);

    const allResults = [];

    const results = await Promise.all(
        queries.map(async query => {
            try {
                return await searchEbaySingle(
                    query,
                    25
                );
            } catch (error) {
                console.error(
                    `eBay query failed: ${query}`,
                    error.message
                );

                return [];
            }
        })
    );

    for (const result of results) {
        allResults.push(...result);
    }

    console.log(
        `eBay raw results found: ${allResults.length}`
    );

    // --------------------------------------------------------
    // DEDUPE
    // --------------------------------------------------------

    const deduped = new Map();

    for (const item of allResults) {
        const key =
            item.itemId ||
            item.itemWebUrl ||
            item.title;

        if (!key) continue;

        if (!deduped.has(key)) {
            deduped.set(key, item);
        }
    }

    // --------------------------------------------------------
    // SCORE
    // --------------------------------------------------------

    const scored = [];

    for (const item of deduped.values()) {
        const match = scoreEbayListing(
            item,
            card
        );

        scored.push({
            item,
            match
        });
    }

    // --------------------------------------------------------
    // SORT BY MATCH FIRST
    // --------------------------------------------------------

    scored.sort((a, b) => {
        if (b.match.score !== a.match.score) {
            return b.match.score - a.match.score;
        }

        const priceA =
            Number(a.item.price?.value) || 999999;

        const priceB =
            Number(b.item.price?.value) || 999999;

        return priceA - priceB;
    });

    console.log(
        "Top eBay matches:"
    );

    scored
        .slice(0, 15)
        .forEach((entry, index) => {
            console.log(
                `${index + 1}. ${entry.match.score}/100 - ${entry.item.title}`
            );
        });

    // --------------------------------------------------------
    // STRICT FILTER
    // --------------------------------------------------------

    const strongMatches = scored.filter(
        entry => entry.match.score >= 55
    );

    console.log(
        `Strong eBay matches: ${strongMatches.length}`
    );

    // --------------------------------------------------------
    // NORMALIZE OUTPUT
    // --------------------------------------------------------

    const listings = strongMatches
        .slice(0, 20)
        .map(entry => {
            const item = entry.item;

            return {
                title: item.title || "eBay Listing",

                price:
                    item.price?.value || null,

                priceDisplay:
                    item.price
                        ? `${item.price.value} ${item.price.currency || "USD"}`
                        : "Price unavailable",

                image:
                    item.image?.imageUrl ||
                    item.thumbnailImages?.[0]?.imageUrl ||
                    null,

                url:
                    item.itemWebUrl ||
                    item.itemHref ||
                    null,

                condition:
                    item.condition ||
                    "Unknown",

                itemId:
                    item.itemId || null,

                matchScore:
                    entry.match.score
            };
        });

    console.log(
        `eBay listings returned to CardForge: ${listings.length}`
    );

    console.log("======================================");
    console.log("");

    return listings;
}


// ============================================================
// AI CARD ANALYSIS
// ============================================================

async function analyzeCardWithAI(frontImage, backImage) {
    const prompt = `
You are the identification engine for CardForge, a universal collectible card scanner.

Identify the card as accurately as possible.

The card may be:
- Sports
- Pokémon
- Magic: The Gathering
- Yu-Gi-Oh!
- One Piece
- Lorcana
- Digimon
- Dragon Ball
- Star Wars
- Entertainment
- Gaming
- Vintage
- Or another collectible card.

Do NOT guess a specific value.

Return ONLY valid JSON.

Use this exact structure:

{
  "cardName": "",
  "player": "",
  "team": "",
  "franchise": "",
  "set": "",
  "series": "",
  "manufacturer": "",
  "year": "",
  "cardNumber": "",
  "insert": "",
  "parallel": "",
  "rarity": "",
  "cardType": "",
  "sport": "",
  "confidence": 0
}

Rules:
- Use empty strings when a field cannot be determined.
- Do not invent card numbers.
- Do not invent parallels.
- Do not confuse the base card with an insert.
- Pay close attention to the exact set and year.
- Pay close attention to visible card numbers.
- For sports cards, identify player and team.
- For Pokémon/TCG cards, identify the exact character/card name, set, number, rarity and franchise when visible.
- Confidence should be 0-100.
`;

    const content = [
        {
            type: "text",
            text: prompt
        },
        {
            type: "image_url",
            image_url: {
                url: frontImage
            }
        }
    ];

    if (backImage) {
        content.push({
            type: "image_url",
            image_url: {
                url: backImage
            }
        });
    }

    const response =
        await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            response_format: {
                type: "json_object"
            },
            messages: [
                {
                    role: "user",
                    content
                }
            ],
            max_tokens: 1000
        });

    const text =
        response.choices?.[0]?.message?.content;

    if (!text) {
        throw new Error(
            "AI did not return card information."
        );
    }

    return JSON.parse(text);
}


// ============================================================
// MAIN CARD ANALYSIS ROUTE
// ============================================================

app.post("/api/analyze-card", async (req, res) => {
    try {
        console.log("");
        console.log("======================================");
        console.log("CARDFORGE V12 ANALYSIS");
        console.log("======================================");

        const {
            frontImage,
            backImage
        } = req.body;

        if (!frontImage) {
            return res.status(400).json({
                error: "Front image is required."
            });
        }

        console.log("Analyzing card with AI...");

        const card =
            await analyzeCardWithAI(
                frontImage,
                backImage
            );

        console.log("Card identified:");
        console.log(card);

        let ebayListings = [];

        if (EBAY_APP_ID && EBAY_CERT_ID) {
            try {
                ebayListings =
                    await searchEbayListings(card);
            } catch (error) {
                console.error(
                    "eBay search failed:",
                    error.message
                );
            }
        }

        res.json({
            success: true,
            card,
            ebayListings
        });

    } catch (error) {
        console.error(
            "CardForge analysis error:",
            error
        );

        res.status(500).json({
            error:
                error.message ||
                "Something went wrong analyzing the card."
        });
    }
});


// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `CardForge V12 listening on port ${PORT}`
        );
    }
);