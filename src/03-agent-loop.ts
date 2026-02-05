// src/03-agent-loop.ts
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

const tools: OpenAI.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Получить текущую погоду в городе",
            parameters: {
                type: "object",
                properties: {
                    city: { type: "string", description: "Название города" },
                },
                required: ["city"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_time",
            description: "Получить текущее время в городе",
            parameters: {
                type: "object",
                properties: {
                    city: { type: "string", description: "Название города" },
                },
                required: ["city"],
            },
        },
    },
];

// Реестр функций — маппинг имя → реализация
const toolHandlers: Record<string, (args: any) => string> = {
    get_weather: ({ city }) => {
        const data: Record<string, string> = {
            "Москва": "−5°C, снег",
            "Анапа": "+8°C, облачно",
        };
        return data[city] ?? `Нет данных для ${city}`;
    },
    get_time: ({ city }) => {
        const now = new Date();
        return `Сейчас в ${city}: ${now.toLocaleTimeString("ru-RU")}`;
    },
};

async function agentLoop(userMessage: string) {
    // Начальный контекст
    const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "Ты полезный ассистент. Используй tools когда нужно." },
        { role: "user", content: userMessage },
    ];

    let iteration = 0;
    const MAX_ITERATIONS = 10; // защита от бесконечного цикла

    while (iteration < MAX_ITERATIONS) {
        iteration++;
        console.log(`\n--- Итерация ${iteration} ---`);

        const response = await client.chat.completions.create({
            model: "anthropic/claude-sonnet-4.5",
            messages,
            tools,
        });

        const message = response.choices[0].message;

        // Добавляем ответ модели в контекст
        messages.push(message);

        // Если нет tool_calls — модель решила остановиться
        if (!message.tool_calls || message.tool_calls.length === 0) {
            console.log("Агент завершил работу.");
            console.log("Ответ:", message.content);
            return message.content;
        }

        // Выполняем каждый tool call
        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            console.log(`Tool: ${name}(${JSON.stringify(args)})`);

            const handler = toolHandlers[name];
            const result = handler
                ? handler(args)
                : `Ошибка: tool "${name}" не найден`;

            console.log(`Результат: ${result}`);

            // Добавляем результат в контекст
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
        // Цикл продолжается — отправляем обратно в LLM
    }

    console.log("Достигнут лимит итераций!");
}

// Тестируем — запрос, требующий ДВА tool call
agentLoop("Какая погода в Москве и Анапе? И сколько сейчас времени?");
