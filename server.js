const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();

/*
========================================
SERVER CONFIGURATION
========================================
*/

const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(
    express.json({
        limit: "20mb"
    })
);

/*
========================================
SERVE CARDFORGE WEBSITE
========================================
*/

app.use(express.static(__dirname));


/*
========================================
OPENAI CONFIGURATION
========================================
*/

if (!process.env.OPENAI_API_KEY) {

    console.error(
        "ERROR: OPENAI_API_KEY is missing."
    );

}

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const MODEL =
    process.env.OPENAI_MODEL ||
    "gpt-4.1-mini";


/*
========================================
HEALTH CHECK
========================================
*/

app.get(
    "/api/health",
    (req, res) => {

        res.json({

            success: true,

            message:
                "CardForge backend is running.",

            version:
                "V7",

            ai:
                true

        });

    }
);


/*
========================================
AI CARD ANALYSIS
========================================
*/

app.post(
    "/api/analyze-card",
    async (req, res) => {

        console.log("");
        console.log(
            "======================================"
        );
        console.log(
            "        CARDFORGE AI ANALYSIS"
        );
        console.log(
            "======================================"
        );


        try {

            const {
                frontImage,
                backImage
            } = req.body;


            /*
            --------------------------------
            CHECK IMAGES
            --------------------------------
            */

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

            console.log(
                "Sending images to AI..."
            );


            /*
            --------------------------------
            AI PROMPT
            --------------------------------
            */

            const prompt = `

You are CardForge, a professional universal collectible-card
identification system.

Your job is to identify ANY collectible card from photographs.

The card can be:

SPORTS:
- Basketball
- Football
- Baseball
- Hockey
- Soccer
- Racing
- Golf
- Tennis
- Wrestling
- Boxing
- Other sports

TRADING CARD GAMES:
- Pokemon
- Magic: The Gathering
- Yu-Gi-Oh!
- One Piece
- Disney Lorcana
- Digimon
- Dragon Ball
- Star Wars
- Flesh and Blood
- Other TCGs

OTHER COLLECTIBLES:
- Vintage trading cards
- Movie cards
- TV cards
- Gaming cards
- Comic cards
- Promotional cards
- Non-sports cards
- Historical cards
- Entertainment cards
- Rare or obscure cards

IMPORTANT:

Analyze BOTH images.

Do NOT assume this is a sports card.

First determine the type/category of card.

Then identify as many details as the images actually support.

NEVER invent information.

If you cannot confidently determine something, return
"Unknown".

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
- Text on the front
- Text on the back
- Statistics
- Logos
- Grading information

If the card is graded, identify:

- Grading company
- Grade

Do NOT estimate a price from the image alone.

The market value will be researched separately.

Give a confidence score from 0 to 100.

Explain the evidence you used to identify the card.

Create a concise search query that could be used to find the
exact card on an online marketplace.

Return ONLY valid JSON.

Do not use markdown.

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


            /*
            --------------------------------
            SEND TO OPENAI
            --------------------------------
            */

            const response =
                await client.responses.create({

                    model:
                        MODEL,

                    input: [

                        {

                            role:
                                "user",

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


            /*
            --------------------------------
            READ AI RESPONSE
            --------------------------------
            */

            const output =
                response.output_text;


            let cardData;


            try {

                cardData =
                    JSON.parse(output);

            }

            catch (error) {

                console.error(
                    "AI returned invalid JSON."
                );

                return res.status(500).json({

                    success: false,

                    error:
                        "The AI returned an invalid card analysis.",

                    raw:
                        output

                });

            }


            /*
            --------------------------------
            SUCCESS
            --------------------------------
            */

            console.log(
                "AI analysis completed successfully."
            );

            console.log(
                "======================================"
            );

            console.log("");


            res.json({

                success:
                    true,

                card:
                    cardData

            });

        }


        /*
        --------------------------------
        ERROR HANDLING
        --------------------------------
        */

        catch (error) {

            console.log("");

            console.log(
                "======================================"
            );

            console.log(
                "        CARDFORGE AI ERROR"
            );

            console.log(
                "======================================"
            );

            console.error(error);

            console.log(
                "======================================"
            );

            console.log("");


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


/*
========================================
START SERVER
========================================
*/

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");

        console.log(
            "======================================"
        );

        console.log(
            "        CARDFORGE V7 BACKEND"
        );

        console.log(
            "======================================"
        );

        console.log(
            `Server running on port ${PORT}`
        );

        console.log(
            `Website: http://localhost:${PORT}`
        );

        console.log(
            "Network access enabled."
        );

        console.log(
            `Health check: /api/health`
        );

        console.log(
            `AI model: ${MODEL}`
        );

        console.log(
            "======================================"
        );

        console.log("");

    }
);

