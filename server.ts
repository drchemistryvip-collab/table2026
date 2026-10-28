import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Support base64 image payloads up to 50MB
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Helper function to get GoogleGenAI client with optionally provided custom API key
function getAIClient(customApiKey?: string) {
  let raw = (customApiKey && customApiKey.trim() !== "") ? customApiKey.trim() : process.env.GEMINI_API_KEY;
  if (raw) {
    raw = raw.replace(/^["']|["']$/g, '').trim();
  }
  return new GoogleGenAI({
    apiKey: raw,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// List of candidate Gemini models in priority order (Flash, Pro, Lite, etc.)
const GENERAL_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-3.8-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
];

const TTS_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-3.8-flash-lite-tts",
  "gemini-2.5-flash-lite",
  "gemini-1.5-flash",
];

async function generateContentWithFallback(
  aiClient: GoogleGenAI,
  candidateModels: string[],
  payload: any
) {
  let lastError: any = null;
  for (const modelName of candidateModels) {
    try {
      console.log(`Trying Gemini model: ${modelName}...`);
      const response = await aiClient.models.generateContent({
        ...payload,
        model: modelName,
      });
      if (response) {
        return { response, usedModel: modelName };
      }
    } catch (err: any) {
      console.warn(`Gemini model ${modelName} failed, trying next fallback:`, err?.message || err);
      lastError = err;
    }
  }
  throw lastError || new Error("All candidate Gemini models failed to respond.");
}

// Validate custom or default API key
app.post("/api/gemini/validate-key", async (req, res) => {
  try {
    const { customApiKey, apiKey } = req.body;
    const aiClient = getAIClient(customApiKey || apiKey);
    const { response, usedModel } = await generateContentWithFallback(
      aiClient,
      GENERAL_GEMINI_MODELS,
      { contents: "Respond with OK to test key connection." }
    );
    if (response && response.text) {
      return res.json({ success: true, valid: true, usedModel });
    } else {
      return res.json({ success: true, valid: false, error: "no response text from Gemini API" });
    }
  } catch (error: any) {
    console.error("Error validating key:", error);
    return res.json({
      success: true,
      valid: false,
      error: error?.message || "Invalid or inactive API key",
    });
  }
});

/**
 * 1. Extract School Timetable from an Uploaded Image or from the sample attachment
 */
app.post("/api/gemini/extract-schedule", async (req, res) => {
  try {
    let { imageBase64, mimeType, useSample, customApiKey, apiKey } = req.body;
    const aiClient = getAIClient(customApiKey || apiKey);

    if (useSample || !imageBase64) {
      const candidates = [
        path.join(process.cwd(), "public/assets/aistudio/photo_2026-10-27_21-33-17_62edd79f.jpg"),
        path.join(__dirname, "public/assets/aistudio/photo_2026-10-27_21-33-17_62edd79f.jpg"),
        path.join(process.cwd(), "public/assets/aistudio/photo_2026-10-27_22-48-36_2a3b3357.jpg"),
        path.join(__dirname, "public/assets/aistudio/photo_2026-10-27_22-48-36_2a3b3357.jpg"),
      ];
      let foundPath = candidates.find((p) => fs.existsSync(p));
      if (foundPath) {
        const fileBuffer = fs.readFileSync(foundPath);
        imageBase64 = fileBuffer.toString("base64");
        mimeType = "image/jpeg";
      } else {
        return res.status(400).json({ success: false, error: "وێنەیێ سەمپل نەهاتە لێدۆزین د سێرڤەری دا" });
      }
    }

    // Clean base64 header if present
    if (imageBase64.includes(",")) {
      const parts = imageBase64.split(",");
      imageBase64 = parts[1];
      if (!mimeType) {
        const match = parts[0].match(/:(.*?);/);
        if (match) mimeType = match[1];
      }
    }

    if (!mimeType) {
      mimeType = "image/jpeg";
    }

    const { customPrompt } = req.body;
    const promptText = `
You are an expert school timetable OCR scanner and analyzer specializing in Kurdish / Arabic school schedules (aSC Timetables, Minha Escola, and manual school charts).

CRITICAL EXTRACTION RULES:
1. READ COLUMN HEADERS CAREFULLY:
   - The table header row contains period numbers: 1, 2, 3, 4, 5, 6 (or 1 to 8).
   - In Kurdish/Arabic timetables, period 1 (وانا 1 / الدرس 1 / 1) is next to the Day column (usually on the right side).
   - Period 1 MUST map to index 0 of the \`lessons\` array.
   - Period 2 MUST map to index 1 of the \`lessons\` array.
   - Period 3 MUST map to index 2 of the \`lessons\` array.
   - Period 4 MUST map to index 3 of the \`lessons\` array.
   - Period 5 MUST map to index 4 of the \`lessons\` array.
   - Period 6 MUST map to index 5 of the \`lessons\` array.
   - DO NOT INVERT OR REVERSE THE PERIOD ORDER.

2. READ DAY NAMES CAREFULLY:
   - Map Kurdish day names accurately:
     "ئێکشەمبی" / "ئێك شه مبی" -> "ئێکشەمبی"
     "دووشەمبی" / "دوو شه مبی" -> "دووشەمبی"
     "سێشەمبی" / "سی شه مبی" -> "سێشەمبی"
     "چوارشەمبی" / "چار شه مبی" -> "چوارشەمبی"
     "پێنچ شەمبی" / "پینج شه مبی" -> "پێنچ شەمبی"

3. READ CLASS / GRADE / SECTION NAMES CAREFULLY:
   - Grade numbers: 1 to 12 (e.g. 10, 11, 12, 1, 2, 3...)
   - Kurdish / Arabic section letters: أ, ب, ج, د, هـ, و, ز, ح, ط...
   - Examples of valid cell text: "10 - ب", "10 - ج", "10 - د", "10 - هـ", "10 - و", "پۆلا 10 - د", "12 - زانستی أ", "11 - ب".
   - IF A CELL IS EMPTY OR BLANK OR HAS NO CLASS NAME: Write strictly "بێ وانە".
   - Make sure every day has the EXACT same array length corresponding to the total period count (e.g. exactly 6 elements for 6 periods).

4. TEACHER & SUBJECT EXTRACTION:
   - Teacher Name: Look at the top title (e.g. "م حسێن", "م. حوسێن", "مامۆستا حسێن").
   - Subject Name: Look at small text inside cells or top title (e.g. "کیمیا", "فیزیا", "بیرکاری", "زانست", "کوردی", etc.).

${customPrompt ? `USER SPECIAL INSTRUCTION: ${customPrompt}` : ""}

Return ONLY a valid JSON object matching this schema:
{
  "teacherName": string,
  "subject": string,
  "lessonCountPerDay": number,
  "days": [
    {
      "dayName": "ئێکشەمبی" | "دووشەمبی" | "سێشەمبی" | "چوارشەمبی" | "پێنچ شەمبی",
      "shift": "morning" | "evening",
      "lessons": string[]
    }
  ],
  "notes": string
}
`;

    const { response, usedModel } = await generateContentWithFallback(
      aiClient,
      GENERAL_GEMINI_MODELS,
      {
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: imageBase64,
              },
            },
            {
              text: promptText,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
        },
      }
    );

    const responseText = response.text || "{}";
    let parsedData;
    try {
      parsedData = JSON.parse(responseText);
    } catch (parseErr) {
      // fallback sanitize markdown code fences if any
      const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      parsedData = JSON.parse(cleaned);
    }

    return res.json({
      success: true,
      usedModel,
      data: parsedData,
    });
  } catch (error: any) {
    console.error("Error in extract-schedule:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to analyze image with Gemini",
    });
  }
});

