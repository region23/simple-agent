// src/04-real-tools.ts
import OpenAI from "openai";
import { execSync } from "child_process";
import { readFileSync } from "fs";
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
            name: "run_bash",
            description: "Выполнить bash-команду и вернуть результат. Только безопасные read-only команды.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "Bash-команда для выполнения",
                    },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Прочитать содержимое файла",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Путь к файлу",
                    },
                },
                required: ["path"],
            },
        },
    },
];

const toolHandlers: Record<string, (args: any) => string> = {
    run_bash: ({ command }) => {
        try {
            return execSync(command, {
                encoding: "utf-8",
                timeout: 5000,
            }).trim();
        } catch (e: any) {
            return `Ошибка: ${e.message}`;
        }
    },
    read_file: ({ path }) => {
        try {
            return readFileSync(path, "utf-8");
        } catch (e: any) {
            return `Ошибка: ${e.message}`;
        }
    },
};

async function agentLoop(userMessage: string) {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: `Ты полезный ассистент с доступом к файловой системе.
Можешь выполнять bash-команды и читать файлы.
Отвечай на русском.`,
        },
        { role: "user", content: userMessage },
    ];

    let iteration = 0;

    while (iteration < 10) {
        iteration++;
        console.log(`\n--- Итерация ${iteration} ---`);

        const response = await client.chat.completions.create({
            model: "anthropic/claude-sonnet-4.5",
            messages,
            tools,
        });

        const message = response.choices[0].message;
        messages.push(message);

        if (!message.tool_calls?.length) {
            console.log("\nАгент завершил работу.");
            console.log("Ответ:", message.content);
            return;
        }

        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`Tool: ${name}(${JSON.stringify(args)})`);

            const result = toolHandlers[name]?.(args)
                ?? `Tool "${name}" не найден`;

            console.log(`Результат: ${result.slice(0, 200)}...`);

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
    }
}

// Теперь агент может реально исследовать твою систему
agentLoop("Посмотри что за проект лежит в текущей директории. Какие зависимости установлены?");
