# Анализ дублирования кода и рекомендации по рефакторингу

## 📊 Общая статистика

Проанализировано **6 TypeScript файлов** в директории `src/`:
- `01-basic-call.ts` - базовый вызов API
- `02-with-tool.ts` - использование одного tool
- `03-agent-loop.ts` - агентный цикл с несколькими tools
- `04-real-tools.ts` - реальные системные tools
- `05-skills.ts` - модульная система навыков
- `06-planning.ts` - агент с планированием

---

## 🔍 Выявленное дублирование

### 1. ❗ Инициализация OpenAI клиента (критично)

**Дублируется в:** всех 6 файлах

**Повторяющийся код:**
```typescript
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});
```

**Проблемы:**
- Изменение конфигурации требует правки во всех файлах
- Невозможно централизованно добавить логирование, ретраи, обработку ошибок
- Дублирование переменных окружения

**Рекомендация:** Создать общий модуль `src/lib/client.ts`

---

### 2. ❗ Определения Tools (критично)

**Дублируются tool definitions:**

#### `run_bash` tool
- **Файлы:** `04-real-tools.ts`, `06-planning.ts`
- **Идентичный JSON Schema** с description "Выполнить bash-команду"

#### `read_file` tool
- **Файлы:** `04-real-tools.ts`, `05-skills.ts`, `06-planning.ts`
- **Полностью идентичная структура**

#### `write_file` tool
- **Файлы:** `05-skills.ts`, `06-planning.ts`
- **Идентичные параметры** (path, content)

#### `get_weather` tool
- **Файлы:** `02-with-tool.ts`, `03-agent-loop.ts`
- **Одинаковая структура**, различия только в комментариях

**Проблемы:**
- При изменении API tool нужно обновлять множество мест
- Риск рассинхронизации определений
- Нет единого источника истины

**Рекомендация:** Создать `src/lib/tools.ts` с переиспользуемыми определениями

---

### 3. ❗ Tool Handlers (критично)

**Дублируются реализации:**

#### `run_bash` handler
```typescript
// В 04-real-tools.ts:
run_bash: ({ command }) => {
    try {
        return execSync(command, {
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
    } catch (e: any) {
        return `Ошибка: ${e.message}`;
    }
}

// В 05-skills.ts: идентично (timeout: 5000)
// В 06-planning.ts: почти идентично (timeout: 10000)
```

**Отличия:** только значение timeout (5000 vs 10000)

#### `read_file` handler
- **Файлы:** `04-real-tools.ts`, `05-skills.ts`, `06-planning.ts`
- **Абсолютно идентичная реализация**

#### `write_file` handler
- **Файлы:** `05-skills.ts`, `06-planning.ts`
- **Различия:** только в сообщении при успехе

**Проблемы:**
- Исправление бага требует правки в 3+ местах
- Невозможно централизованно улучшить обработку ошибок
- Нет единого подхода к timeout и error handling

**Рекомендация:** Создать `src/lib/handlers.ts` с универсальными реализациями

---

### 4. ⚠️ Паттерн Agent Loop (средняя критичность)

**Дублируется в:** `03-agent-loop.ts`, `04-real-tools.ts`, частично в `05-skills.ts`

**Повторяющаяся структура:**
```typescript
async function agentLoop(userMessage: string) {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "..." },
        { role: "user", content: userMessage },
    ];

    let iteration = 0;
    
    while (iteration < MAX_ITERATIONS) {
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
            console.log("Агент завершил работу.");
            console.log("Ответ:", message.content);
            return message.content;
        }

        for (const toolCall of message.tool_calls) {
            const name = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            const result = toolHandlers[name]?.(args) ?? `Tool не найден`;
            
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
    }
}
```

**Различия:**
- MAX_ITERATIONS: 10 (в 03), hardcoded 10 (в 04), hardcoded 10, 15, 20 (в 06)
- Формат вывода в консоль
- Обработка результатов tools

**Проблемы:**
- Логика итераций размазана по файлам
- Нет переиспользования базового цикла
- Сложно добавить общие фичи (логирование, метрики)

**Рекомендация:** Создать базовый класс `AgentExecutor` в `src/lib/executor.ts`

---

### 5. ⚠️ Константы (средняя критичность)

#### Model name
```typescript
// Используется во всех файлах, но по-разному:
// 01-06: inline "anthropic/claude-sonnet-4.5"
// Только в 06: const MODEL = "anthropic/claude-sonnet-4.5"
```

#### MAX_ITERATIONS
```typescript
// 03-agent-loop.ts: const MAX_ITERATIONS = 10;
// 04-real-tools.ts: while (iteration < 10)
// 05-skills.ts: while (iteration < 10)
// 06-planning.ts: while (iteration < 15) и while (iteration < 20)
```

