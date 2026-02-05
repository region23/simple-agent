// src/01-basic-call.ts
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

async function main() {
    const response = await client.chat.completions.create({
        model: "anthropic/claude-sonnet-4.5",
        messages: [
            { role: "user", content: "Сколько будет 2 + 2?" }
        ],
    });

    console.log(response.choices[0].message.content);
}

main();
