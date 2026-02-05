// src/02-with-tool.ts
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

// 1. Описываем tools — это просто JSON Schema
const tools: OpenAI.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Получить текущую погоду в городе",
            parameters: {
                type: "object",
                properties: {
                    city: {
                        type: "string",
                        description: "Название города",
                    },
                },
                required: ["city"],
            },
        },
    },
];

// 2. Реализация tool — обычная функция
function get_weather(city: string): string {
    // Пока фейковая, потом можно реальный API
    const data: Record<string, string> = {
        "Москва": "−5°C, снег",
        "Анапа": "+8°C, облачно",
        "Лондон": "+3°C, дождь",
    };
    return data[city] ?? `Нет данных для города ${city}`;
}

async function main() {
    const response = await client.chat.completions.create({
        model: "anthropic/claude-sonnet-4.5",
        messages: [
            { role: "user", content: "Какая погода в Анапе?" },
        ],
        tools,
    });

    const message = response.choices[0].message;

    // 3. Смотрим что вернула модель
    console.log("=== Ответ модели ===");
    console.log("Content:", message.content);
    console.log("Tool calls:", JSON.stringify(message.tool_calls, null, 2));
}

main();
