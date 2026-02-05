// src/08-interactive-agent.ts
// Интерактивный агент: Human-in-the-loop + Wizard-style guided flow
import OpenAI from "openai";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as readline from "readline";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

const MODEL = "anthropic/claude-sonnet-4.5";

// ============================================================
// УТИЛИТА: ввод от пользователя
// ============================================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

// ============================================================
// TOOLS: включая интерактивные
// ============================================================

const tools: OpenAI.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "think",
            description: "Внутренний блокнот для рассуждений.",
            parameters: {
                type: "object",
                properties: {
                    thought: { type: "string", description: "Рассуждение" },
                },
                required: ["thought"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_bash",
            description: "Выполнить bash-команду (read-only, безопасные)",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Команда" },
                },
                required: ["command"],
            },
        },
    },
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
    // --- ОПАСНОЕ ДЕЙСТВИЕ: требует подтверждения ---
    {
        type: "function",
        function: {
            name: "write_file",
            description:
                "Записать файл. ВАЖНО: это изменяющее действие — " +
                "будет запрошено подтверждение пользователя.",
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
    // --- WIZARD: предложить варианты пользователю ---
    {
        type: "function",
        function: {
            name: "ask_user_choice",
            description:
                "Предложить пользователю выбор из нескольких вариантов. " +
                "Используй когда есть несколько хороших решений и выбор зависит от предпочтений пользователя. " +
                "Пользователь может выбрать номер варианта или ввести свой.",
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description: "Вопрос или описание ситуации для пользователя",
                    },
                    options: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                label: { type: "string", description: "Краткое название варианта" },
                                description: { type: "string", description: "Описание — плюсы, минусы, для кого" },
                            },
                            required: ["label", "description"],
                        },
                        description: "Варианты для выбора (2-5 штук)",
                    },
                    allow_custom: {
                        type: "boolean",
                        description: "Разрешить пользователю ввести свой вариант",
                    },
                },
                required: ["question", "options"],
            },
        },
    },
    // --- WIZARD: запросить текстовый ввод ---
    {
        type: "function",
        function: {
            name: "ask_user_input",
            description:
                "Запросить у пользователя текстовый ввод. " +
                "Используй когда нужна конкретная информация: имя, путь, описание.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "Что спросить" },
                    hint: { type: "string", description: "Подсказка или пример ответа" },
                    default_value: { type: "string", description: "Значение по умолчанию (Enter чтобы принять)" },
                },
                required: ["question"],
            },
        },
    },
    // --- WIZARD: запросить подтверждение да/нет ---
    {
        type: "function",
        function: {
            name: "ask_user_confirm",
            description:
                "Запросить подтверждение да/нет. " +
                "Используй перед необратимыми или важными действиями.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "Что подтвердить" },
                    details: { type: "string", description: "Детали для принятия решения" },
                },
                required: ["question"],
            },
        },
    },
];

// ============================================================
// TOOL HANDLERS (с интерактивностью)
// ============================================================

// Категории опасности для human-in-the-loop
const DANGEROUS_TOOLS = new Set(["write_file"]);

const toolHandlers: Record<string, (args: any) => Promise<string> | string> = {
    think: () => "OK",

    run_bash: ({ command }) => {
        try {
            return execSync(command, { encoding: "utf-8", timeout: 10000 }).trim();
        } catch (e: any) {
            return `Ошибка: ${e.stderr || e.message}`;
        }
    },

    read_file: ({ path }) => {
        try {
            return readFileSync(path, "utf-8");
        } catch (e: any) {
            return `Ошибка: ${e.message}`;
        }
    },

    // --- HUMAN-IN-THE-LOOP: подтверждение перед записью ---
    write_file: async ({ path, content }) => {
        const exists = existsSync(path);
        const action = exists ? "перезаписать" : "создать";

        console.log("\n" + "═".repeat(50));
        console.log(`⚠️  Агент хочет ${action} файл: ${path}`);
        console.log("─".repeat(50));

        // Показываем превью содержимого
        const lines = content.split("\n");
        const preview = lines.slice(0, 15).join("\n");
        console.log(preview);
        if (lines.length > 15) {
            console.log(`... (ещё ${lines.length - 15} строк)`);
        }
        console.log("─".repeat(50));

        const answer = await ask(`Разрешить? [y/n/edit]: `);

        if (answer.toLowerCase() === "y" || answer.toLowerCase() === "д") {
            try {
                writeFileSync(path, content, "utf-8");
                return `✅ Файл ${path} записан (одобрено пользователем)`;
            } catch (e: any) {
                return `Ошибка: ${e.message}`;
            }
        } else if (answer.toLowerCase() === "edit" || answer.toLowerCase() === "e") {
            const newPath = await ask(`Новый путь (Enter = ${path}): `);
            const finalPath = newPath || path;
            try {
                writeFileSync(finalPath, content, "utf-8");
                return `✅ Файл ${finalPath} записан (путь изменён пользователем)`;
            } catch (e: any) {
                return `Ошибка: ${e.message}`;
            }
        } else {
            return `❌ Пользователь отклонил запись файла ${path}`;
        }
    },

    // --- WIZARD: выбор из вариантов ---
    ask_user_choice: async ({ question, options, allow_custom }) => {
        console.log("\n" + "═".repeat(50));
        console.log(`🤔 ${question}`);
        console.log("─".repeat(50));

        options.forEach((opt: any, i: number) => {
            console.log(`  ${i + 1}) ${opt.label}`);
            console.log(`     ${opt.description}`);
        });

        if (allow_custom) {
            console.log(`  ${options.length + 1}) Свой вариант...`);
        }

        console.log("─".repeat(50));
        const answer = await ask(`Выбор [1-${options.length + (allow_custom ? 1 : 0)}]: `);

        const num = parseInt(answer);

        if (allow_custom && num === options.length + 1) {
            const custom = await ask("Введите свой вариант: ");
            return `Пользователь выбрал свой вариант: "${custom}"`;
        }

        if (num >= 1 && num <= options.length) {
            const chosen = options[num - 1];
            return `Пользователь выбрал: "${chosen.label}" — ${chosen.description}`;
        }

        // Если ввели текст вместо номера
        return `Пользователь ответил: "${answer}"`;
    },

    // --- WIZARD: текстовый ввод ---
    ask_user_input: async ({ question, hint, default_value }) => {
        console.log("\n" + "═".repeat(50));
        let prompt = `📝 ${question}`;
        if (hint) prompt += `\n   💡 ${hint}`;
        if (default_value) prompt += `\n   (Enter = "${default_value}")`;
        console.log(prompt);
        console.log("─".repeat(50));

        const answer = await ask("> ");
        const result = answer || default_value || "";
        return `Пользователь ввёл: "${result}"`;
    },

    // --- WIZARD: подтверждение ---
    ask_user_confirm: async ({ question, details }) => {
        console.log("\n" + "═".repeat(50));
        console.log(`❓ ${question}`);
        if (details) console.log(`   ${details}`);
        console.log("─".repeat(50));

        const answer = await ask("Да/Нет [y/n]: ");
        const confirmed = ["y", "д", "да", "yes"].includes(answer.toLowerCase());
        return confirmed ? "Пользователь подтвердил: ДА" : "Пользователь отказал: НЕТ";
    },
};

