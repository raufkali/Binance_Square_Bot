import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

try {
  const response = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",

    messages: [
      {
        role: "system",
        content: "You are a professional cryptocurrency content writer.",
      },
      {
        role: "user",
        content:
          "Write one short, useful and original Binance Square post about Bitcoin. Do not invent current prices or news.",
      },
    ],
  });

  console.log("\n========== GROQ TEST ==========\n");

  console.log(response.choices[0].message.content);

  console.log("\n================================\n");
} catch (error) {
  console.error("\nGroq API failed:\n");
  console.error(error?.message || error);
}
