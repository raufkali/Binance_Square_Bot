import "dotenv/config";
import fs from "fs/promises";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  throw new Error(
    "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in .env",
  );
}

const model = "@cf/black-forest-labs/flux-1-schnell";

const prompt = `
Create a professional crypto-news image for a Binance Square post.

Subject: Bitcoin market analysis.

Show a futuristic but realistic Bitcoin trading environment,
Bitcoin symbol, clean financial charts, subtle market data,
dark premium background, cinematic lighting.

No text, no words, no captions, no watermark.
Square composition suitable for a social media crypto post.
`;

console.log("Generating image...");

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
    }),
  },
);

if (!response.ok) {
  const error = await response.text();
  throw new Error(`Cloudflare API error ${response.status}: ${error}`);
}

const result = await response.json();

if (!result.success) {
  console.error(result);
  throw new Error("Cloudflare image generation failed");
}

const imageBase64 = result.result.image;

const imageBuffer = Buffer.from(imageBase64, "base64");

await fs.writeFile("cloudflare-test.png", imageBuffer);

console.log("✅ Image generated!");
console.log("Saved as: cloudflare-test.png");
