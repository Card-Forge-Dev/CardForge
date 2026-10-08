const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const crypto = require("crypto");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(
    express.json({
        limit: "20mb"
    })
);

app.use(express.static(__dirname));

/* =========================================================
   OPENAI
========================================================= */

if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY is missing.");
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const OPENAI_MODEL =
    process.env.OPENAI_MODEL || "gpt-4.1-mini";

/* =========================================================
   EBAY
========================================================= */

const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;

/*
   These two variables are used for eBay's
   Marketplace Account Deletion verification.

   IMPORTANT:
   The endpoint URL here MUST exactly match
   the endpoint URL you enter into eBay.
*/
const EBAY_VERIFICATION_TOKEN =
    process.env.EBAY_VERIFICATION_TOKEN;

const EBAY_NOTIFICATION_ENDPOINT =
    process.env.EBAY_NOTIFICATION_ENDPOINT;

let ebayToken = null;
let ebayTokenExpiresAt = 0;

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "CardForge backend is running.",
        version: "V9",
        ai: true,
        ebay: !!(EBAY_APP_ID && EBAY_CERT_ID),
        ebayNotificationEndpoint:
            !!(
                EBAY_VERIFICATION_TOKEN &&
                EBAY_NOTIFICATION_ENDPOINT
            )
    });
});

/* =========================================================
   EBAY MARKETPLACE ACCOUNT DELETION VERIFICATION
========================================================= */

/*
   eBay sends:

   GET /api/ebay/account-deletion?challenge_code=...

   We must return:

   {
       "challengeResponse": "..."
   }

   The SHA-256 input must be:

   challengeCode + verificationToken + endpoint

   The endpoint must EXACTLY match the URL registered
   with eBay.
*/

app.get(
    "/api/ebay/account-deletion",
    (req, res) => {
        try {
            const challengeCode =
                req.query.challenge_code;

            if (!challengeCode) {
                return res.status(400).json({
                    error:
                        "Missing challenge_code."
                });
            }

            if (
                !EBAY_VERIFICATION_TOKEN ||
                !EBAY_NOTIFICATION_ENDPOINT
            ) {
                console.error(
                    "eBay verification environment variables are missing."
                );

                return res.status(500).json({
                    error:
                        "eBay verification configuration is missing."
                });
            }

            const hash = crypto.createHash("sha256");

            hash.update(challengeCode);
            hash.update(EBAY_VERIFICATION_TOKEN);
            hash.update(EBAY_NOTIFICATION_ENDPOINT);

            const challengeResponse =
                hash.digest("hex");

            console.log(
                "eBay endpoint verification challenge received."
            );

            res.status(200).json({
                challengeResponse
            });

        } catch (error) {
            console.error(
                "eBay endpoint verification error:",
                error
            );

            res.status(500).json({
                error:
                    "eBay endpoint verification failed."
            });
        }
    }
);

/*
   eBay sends marketplace account deletion
   notifications using POST.

   We acknowledge them immediately with 200 OK.
*/

app.post(
    "/api/ebay/account-deletion",
    (req, res) => {
        console.log(
            "eBay marketplace account deletion notification received."
        );

        console.log(
            JSON.stringify(
                req.body,
                null,
                2
            )
        );

        res.status(200).json({
            received: true
        });
    }
);

/* =========================================================
   EBAY APPLICATION TOKEN
========================================================= */

async function getEbayAccessToken() {

    if (!EBAY_APP_ID || !EBAY_CERT_ID) {
        throw new Error(
            "eBay credentials are missing. Add EBAY_APP_ID and EBAY_CERT_ID to Render."
        );
    }

    if (
        ebayToken &&
        Date.now() <
            ebayTokenExpiresAt - 60000
    ) {
        return ebayToken;
    }

    console.log(
        "Getting new eBay application access token..."
    );

    const credentials = Buffer
        .from(
            `${EBAY_APP_ID}:${EBAY_CERT_ID}`
        )
        .toString("base64");

    const response = await fetch(
        "https://api.ebay.com/identity/v1/oauth2/token",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",

                "Authorization":
                    `Basic ${credentials}`
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

        console.error(
            "eBay OAuth error:",
            data
        );

        throw new Error(
            data.error_description ||
            data.error ||
            "Unable to authenticate with eBay."
        );
    }

    ebayToken =
        data.access_token;

    ebayTokenExpiresAt =
        Date.now() +
        data.expires_in * 1000;

    console.log(
        "eBay access token obtained successfully."
    );

    return ebayToken;
}

