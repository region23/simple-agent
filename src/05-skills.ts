// src/05-skills.ts
import OpenAI from "openai";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

// === SKILL: определение ===
interface Skill {
    name: string;
    description: string;           // для system prompt
    tools: OpenAI.ChatCompletionTool[];
    handlers: Record<string, (args: any) => string>;
}

// === SKILL: файловая система ===
const filesystemSkill: Skill = {
    name: "filesystem",
    description: "Умеешь работать с файлами: читать, писать, просматривать директории.",
    tools: [
        {
            type: "function",
            function: {
                name: "read_file",
                description: "Прочитать файл",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Путь к файлу" },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "write_file",
                description: "Записать содержимое в файл",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Путь к файлу" },
                        content: { type: "string", description: "Содержимое" },
                    },
                    required: ["path", "content"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "list_dir",
                description: "Список файлов в директории",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Путь к директории" },
                    },
                    required: ["path"],
                },
            },
        },
    ],
    handlers: {
        read_file: ({ path }) => {
            try { return readFileSync(path, "utf-8"); }
            catch (e: any) { return `Ошибка: ${e.message}`; }
        },
        write_file: ({ path, content }) => {
            try { writeFileSync(path, content); return `Файл ${path} записан`; }
            catch (e: any) { return `Ошибка: ${e.message}`; }
        },
        list_dir: ({ path }) => {
            try { return execSync(`ls -la ${path}`, { encoding: "utf-8" }); }
            catch (e: any) { return `Ошибка: ${e.message}`; }
        },
    },
};

// === SKILL: bash ===
const bashSkill: Skill = {
    name: "bash",
    description: "Умеешь выполнять bash-команды в терминале.",
    tools: [
        {
            type: "function",
            function: {
                name: "run_bash",
                description: "Выполнить bash-команду",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string", description: "Команда" },
                    },
                    required: ["command"],
                },
            },
        },
    ],
    handlers: {
        run_bash: ({ command }) => {
            try {
                return execSync(command, { encoding: "utf-8", timeout: 5000 }).trim();
            } catch (e: any) { return `Ошибка: ${e.message}`; }
        },
    },
};

// === SKILL: математика ===
const mathSkill: Skill = {
    name: "math",
    description: "Умеешь вычислять математические выражения.",
    tools: [
        {
            type: "function",
            function: {
                name: "calculate",
                description: "Вычислить математическое выражение",
                parameters: {
                    type: "object",
                    properties: {
                        expression: { type: "string", description: "Выражение, например: 2 * (3 + 4)" },
                    },
                    required: ["expression"],
                },
            },
        },
    ],
    handlers: {
        calculate: ({ expression }) => {
            try { return String(eval(expression)); }
            catch (e: any) { return `Ошибка: ${e.message}`; }
        },
    },
};

// === АГЕНТ с подключаемыми skills ===
function createAgent(skills: Skill[]) {
    // Собираем tools и handlers из всех skills
    const allTools = skills.flatMap(s => s.tools);
    const allHandlers = Object.assign({}, ...skills.map(s => s.handlers));

    // Собираем system prompt из описаний skills
    const skillDescriptions = skills
        .map(s => `- ${s.name}: ${s.description}`)
        .join("\n");

    const systemPrompt = `Ты полезный ассистент. У тебя есть следующие навыки:
${skillDescriptions}
Используй инструменты когда нужно. Отвечай на русском.`;

    return async function run(userMessage: string) {
        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
        ];

        let iteration = 0;

        while (iteration < 10) {
            iteration++;
            console.log(`\n--- Итерация ${iteration} ---`);

            const response = await client.chat.completions.create({
                model: "anthropic/claude-sonnet-4.5",
                messages,
                tools: allTools,
            });

            const message = response.choices[0].message;
            messages.push(message);

            if (!message.tool_calls?.length) {
                console.log("\nОтвет:", message.content);
                return message.content;
            }

            for (const toolCall of message.tool_calls) {
                const name = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                console.log(`Tool: ${name}(${JSON.stringify(args)})`);

                const result = allHandlers[name]?.(args)
                    ?? `Tool "${name}" не найден`;
                console.log(`→ ${result.slice(0, 150)}`);

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result,
                });
            }
        }
    };
}

// === Использование ===
async function main() {
    // Создаём агента с нужными skills
    const agent = createAgent([filesystemSkill, bashSkill, mathSkill]);

    // Агент сам решит какие tools использовать
    await agent(
        "Посмотри файлы проекта в текущей директории, " +
        "посчитай общее количество строк кода во всех .ts файлах в src/, " +
        "и создай файл STATS.md с результатами анализа."
    );
}

main();