**Рекомендация:** Создать `src/lib/config.ts` с общими константами

---

### 6. 📦 Повторяющиеся импорты

**Статистика импортов:**
- `import OpenAI from "openai"` - **6 файлов**
- `import dotenv from "dotenv"` - **6 файлов**
- `import { execSync } from "child_process"` - **4 файла** (04, 05, 06)
- `import { readFileSync } from "fs"` - **3 файла** (04, 05, 06)
- `import { writeFileSync } from "fs"` - **2 файла** (05, 06)

**Рекомендация:** После рефакторинга импорты будут заменены на `import { client, tools, handlers } from "./lib"`

---

## 🎯 План рефакторинга

### Этап 1: Создать общую библиотеку (высокий приоритет)

#### 1.1 `src/lib/config.ts`
```typescript
export const CONFIG = {
    MODEL: "anthropic/claude-sonnet-4.5",
    MAX_ITERATIONS: 10,
    TOOL_TIMEOUT: 5000,
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
} as const;
```

#### 1.2 `src/lib/client.ts`
```typescript
import OpenAI from "openai";
import dotenv from "dotenv";
import { CONFIG } from "./config";

dotenv.config();

export const client = new OpenAI({
    baseURL: CONFIG.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

export type { OpenAI };
```

#### 1.3 `src/lib/tools.ts`
```typescript
import { OpenAI } from "./client";

export const TOOLS = {
    run_bash: {
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
    } as OpenAI.ChatCompletionTool,

    read_file: {
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
    } as OpenAI.ChatCompletionTool,

    write_file: {
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
    } as OpenAI.ChatCompletionTool,

    think: {
        type: "function",
        function: {
            name: "think",
            description: "Подумать, спланировать или порассуждать. Результат не виден пользователю.",
            parameters: {
                type: "object",
                properties: {
                    thought: { type: "string", description: "Мысли, план, рассуждения" },
                },
                required: ["thought"],
            },
        },
    } as OpenAI.ChatCompletionTool,

    get_weather: {
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
    } as OpenAI.ChatCompletionTool,

    get_time: {
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
    } as OpenAI.ChatCompletionTool,
};
```

#### 1.4 `src/lib/handlers.ts`
```typescript
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { CONFIG } from "./config";

export type ToolHandler = (args: any) => string;

export const HANDLERS: Record<string, ToolHandler> = {
    run_bash: ({ command }) => {
        try {
            return execSync(command, {
                encoding: "utf-8",
                timeout: CONFIG.TOOL_TIMEOUT,
            }).trim();
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

    think: ({ thought }) => {
        // Think tool ничего не делает - просто логирует
        console.log(`💭 [Мысль]: ${thought}`);
        return "OK";
    },

    get_weather: ({ city }) => {
        const data: Record<string, string> = {
            "Москва": "−5°C, снег",
            "Анапа": "+8°C, облачно",
            "Лондон": "+3°C, дождь",
        };
        return data[city] ?? `Нет данных для города ${city}`;
    },

    get_time: ({ city }) => {
        const now = new Date();
        return `Сейчас в ${city}: ${now.toLocaleTimeString("ru-RU")}`;
    },
};
```

#### 1.5 `src/lib/executor.ts`
```typescript
import { client, OpenAI } from "./client";
import { CONFIG } from "./config";

export interface ExecutorOptions {
    tools: OpenAI.ChatCompletionTool[];
    handlers: Record<string, (args: any) => string>;
    systemPrompt?: string;
    maxIterations?: number;
    verbose?: boolean;
}

export class AgentExecutor {
    private tools: OpenAI.ChatCompletionTool[];
    private handlers: Record<string, (args: any) => string>;
    private systemPrompt: string;
    private maxIterations: number;
    private verbose: boolean;

    constructor(options: ExecutorOptions) {
        this.tools = options.tools;
        this.handlers = options.handlers;
        this.systemPrompt = options.systemPrompt ?? "Ты полезный ассистент.";
        this.maxIterations = options.maxIterations ?? CONFIG.MAX_ITERATIONS;
        this.verbose = options.verbose ?? true;
    }

    async run(userMessage: string): Promise<string | null> {
        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: userMessage },
        ];

        let iteration = 0;

        while (iteration < this.maxIterations) {
            iteration++;
            if (this.verbose) {
                console.log(`\n--- Итерация ${iteration} ---`);
            }

            const response = await client.chat.completions.create({
                model: CONFIG.MODEL,
                messages,
                tools: this.tools,
            });

            const message = response.choices[0].message;
            messages.push(message);

            if (!message.tool_calls?.length) {
                if (this.verbose) {
                    console.log("Агент завершил работу.");
                    console.log("Ответ:", message.content);
                }
                return message.content;
            }

            for (const toolCall of message.tool_calls) {
                const name = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);

                if (this.verbose) {
                    console.log(`Tool: ${name}(${JSON.stringify(args)})`);
                }

                const handler = this.handlers[name];
                const result = handler
                    ? handler(args)
                    : `Ошибка: tool "${name}" не найден`;

                if (this.verbose) {
                    console.log(`Результат: ${result.slice(0, 200)}`);
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result,
                });
            }
        }

        console.log(`Достигнут лимит итераций (${this.maxIterations})!`);
        return null;
    }
}
```

