// src/07-adaptive-agent.ts
// Адаптивный агент: Plan → ReAct Execute → Replan если нужно
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
// TOOLS
// ============================================================

const executionTools: OpenAI.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "think",
            description:
                "Внутренний блокнот. Используй перед действием чтобы обдумать следующий шаг, " +
                "и после действия чтобы оценить результат.",
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
    {
        type: "function",
        function: {
            name: "request_replan",
            description:
                "Вызови когда план нужно пересмотреть: обнаружилась новая информация, " +
                "шаг провалился, или появился лучший путь к цели.",
            parameters: {
                type: "object",
                properties: {
                    reason: { type: "string", description: "Почему нужен новый план" },
                    completed_steps: {
                        type: "array",
                        items: { type: "string" },
                        description: "Какие шаги уже выполнены",
                    },
                    discoveries: {
                        type: "array",
                        items: { type: "string" },
                        description: "Что нового узнали",
                    },
                },
                required: ["reason", "completed_steps", "discoveries"],
            },
        },
    },
];

const toolHandlers: Record<string, (args: any) => string> = {
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
    write_file: ({ path, content }) => {
        try {
            writeFileSync(path, content, "utf-8");
            return `✅ Файл ${path} записан (${content.length} байт)`;
        } catch (e: any) {
            return `Ошибка: ${e.message}`;
        }
    },
    request_replan: () => "REPLAN_REQUESTED",
};

// ============================================================
// ФАЗА 1: ПЛАНИРОВАНИЕ
// ============================================================

interface Plan {
    goal: string;
    steps: { id: number; action: string; tool: string; reason: string }[];
}

async function createPlan(
    task: string,
    context?: { previousPlan?: Plan; completedSteps?: string[]; discoveries?: string[] }
): Promise<Plan> {
    let systemPrompt = `Ты стратегический планировщик. Составь пошаговый план выполнения задачи.

Доступные инструменты: run_bash, read_file, write_file.

Ответь ТОЛЬКО валидным JSON:
{
  "goal": "краткое описание цели",
  "steps": [
    { "id": 1, "action": "описание", "tool": "имя_tool", "reason": "зачем" }
  ]
}`;

    // Если это реплан — добавляем контекст
    if (context?.previousPlan) {
        systemPrompt += `

КОНТЕКСТ РЕПЛАНА:
Предыдущий план: ${JSON.stringify(context.previousPlan)}
Уже выполнено: ${context.completedSteps?.join(", ") || "ничего"}
Новые данные: ${context.discoveries?.join("; ") || "нет"}

Учти что уже сделано, не повторяй выполненные шаги.
Скорректируй план с учётом новых данных.`;
    }

    const response = await client.chat.completions.create({
        model: MODEL,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: task },
        ],
    });

    const text = response.choices[0].message.content ?? "";
    const cleanJson = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleanJson);
}

function printPlan(plan: Plan, isReplan: boolean = false) {
    const label = isReplan ? "🔄 НОВЫЙ ПЛАН" : "📋 ПЛАН";
    console.log(`\n${label}: ${plan.goal}`);
    console.log("─".repeat(50));
    plan.steps.forEach((s) => {
        console.log(`  ${s.id}. [${s.tool}] ${s.action}`);
        console.log(`     └─ ${s.reason}`);
    });
    console.log("─".repeat(50));
}

// ============================================================
// ФАЗА 2: ВЫПОЛНЕНИЕ с ReAct + возможностью реплана
// ============================================================

interface ExecutionResult {
    status: "completed" | "replan_requested";
    replanContext?: {
        reason: string;
        completedSteps: string[];
        discoveries: string[];
    };
}