// ============================================================
// AGENT LOOP (с async handlers)
// ============================================================

async function interactiveAgent(task: string, systemPrompt?: string) {
    const defaultSystem = `Ты умный ассистент-визард, который помогает пользователю решать задачи.

СТИЛЬ РАБОТЫ:
1. Сначала разберись в ситуации (read_file, run_bash, think)
2. Проанализируй и подготовь варианты
3. Предложи пользователю выбор через ask_user_choice
4. На основе выбора — действуй или уточни детали через ask_user_input
5. Перед изменяющими действиями — подтверди через ask_user_confirm или write_file

ПРИНЦИПЫ:
- Не делай предположений — спрашивай
- Предлагай 2-4 варианта с понятными описаниями
- Объясняй плюсы и минусы каждого варианта
- Разбивай сложные решения на шаги (wizard)
- Уважай выбор пользователя, не навязывай своё мнение`;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt || defaultSystem },
        { role: "user", content: task },
    ];

    let iteration = 0;

    while (iteration < 30) {
        iteration++;

        const response = await client.chat.completions.create({
            model: MODEL,
            messages,
            tools,
        });

        const message = response.choices[0].message;
        messages.push(message);

        // Если агент говорит текстом — показываем и продолжаем диалог
        if (!message.tool_calls?.length) {
            console.log(`\n🤖 ${message.content}`);

            // Спрашиваем, хочет ли пользователь продолжить
            const follow = await ask("\n> (Enter чтобы завершить, или введите сообщение): ");
            if (!follow) {
                console.log("\n👋 Завершено.");
                rl.close();
                return;
            }

            messages.push({ role: "user", content: follow });
            continue;
        }

        // Обрабатываем tool calls
        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            // Логирование (кроме интерактивных — они сами себя показывают)
            if (name === "think") {
                console.log(`\n  💭 ${args.thought}`);
            } else if (!name.startsWith("ask_user") && name !== "write_file") {
                const preview = JSON.stringify(args).slice(0, 100);
                console.log(`  🔧 ${name}(${preview})`);
            }

            const handler = toolHandlers[name];
            let result: string;

            if (handler) {
                const output = handler(args);
                result = output instanceof Promise ? await output : output;
            } else {
                result = `Tool "${name}" не найден`;
            }

            // Логируем результат (кроме интерактивных и think)
            if (!name.startsWith("ask_user") && name !== "write_file" && name !== "think") {
                console.log(`     → ${result.slice(0, 120)}`);
            }

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
    }

    rl.close();
}

// ============================================================
// СЦЕНАРИИ
// ============================================================

async function main() {
    const scenario = process.argv[2] ?? "project";

    switch (scenario) {
        // --- Сценарий 1: Wizard для инициализации проекта ---
        case "project":
            await interactiveAgent(
                "Помоги мне создать новый TypeScript проект. " +
                "Спроси что за проект, предложи варианты структуры, настрой всё."
            );
            break;

        // --- Сценарий 2: Рефакторинг с подтверждениями ---
        case "refactor":
            await interactiveAgent(
                "Проанализируй .ts файлы в src/ и предложи рефакторинг. " +
                "Покажи мне варианты, дай выбрать что делать, и выполни с подтверждениями."
            );
            break;

        // --- Сценарий 3: свободный режим ---
        case "free":
            console.log("🤖 Интерактивный агент запущен. Введите задачу:\n");
            const task = await ask("> ");
            await interactiveAgent(task);
            break;

        default:
            console.log("Сценарии: npx tsx src/08-interactive-agent.ts [project|refactor|free]");
            rl.close();
    }
}

main();