#### 1.6 `src/lib/index.ts`
```typescript
export { client } from "./client";
export { CONFIG } from "./config";
export { TOOLS } from "./tools";
export { HANDLERS } from "./handlers";
export { AgentExecutor } from "./executor";
export type { ToolHandler } from "./handlers";
export type { ExecutorOptions } from "./executor";
```

---

### Этап 2: Рефакторинг существующих файлов

#### Пример: `src/01-basic-call.ts` (после рефакторинга)
```typescript
import { client, CONFIG } from "./lib";

async function main() {
    const response = await client.chat.completions.create({
        model: CONFIG.MODEL,
        messages: [
            { role: "user", content: "Сколько будет 2 + 2?" }
        ],
    });

    console.log(response.choices[0].message.content);
}

main();
```

**Уменьшение:** с 23 строк до 13 строк (43% сокращение)

#### Пример: `src/03-agent-loop.ts` (после рефакторинга)
```typescript
import { AgentExecutor, TOOLS, HANDLERS } from "./lib";

const weatherTools = [TOOLS.get_weather, TOOLS.get_time];
const weatherHandlers = {
    get_weather: HANDLERS.get_weather,
    get_time: HANDLERS.get_time,
};

const agent = new AgentExecutor({
    tools: weatherTools,
    handlers: weatherHandlers,
    systemPrompt: "Ты полезный ассистент. Используй tools когда нужно.",
});

agent.run("Какая погода в Москве и Анапе? И сколько сейчас времени?");
```

**Уменьшение:** с 112 строк до 16 строк (86% сокращение)

#### Пример: `src/05-skills.ts` (после рефакторинга)
```typescript
import { AgentExecutor, TOOLS, HANDLERS } from "./lib";

// Теперь Skill это просто набор tools и handlers
interface Skill {
    name: string;
    description: string;
    tools: typeof TOOLS[keyof typeof TOOLS][];
    handlers: Record<string, typeof HANDLERS[keyof typeof HANDLERS]>;
}

const filesystemSkill: Skill = {
    name: "filesystem",
    description: "Работа с файлами",
    tools: [TOOLS.read_file, TOOLS.write_file, TOOLS.list_dir],
    handlers: {
        read_file: HANDLERS.read_file,
        write_file: HANDLERS.write_file,
        list_dir: HANDLERS.run_bash, // можно создать отдельный handler
    },
};

// Остальное остаётся практически без изменений
```

**Уменьшение дублирования:** ~70 строк определений tools и handlers

---

### Этап 3: Дополнительные улучшения (опциональные)

#### 3.1 Типобезопасность
```typescript
// src/lib/types.ts
export type ToolName = 
    | "run_bash"
    | "read_file"
    | "write_file"
    | "think"
    | "get_weather"
    | "get_time";

export type ToolArgs = {
    run_bash: { command: string };
    read_file: { path: string };
    write_file: { path: string; content: string };
    think: { thought: string };
    get_weather: { city: string };
    get_time: { city: string };
};
```

#### 3.2 Логирование
```typescript
// src/lib/logger.ts
export class Logger {
    constructor(private verbose: boolean) {}
    
    info(message: string) {
        if (this.verbose) console.log(`ℹ️  ${message}`);
    }
    
    tool(name: string, args: any) {
        if (this.verbose) console.log(`🔧 ${name}(${JSON.stringify(args)})`);
    }
    
    result(result: string) {
        if (this.verbose) console.log(`→ ${result.slice(0, 200)}`);
    }
}
```

#### 3.3 Обработка ошибок
```typescript
// src/lib/errors.ts
export class ToolExecutionError extends Error {
    constructor(
        public toolName: string,
        public originalError: Error
    ) {
        super(`Tool ${toolName} failed: ${originalError.message}`);
    }
}
```

---