/* =========================================================
   EBAY ACTIVE LISTING SEARCH
========================================================= */

async function searchEbayListings(
    searchQuery
) {

    const token =
        await getEbayAccessToken();

    const params =
        new URLSearchParams();

    params.set(
        "q",
        searchQuery
    );

    params.set(
        "limit",
        "12"
    );

    params.set(
        "sort",
        "price"
    );

    const url =
        "https://api.ebay.com/buy/browse/v1/item_summary/search?" +
        params.toString();

    console.log(
        "Searching eBay for:",
        searchQuery
    );

    const response =
        await fetch(
            url,
            {
                method: "GET",

                headers: {
                    "Authorization":
                        `Bearer ${token}`,

                    "Accept":
                        "application/json",

                    "X-EBAY-C-MARKETPLACE-ID":
                        "EBAY_US"
                }
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        console.error(
            "eBay Browse API error:",
            data
        );

        throw new Error(
            data.errors?.[0]?.longMessage ||
            data.errors?.[0]?.message ||
            "eBay listing search failed."
        );
    }

    const listings =
        (data.itemSummaries || [])
            .map(item => {

                const price =
                    item.price?.value
                        ? Number(
                            item.price.value
                        )
                        : null;

                return {
                    itemId:
                        item.itemId || "",

                    title:
                        item.title ||
                        "Unknown listing",

                    price,

                    currency:
                        item.price?.currency ||
                        "USD",

                    image:
                        item.image?.imageUrl ||
                        "",

                    itemWebUrl:
                        item.itemWebUrl ||
                        "",

                    condition:
                        item.condition ||
                        "Unknown",

                    seller:
                        item.seller?.username ||
                        "",

                    buyingOptions:
                        item.buyingOptions ||
                        []
                };
            });

    return listings;
}

/* =========================================================
   AI CARD ANALYSIS
========================================================= */

app.post(
    "/api/analyze-card",
    async (req, res) => {

        console.log("");

        console.log(
            "======================================"
        );

        console.log(
            "       CARDFORGE V9 ANALYSIS"
        );

        console.log(
            "======================================"
        );

        try {

            const {
                frontImage,
                backImage
            } = req.body;

            if (
                !frontImage ||
                !backImage
            ) {

                return res.status(400).json({
                    success: false,

                    error:
                        "Both front and back images are required."
                });
            }

            console.log(
                "Front image received."
            );

            console.log(
                "Back image received."
            );

            const prompt = `

You are CardForge, a professional universal collectible-card identification system.

Identify ANY collectible card from the supplied front and back photographs.

The card may be:

- Sports
- Pokemon
- Magic: The Gathering
- Yu-Gi-Oh!
- One Piece
- Disney Lorcana
- Digimon
- Dragon Ball
- Star Wars
- Gaming
- Movies
- Television
- Comics
- Vintage
- Entertainment
- Promotional
- Historical
- Other collectible cards

IMPORTANT:

Analyze BOTH images.

Do not assume this is a sports card.

Identify the card as specifically as the photographs allow.

NEVER invent information.

If something cannot be confidently determined,
return "Unknown".

Carefully inspect:

- Card name
- Player
- Character
- Team
- Sport
- Set
- Manufacturer
- Publisher
- Year
- Card number
- Rarity
- Parallel
- Variant
- Edition
- First Edition
- Rookie designation
- Serial numbering
- Autograph
- Memorabilia
- Language
- Special symbols
- Holographic features
- Foiling
- Copyright information
- Front text
- Back text
- Statistics
- Logos
- Grading information

If graded, identify:

- Grading company
- Grade

Do NOT estimate the card's market value from the photographs.

Market value will be researched separately.

Give a confidence score from 0 to 100.

Give evidence supporting the identification.

Create a concise marketplace search query that should find the exact card.

Return ONLY valid JSON.

Use exactly this structure:

{
    "cardType": "",
    "category": "",
    "cardName": "",
    "playerOrCharacter": "",
    "sport": "",
    "team": "",
    "year": "",
    "manufacturer": "",
    "set": "",
    "cardNumber": "",
    "rarity": "",
    "parallelOrVariant": "",
    "edition": "",
    "language": "",
    "serialNumber": "",
    "rookie": null,
    "firstEdition": null,
    "autograph": null,
    "memorabilia": null,
    "graded": null,
    "gradingCompany": "",
    "grade": "",
    "specialFeatures": [],
    "confidence": 0,
    "description": "",
    "identificationEvidence": [],
    "searchQuery": "",
    "estimatedValue": "Pending market research",
    "valueConfidence": 0,
    "notes": ""
}

`;

            console.log(
                "Sending card images to OpenAI..."
            );

            const response =
                await openai.responses.create({

                    model:
                        OPENAI_MODEL,

                    input: [
                        {
                            role: "user",

                            content: [

                                {
                                    type:
                                        "input_text",

                                    text:
                                        prompt
                                },

                                {
                                    type:
                                        "input_text",

                                    text:
                                        "IMAGE 1: FRONT OF CARD"
                                },

                                {
                                    type:
                                        "input_image",

                                    image_url:
                                        frontImage
                                },

                                {
                                    type:
                                        "input_text",

                                    text:
                                        "IMAGE 2: BACK OF CARD"
                                },

                                {
                                    type:
                                        "input_image",

                                    image_url:
                                        backImage
                                }

                            ]
                        }
                    ]
                });

            const output =
                response.output_text;

            let cardData;

            try {

                cardData =
                    JSON.parse(output);

            } catch (error) {

                console.error(
                    "AI returned invalid JSON:"
                );

                console.error(
                    output
                );

                return res.status(500).json({
                    success: false,

                    error:
                        "The AI returned invalid card analysis."
                });
            }

            console.log(
                "Card identified:"
            );

            console.log(
                cardData.searchQuery
            );

            /* =================================================
               EBAY SEARCH
            ================================================= */

            let ebayListings = [];

            let ebayError = null;

            try {

                if (
                    cardData.searchQuery &&
                    EBAY_APP_ID &&
                    EBAY_CERT_ID
                ) {

                    ebayListings =
                        await searchEbayListings(
                            cardData.searchQuery
                        );

                } else {

                    ebayError =
                        "eBay credentials or search query missing.";
                }

            } catch (error) {

                console.error(
                    "eBay search failed:"
                );

                console.error(
                    error.message
                );

                ebayError =
                    error.message;
            }

            console.log(
                `eBay listings found: ${ebayListings.length}`
            );

            console.log(
                "======================================"
            );

            res.json({

                success:
                    true,

                card:
                    cardData,

                ebay: {

                    success:
                        ebayListings.length > 0,

                    listings:
                        ebayListings,

                    error:
                        ebayError
                }

            });

        }

        catch (error) {

            console.error("");

            console.error(
                "======================================"
            );

            console.error(
                "       CARDFORGE V9 ERROR"
            );

            console.error(
                "======================================"
            );

            console.error(
                error
            );

            console.error(
                "======================================"
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message ||
                    "Unknown CardForge backend error."
            });
        }
    }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");

        console.log(
            "======================================"
        );

        console.log(
            "        CARDFORGE V9 BACKEND"
        );

        console.log(
            "======================================"
        );

        console.log(
            `Server running on port ${PORT}`
        );

        console.log(
            `AI model: ${OPENAI_MODEL}`
        );

        console.log(
            `eBay configured: ${
                !!(
                    EBAY_APP_ID &&
                    EBAY_CERT_ID
                )
            }`
        );

        console.log(
            `eBay notification verification configured: ${
                !!(
                    EBAY_VERIFICATION_TOKEN &&
                    EBAY_NOTIFICATION_ENDPOINT
                )
            }`
        );

        console.log(
            "======================================"
        );

        console.log("");
    }
);