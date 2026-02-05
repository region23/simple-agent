// src/06-planning.ts
// Агент с планированием: сначала думает, потом делает
import OpenAI from "openai";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

const MODEL = "anthropic/claude-sonnet-4.5";

// ============================================================
// TOOLS (те же что в 05, но добавляем think tool)
// ============================================================

const tools: OpenAI.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "think",
            description:
                "Используй этот инструмент чтобы подумать, спланировать или порассуждать. " +
                "Результат не виден пользователю — это твой внутренний блокнот.",
            parameters: {
                type: "object",
                properties: {
                    thought: {
                        type: "string",
                        description: "Твои мысли, план, рассуждения",
                    },
                },
                required: ["thought"],
            },
        },
    },
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
];

const toolHandlers: Record<string, (args: any) => string> = {
    think: ({ thought }) => {
        // Think tool ничего не делает — просто возвращает подтверждение.
        // Вся ценность в том, что модель "проговорила" мысль.
        return "OK";
    },
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
    write_file: ({ path, content }) => {
        try {
            writeFileSync(path, content, "utf-8");
            return `✅ Файл ${path} записан (${content.length} байт)`;
        } catch (e: any) {
            return `Ошибка: ${e.message}`;
        }
    },
};

// ============================================================
// ПОДХОД 1: Plan-then-Execute
// Два отдельных этапа: сначала план, потом выполнение
// ============================================================

async function planThenExecute(userMessage: string) {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║   ПОДХОД 1: Plan-then-Execute            ║");
    console.log("╚══════════════════════════════════════════╝\n");

    // --- ФАЗА 1: Планирование (без tools!) ---
    console.log("📋 ФАЗА 1: ПЛАНИРОВАНИЕ\n");

    const planResponse = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: "system",
                content: `Ты планировщик задач. Получив запрос пользователя, составь пошаговый план.

Правила:
- Каждый шаг должен быть конкретным и выполнимым
- Используй формат JSON
- НЕ выполняй задачу, только спланируй

Доступные инструменты:
- run_bash: выполнить bash-команду
- read_file: прочитать файл
- write_file: записать файл

Ответь ТОЛЬКО валидным JSON в формате:
{
  "goal": "краткое описание цели",
  "steps": [
    { "id": 1, "action": "описание шага", "tool": "имя_tool", "reason": "зачем" },
    ...
  ]
}`,
            },
            { role: "user", content: userMessage },
        ],
    });

    const planText = planResponse.choices[0].message.content ?? "";

    // Парсим план
    let plan: { goal: string; steps: { id: number; action: string; tool: string; reason: string }[] };
    try {
        // Убираем возможные markdown-обёртки
        const cleanJson = planText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        plan = JSON.parse(cleanJson);
    } catch (e) {
        console.log("❌ Не удалось распарсить план:");
        console.log(planText);
        return;
    }

    console.log(`🎯 Цель: ${plan.goal}`);
    console.log(`📝 Шагов: ${plan.steps.length}\n`);
    plan.steps.forEach((s) => {
        console.log(`   ${s.id}. [${s.tool}] ${s.action}`);
        console.log(`      └─ ${s.reason}`);
    });

    // --- ФАЗА 2: Выполнение (с tools) ---
    console.log("\n\n⚡ ФАЗА 2: ВЫПОЛНЕНИЕ\n");

    const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: `Ты исполнитель задач. Выполни план пошагово, используя инструменты.

ПЛАН:
${JSON.stringify(plan, null, 2)}

Выполняй шаги по порядку. После каждого шага сообщай прогресс.
Если шаг не получился — адаптируй план.
Когда все шаги выполнены — подведи итог.`,
        },
        { role: "user", content: userMessage },
    ];

    let iteration = 0;

    while (iteration < 15) {
        iteration++;
        console.log(`\n--- Выполнение: итерация ${iteration} ---`);

        const response = await client.chat.completions.create({
            model: MODEL,
            messages,
            tools,
        });

        const message = response.choices[0].message;
        messages.push(message);

        if (!message.tool_calls?.length) {
            console.log("\n✅ Выполнение завершено.");
            console.log("Итог:", message.content);
            return;
        }

        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            const argsPreview =
                name === "write_file"
                    ? `{path: "${args.path}", content: [${args.content.length} chars]}`
                    : JSON.stringify(args);

            console.log(`   🔧 ${name}(${argsPreview})`);

            const result = toolHandlers[name]?.(args) ?? `Tool "${name}" не найден`;
            console.log(`   → ${result.slice(0, 120)}`);

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
    }
}

// ============================================================
// ПОДХОД 2: ReAct (Reasoning + Acting)
// Думает и действует на каждом шаге через think tool
// ============================================================

async function reactAgent(userMessage: string) {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║   ПОДХОД 2: ReAct (Reason + Act)         ║");
    console.log("╚══════════════════════════════════════════╝\n");

    const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: `Ты агент, который решает задачи пошагово.

МЕТОД РАБОТЫ:
1. Перед КАЖДЫМ действием сначала вызови tool "think" — обдумай:
   - Что уже известно?
   - Какой следующий шаг?
   - Почему именно этот шаг?
2. Затем выполни действие нужным tool
3. После получения результата снова "think" — оцени:
   - Получилось ли?
   - Что это значит?
   - Какой следующий шаг?

ВАЖНО: Всегда чередуй think → action → think → action.
Не делай действий без предварительного обдумывания.

Доступные инструменты: think, run_bash, read_file, write_file.`,
        },
        { role: "user", content: userMessage },
    ];

    let iteration = 0;

    while (iteration < 20) {
        iteration++;

        const response = await client.chat.completions.create({
            model: MODEL,
            messages,
            tools,
        });

        const message = response.choices[0].message;
        messages.push(message);

        if (!message.tool_calls?.length) {
            console.log(`\n✅ Агент завершил работу (${iteration} итераций).`);
            console.log("Ответ:", message.content);
            return;
        }

        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            if (name === "think") {
                // Красиво выводим мысли агента
                console.log(`\n💭 [Мысль]: ${args.thought}`);
            } else {
                const argsPreview =
                    name === "write_file"
                        ? `{path: "${args.path}", content: [${args.content.length} chars]}`
                        : JSON.stringify(args);
                console.log(`   🔧 ${name}(${argsPreview})`);

                const result = toolHandlers[name]?.(args) ?? `Tool "${name}" не найден`;
                console.log(`   → ${result.slice(0, 120)}`);

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result,
                });
                continue;
            }

            // Think всегда возвращает OK
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: "OK",
            });
        }
    }
}

// ============================================================
// MAIN: выбери подход
// ============================================================

async function main() {
    const task =
        "Проанализируй все .ts файлы в директории src/. " +
        "Найди дублирование кода между файлами (общие паттерны, " +
        "повторяющиеся импорты, похожие функции). " +
        "Создай файл REFACTORING.md с конкретными рекомендациями по рефакторингу.";

    // Раскомментируй нужный подход:
    const approach = process.argv[2] ?? "plan";

    if (approach === "plan") {
        await planThenExecute(task);
    } else if (approach === "react") {
        await reactAgent(task);
    } else {
        console.log("Использование: npx tsx src/06-planning.ts [plan|react]");
    }
}

main();