## 📈 Ожидаемые результаты рефакторинга

### Метрики улучшения

| Метрика | До | После | Улучшение |
|---------|-----|-------|-----------|
| Дублирование клиента OpenAI | 6 раз | 1 раз | **-83%** |
| Дублирование tool definitions | 13 раз | 6 раз | **-54%** |
| Дублирование handlers | 9 раз | 6 раз | **-33%** |
| Строк кода в среднем файле | ~110 | ~30 | **-73%** |
| Файлов библиотеки | 0 | 6 | +6 |

### Качественные улучшения

✅ **Maintainability** (поддержка)
- Единая точка изменения для общих компонентов
- Централизованная конфигурация
- Упрощение обновлений

✅ **Testability** (тестируемость)
- Изолированные handlers можно легко тестировать
- Мокирование client в одном месте
- Unit-тесты для каждого компонента

✅ **Reusability** (переиспользование)
- Tools доступны из общей библиотеки
- AgentExecutor для любых сценариев
- Composable skills

✅ **Consistency** (согласованность)
- Единый стиль обработки ошибок
- Консистентные timeout и параметры
- Стандартизированное логирование

✅ **Scalability** (масштабируемость)
- Легко добавлять новые tools
- Простое создание новых агентов
- Модульная архитектура

---

## 🚀 Порядок внедрения

### Неделя 1: Подготовка
1. Создать директорию `src/lib/`
2. Реализовать `config.ts`, `client.ts`
3. Написать unit-тесты для новых модулей

### Неделя 2: Миграция tools
1. Реализовать `tools.ts` и `handlers.ts`
2. Создать `executor.ts`
3. Обновить тесты

### Неделя 3: Рефакторинг примеров
1. Рефакторить `01-basic-call.ts`
2. Рефакторить `02-with-tool.ts`
3. Рефакторить `03-agent-loop.ts`
4. Убедиться что все работает

### Неделя 4: Завершение
1. Рефакторить `04-real-tools.ts`
2. Рефакторить `05-skills.ts`
3. Рефакторить `06-planning.ts`
4. Финальное тестирование и документация

---

## 💡 Дополнительные рекомендации

### 1. Версионирование
- Добавить `version` в CONFIG для отслеживания изменений API

### 2. Переменные окружения
```typescript
// .env.example
OPENROUTER_API_KEY=your_key_here
LOG_LEVEL=info
MAX_ITERATIONS=10
TOOL_TIMEOUT=5000
```

### 3. Документация
- Создать `docs/ARCHITECTURE.md` с описанием архитектуры
- JSDoc комментарии для всех публичных API
- Примеры использования в README

### 4. CI/CD
- Добавить линтер (ESLint) для контроля качества
- Prettier для единого стиля кода
- Pre-commit hooks для автоматических проверок

### 5. Мониторинг
```typescript
// src/lib/metrics.ts
export class Metrics {
    static trackToolCall(name: string, duration: number) {
        // Логирование метрик использования tools
    }
    
    static trackIterations(count: number) {
        // Статистика по итерациям агента
    }
}
```

---

## 🎓 Примеры использования после рефакторинга

### Простой вызов
```typescript
import { client, CONFIG } from "./lib";

const response = await client.chat.completions.create({
    model: CONFIG.MODEL,
    messages: [{ role: "user", content: "Hello" }],
});
```

### Агент с кастомными tools
```typescript
import { AgentExecutor, TOOLS, HANDLERS } from "./lib";

const agent = new AgentExecutor({
    tools: [TOOLS.run_bash, TOOLS.read_file],
    handlers: {
        run_bash: HANDLERS.run_bash,
        read_file: HANDLERS.read_file,
    },
    systemPrompt: "Ты помощник программиста",
    maxIterations: 5,
});

await agent.run("Проанализируй package.json");
```

### Расширение существующих handlers
```typescript
import { HANDLERS } from "./lib";

const customHandlers = {
    ...HANDLERS,
    run_bash: (args) => {
        console.log(`Executing: ${args.command}`);
        return HANDLERS.run_bash(args);
    },
};
```

---

## ✅ Checklist для проверки рефакторинга

- [ ] Все тесты проходят после изменений
- [ ] Нет дублирования инициализации клиента
- [ ] Tools определены в одном месте
- [ ] Handlers не дублируются
- [ ] Константы вынесены в config
- [ ] Документация обновлена
- [ ] Примеры работают корректно
- [ ] Обратная совместимость сохранена (если нужно)
- [ ] Code review пройден
- [ ] Performance не ухудшился

---

**Создано:** Автоматический анализ кода
**Дата:** 2024
**Статус:** Готово к реализации