/**
 * 2. Natural Language Kurdish Timing Assistant (AI-Powered Bell & Exam Settings)
 */
app.post("/api/gemini/parse-timing-command", async (req, res) => {
  try {
    const { prompt, currentSettings, customApiKey, apiKey } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const aiClient = getAIClient(customApiKey || apiKey);

    const systemInstruction = `
You are an intelligent school bell & timetable configuration assistant for Kurdish schools (Badini / Sorani Kurdish).
The user wants to configure lesson durations, break timings, shift lengths, lesson counts, or exam mode.

Analyze the user's Kurdish command: "${prompt}".
Existing settings context: ${JSON.stringify(currentSettings || {})}.

Example requests:
1. "سپێدا 40 خولەکە و هێڤاری 35 خولەکە و پشتی دەرسا 3 جەرەسێ بکە 10 خولەک"
   -> morningDuration: 40, eveningDuration: 35, longBreakLesson: 3, longBreakDuration: 10
2. "بکە حەفت دەرس ئەڤرو دەرسا دوویێ انتیحانە هـەمی قوناغا و وانا دوویێ دێ دەرسا سێیێ دەست پێ کەتن هـەتا دوماهـیک وانە و دەرس بیتە 35خولەک و دەرسا انتیحان بیتە 40خولەک"
   -> lessonCount: 7, examSettings: { enabled: true, examLessonNumber: 2, examDuration: 40, otherLessonsDuration: 35, breakAfterExam: 10 }
3. "دەواما ئاسایی بکە هەمی 40 خولەک"
   -> morningDuration: 40, eveningDuration: 40, examSettings: { enabled: false }

Return JSON with this exact structure:
{
  "morningDuration": number,
  "eveningDuration": number,
  "lessonCount": number,
  "defaultBreakDuration": number,
  "longBreakLesson": number,
  "longBreakDuration": number,
  "examSettings": {
    "enabled": boolean,
    "examLessonNumber": number,
    "examDuration": number,
    "otherLessonsDuration": number,
    "breakAfterExam": number
  },
  "summaryKurdish": string
}
`;

    const { response, usedModel } = await generateContentWithFallback(
      aiClient,
      GENERAL_GEMINI_MODELS,
      {
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
        },
      }
    );

    const responseText = response.text || "{}";
    const parsed = JSON.parse(responseText.replace(/```json/g, "").replace(/```/g, "").trim());
    return res.json({ success: true, usedModel, settings: parsed });
  } catch (error: any) {
    console.error("Error in parse-timing-command:", error);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * 3. Text to Speech (TTS) for Kurdish Voice Bell Alerts
 */
app.post("/api/gemini/tts", async (req, res) => {
  try {
    const { text, voiceGender, customApiKey, apiKey } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const aiClient = getAIClient(customApiKey || apiKey);
    const voiceName = voiceGender === "female" ? "Kore" : "Puck";

    const { response, usedModel } = await generateContentWithFallback(
      aiClient,
      TTS_GEMINI_MODELS,
      {
        contents: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      }
    );

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return res.status(500).json({ error: "No audio generated from model" });
    }

    return res.json({
      success: true,
      usedModel,
      audioBase64: base64Audio,
      mimeType: "audio/wav",
    });
  } catch (error: any) {
    console.error("Error in tts:", error);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

// Vite middleware in dev or static files in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer();