async function executeWithReact(
    task: string,
    plan: Plan
): Promise<ExecutionResult> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: `Ты исполнитель с аналитическим мышлением.

ТВОЙ ПЛАН:
${JSON.stringify(plan, null, 2)}

МЕТОД РАБОТЫ:
1. Перед каждым действием — вызови "think": обдумай шаг, проверь что он всё ещё актуален
2. Выполни действие нужным tool
3. После результата — снова "think": оцени, совпало ли с ожиданиями
4. Если обнаружил что план нужно менять — вызови "request_replan"

КОГДА ВЫЗЫВАТЬ request_replan:
- Обнаружил что-то неожиданное (файлов больше/меньше чем думали)
- Шаг провалился и обходной путь требует нового плана
- Появилась информация, которая делает оставшиеся шаги неактуальными
- Нашёл более эффективный путь к цели

НЕ вызывай replan для мелких проблем — адаптируйся на лету.
Вызывай только когда нужна существенная коррекция курса.`,
        },
        { role: "user", content: task },
    ];

    let iteration = 0;

    while (iteration < 20) {
        iteration++;

        const response = await client.chat.completions.create({
            model: MODEL,
            messages,
            tools: executionTools,
        });

        const message = response.choices[0].message;
        messages.push(message);

        if (!message.tool_calls?.length) {
            console.log(`\n✅ Выполнение завершено (${iteration} итераций)`);
            console.log("Итог:", message.content?.slice(0, 300));
            return { status: "completed" };
        }

        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            // Форматированный вывод
            if (name === "think") {
                console.log(`\n  💭 ${args.thought}`);
            } else if (name === "request_replan") {
                console.log(`\n  🔄 РЕПЛАН: ${args.reason}`);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: "REPLAN_REQUESTED",
                });
                return {
                    status: "replan_requested",
                    replanContext: {
                        reason: args.reason,
                        completedSteps: args.completed_steps,
                        discoveries: args.discoveries,
                    },
                };
            } else {
                const argsPreview =
                    name === "write_file"
                        ? `{path: "${args.path}", content: [${args.content.length} chars]}`
                        : JSON.stringify(args);
                console.log(`  🔧 ${name}(${argsPreview})`);

                const result = toolHandlers[name]?.(args) ?? `Tool "${name}" не найден`;
                console.log(`     → ${result.slice(0, 120)}`);
            }

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: toolHandlers[name]?.(args) ?? "OK",
            });
        }
    }

    return { status: "completed" };
}

// ============================================================
// ГЛАВНЫЙ ЦИКЛ: Plan → Execute → Replan → Execute → ...
// ============================================================

async function adaptiveAgent(task: string) {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║   ADAPTIVE AGENT: Plan + ReAct + Replan      ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`\n📌 Задача: ${task}\n`);

    let plan = await createPlan(task);
    printPlan(plan);

    const MAX_REPLANS = 3;
    let replanCount = 0;

    while (replanCount <= MAX_REPLANS) {
        console.log(`\n⚡ ВЫПОЛНЕНИЕ (план v${replanCount + 1})\n`);

        const result = await executeWithReact(task, plan);

        if (result.status === "completed") {
            console.log("\n🎉 Агент завершил задачу.");
            return;
        }

        // Реплан
        replanCount++;
        if (replanCount > MAX_REPLANS) {
            console.log("\n⚠️  Достигнут лимит репланов. Завершаем с текущим результатом.");
            return;
        }

        console.log(`\n📋 РЕПЛАН #${replanCount}...`);
        plan = await createPlan(task, {
            previousPlan: plan,
            completedSteps: result.replanContext?.completedSteps,
            discoveries: result.replanContext?.discoveries,
        });
        printPlan(plan, true);
    }
}

// ============================================================
// ЗАПУСК
// ============================================================

const task =
    process.argv[2] ||
    "Проанализируй все .ts файлы в директории src/. " +
    "Найди дублирование кода между файлами (общие паттерны, " +
    "повторяющиеся импорты, похожие функции). " +
    "Создай файл REFACTORING.md с конкретными рекомендациями.";

adaptiveAgent(task);
