# Спайк T0.1: Node 26, модель разрешений, `_debugProcess`, QuickJS

Дата: 2026-11-14. Код спайка лежал вне репозитория (scratchpad сессии); в репозитории изменились только этот файл, чекбоксы task-01 и Progress Tracking плана.

## Итог в одном абзаце

Всё, на что опирается дизайн, держится на Windows и на Linux. Под `--permission` с пустым `env` каждый путь UC-E4 получает отказ, слушатели родителя не получили ни одного соединения, файл не записан, `.env` вне разрешённых каталогов не прочитан. QuickJS 0.32.0 (сборка bellard, `release-sync`) компилирует WASM и исполняет код без `--allow-wasi`. Инспектор процесса-«API» открывается только в контрольной строке (нет `--disable-sigusr1` и `_debugProcess` не удалён); флаг или удаление закрывают путь по отдельности, вместе — с запасом. Скорость с большим запасом: пустой скрипт p95 = 73 мс (NFR-02: ≤ 2 с), 21 000 записей / 6,4 МБ — 0,21 с (NFR-01: ≤ 30 с).

Одна поправка к дизайну: **модель разрешений проверяет путь чтения по написанию, а не по реальному пути — ссылка внутри разрешённого каталога ведёт куда угодно**. Спайк прочитал файл-сторож `.env` через junction/symlink в разрешённом каталоге (Windows и Linux). Поэтому разрешать чтение корня пакета `code-runner` (там `node_modules` со ссылками) нельзя: разрешается только каталог без ссылок, где лежит вход исполнителя (`dist`), и три записи хранилища pnpm для QuickJS; QuickJS ребёнок импортирует по абсолютному пути. Ниже — точный список.

## Окружение

| Что | Значение |
|---|---|
| Хост | Windows 11 Pro 10.0.26300, Node системы `v24.11.0` (`C:\Program Files\nodejs`) — не переключался |
| Node 26 (`N26`) | `C:\Users\tundr\AppData\Roaming\nvm\v26.13.1\node.exe`, `v26.13.1` (новейшая 26.x на `nodejs.org/dist/latest-v26.x/`) |
| Как установлен Node 26 | `nvm.exe` в неинтерактивной оболочке зависает на любой команде, даже `nvm version` (процесс висит без вывода, снят `taskkill`). Поэтому сделано то же, что делает `nvm install`: официальный `node-v26.13.1-win-x64.zip` скачан с `nodejs.org`, SHA-256 сверен с `SHASUMS256.txt` (`e2edda75…74f1f7`), архив распакован в каталог nvm `v26.13.1`. `nvm use` не запускался |
| Проверка префикса | `PATH="/c/Users/tundr/AppData/Roaming/nvm/v26.13.1:$PATH" node -v` → `v26.13.1`; `… pnpm exec node -v` → `v26.13.1`; `node -v` без префикса → `v24.11.0` |
| pnpm | 10.9.0 |
| Linux | `node:26-bookworm` (Node `v26.13.1`), Docker 27.2.0 на WSL2, ядро 5.15.153.1, пользователь `node` (не root) |
| `quickjs-emscripten` | **0.32.0** (новейшая) |
| Пакеты варианта bellard `sync` | `quickjs-emscripten-core@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0` (вариант, README: сборка bellard; файл `dist/emscripten-module.wasm`), `@jitl/quickjs-ffi-types@0.32.0` (зависимость core). Зонтичный `quickjs-emscripten` не нужен: он тянет ещё три варианта (`debug-sync`, `release-asyncify`, `debug-asyncify`) |
| Загрузка | `newQuickJSWASMModuleFromVariant(variant)` из core с вариантом `@jitl/quickjs-wasmfile-release-sync` |
| Вне репозитория | `nest`: `apps/api/node_modules/@nestjs/cli` 12.0.11 (только чтение); `vitest` 4.1.12 |

Раскладка спайка повторяла репозиторий: workspace pnpm, пакет `runner` с зависимостями-ссылками в `runner/node_modules` и реальными каталогами в `node_modules/.pnpm/<имя>@<версия>/node_modules/<имя>`. Реальные пути (Windows, спайк):

```
runner/node_modules/quickjs-emscripten-core
  -> <корень>/node_modules/.pnpm/quickjs-emscripten-core@0.32.0/node_modules/quickjs-emscripten-core
runner/node_modules/@jitl/quickjs-wasmfile-release-sync
  -> <корень>/node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@0.32.0/node_modules/@jitl/quickjs-wasmfile-release-sync
<core>/../@jitl/quickjs-ffi-types
  -> <корень>/node_modules/.pnpm/@jitl+quickjs-ffi-types@0.32.0/node_modules/@jitl/quickjs-ffi-types
```

## Флаги `spawn` и пути чтения (для task-03)

```
spawn(process.execPath, [
  '--permission',
  '--allow-fs-read=<packages/code-runner/dist>',                                                   // вход исполнителя; в каталоге нет ссылок
  '--allow-fs-read=<корень>/node_modules/.pnpm/quickjs-emscripten-core@0.32.0/node_modules',
  '--allow-fs-read=<корень>/node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@0.32.0/node_modules',
  '--allow-fs-read=<корень>/node_modules/.pnpm/@jitl+quickjs-ffi-types@0.32.0/node_modules',
  '--max-old-space-size=64',
  '<packages/code-runner/dist>/<вход>.js',
], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
```

- Пути — абсолютные, без `*`: каталог в `--allow-fs-read` на Node 26 разрешает всё под собой (Windows и Linux).
- Пути QuickJS процесс API вычисляет при старте, не зашивает: `import.meta.resolve('quickjs-emscripten-core')` (у core в `exports` нет `./package.json`) и `import.meta.resolve('@jitl/quickjs-wasmfile-release-sync')` → `fs.realpathSync` → подняться до каталога `node_modules` записи хранилища (для `@scope/name` — на два уровня выше корня пакета, для `name` — на один). `@jitl/quickjs-ffi-types` — `realpath(<корень core>/../@jitl/quickjs-ffi-types)`.
- Процесс исполнителя импортирует QuickJS **по абсолютному пути**, который передаёт процесс API: `import(pathToFileURL(<core>/dist/index.mjs))` и `import(pathToFileURL(<вариант>/dist/index.mjs))`. Голый спецификатор `'quickjs-emscripten-core'` из `dist` ищет `packages/code-runner/node_modules/...`, а этот путь не разрешён — отказ `readPackageJSON`.
- Записи хранилища (`.pnpm/<имя>@<версия>/node_modules`) разрешаются целиком, а не только каталог пакета: core разрешает `@jitl/quickjs-ffi-types` через ссылку в своей записи хранилища. С одними каталогами пакетов (`packageDirsOnly`) ребёнок падает на `readPackageJSON` — проверено.
- `--max-old-space-size=64` хватает на 6,4 МБ данных: память QuickJS — это `ArrayBuffer` WASM, не старая куча V8.
- Вход исполнителя в тестах (путь входа — параметр, KD-1) тоже должен лежать в каталоге без ссылок.

Три проверенных набора путей чтения (Windows и Linux дают одно и то же):

| Набор | QuickJS грузится | `.env` через ссылку в разрешённом каталоге |
|---|---|---|
| корень пакета исполнителя + каталоги пакетов QuickJS (`packageDirsOnly`) | нет: `ERR_ACCESS_DENIED` в `readPackageJSON` | **прочитан** |
| корень пакета исполнителя + записи хранилища (`storeEntries`) | да | **прочитан** |
| только корень пакета исполнителя (`runnerDirOnly`) | нет: `ERR_ACCESS_DENIED` в `readFileSync` (по реальному пути) | **прочитан** |
| **`dist` без ссылок + записи хранилища + импорт по пути (`distOnly`, выбран)** | **да** | **`ERR_ACCESS_DENIED`** |

## Таблица «строка → Windows → Linux»

Набор путей — `distOnly`. Ребёнок: `spawn` с флагами выше, `env: {}`. Родитель держал TCP-сервер, UDP-сокет, именованный канал `\\.\pipe\spike-<pid>` (Linux — unix-сокет) и файл-сторож `.env` во временном каталоге вне разрешённых.

| Строка | Проба | Windows | Linux |
|---|---|---|---|
| (а) | старт с `env: {}` | стартует, код 0 | стартует, код 0 |
| (а) | ключи `process.env` ребёнка | `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR` — секретов нет, `NODE_OPTIONS` нет | пусто |
| (б) | чтение своего файла (`dist/child.mjs`) | читается | читается |
| (б) | `package.json` core и `.wasm` варианта по реальному пути | читаются | читаются |
| (б) | те же пакеты через ссылку `runner/node_modules/...` | `ERR_ACCESS_DENIED` (корень пакета не разрешён; с корнем — читается) | `ERR_ACCESS_DENIED` (то же) |
| (б) | сторож `.env` по прямому пути | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| (б) | сторож `.env` через junction/symlink в корне пакета | `ERR_ACCESS_DENIED` (если бы корень был разрешён — читается) | `ERR_ACCESS_DENIED` (то же) |
| (б) | `package.json` в каталоге выше | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| (в) | `net.connect` TCP | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `http.get` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `fetch` | отказ: `TypeError: fetch failed`, `cause` — `ERR_ACCESS_DENIED` | то же |
| (в) | `dns.lookup`, `dns.promises.resolve4` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `dgram` `send` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | именованный канал / unix-сокет | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `net.createServer().listen` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `child_process.spawn`, `execSync` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `new Worker` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `process.dlopen` | отказ `ERR_DLOPEN_DISABLED` (`--permission` выключает аддоны) | то же |
| (в) | `process.binding('fs')` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | `inspector.open()` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | запись файла (свой каталог, каталог сторожа) | отказ `ERR_ACCESS_DENIED`, файлов нет | то же |
| (в) | `new WASI()` | отказ `ERR_ACCESS_DENIED` | отказ `ERR_ACCESS_DENIED` |
| (в) | слушатели родителя | 0 соединений TCP/канал, 0 пакетов UDP | 0 / 0 |
| (г) | QuickJS `1+1` под `--permission` без `--allow-wasi` | `2`, 23 мс с загрузкой WASM | `2`, 25 мс |
| (г) | глобальные в context QuickJS | `Intl`, `console`, `setTimeout` — `undefined` | то же |
| (д) | API **без** флага, ребёнок без подготовки → `_debugProcess(pid API)` | **инспектор открылся** (`Debugger listening`, `inspector.url()` = `ws://127.0.0.1:9229/…`) — контроль | **открылся** — контроль |
| (д) | API **без** флага, ребёнок после подготовки | `_debugProcess` = `undefined`, пути нет; инспектор закрыт | то же |
| (д) | API **с** `--disable-sigusr1`, ребёнок без подготовки | вызов бросает `The system cannot find the file specified` (Windows: механизм не сигнал; по тексту ошибки — процесс с флагом не создаёт объект, через который `_debugProcess` его находит); инспектор закрыт | вызов проходит (сигнал отправлен), инспектор закрыт |
| (д) | API **с** `--disable-sigusr1`, ребёнок после подготовки | пути нет; инспектор закрыт | то же |

Что ещё видно из (в) и (д): `process.dlopen` и `process.binding` модель разрешений и так закрывает; единственное, что она не закрывает, — `process._debugProcess`. Удаление трёх свойств при подготовке остаётся как дешёвая вторая преграда.

## Скорость (Windows, те же флаги, набор `distOnly`)

| Замер | Как | Итог | Требование |
|---|---|---|---|
| NFR-02, пустой скрипт | 50 запусков подряд, от `spawn` до кадра итога: подготовка, загрузка QuickJS, runtime/context с пределами памяти, стека и прерывания, `(async () => {})()` | min 57 мс, p50 60 мс, **p95 73 мс**, max 89 мс | ≤ 2 с |
| NFR-01, 5 МБ | 21 000 записей формы `search_logs` (поля `LogRecord` из `packages/mcp-fixture/src/dataset.ts`, страница как в `search-logs.ts`: `snapshot`, `records`, `totalMatched`, `totalRelation`, `nextCursor`), 42 страницы по 500, **6,38 МБ JSON**. Скрипт QuickJS ходит по страницам через `callTool` (кадр «длина + JSON» → ответ процесса API → `JSON.parse` внутри QuickJS) и группирует ошибки по сервису | **228 / 205 / 210 мс** (три запуска), итог верен (`n = 21000`, 1050 ошибок на сервис) | ≤ 30 с |

Мост в спайке устроен так, как его описывает дизайн: вызов из скрипта возвращает обещание QuickJS, процесс исполнителя пишет кадр просьбы в stdout, ответ из stdin разрешает обещание, затем `executePendingJobs`. Вариант `sync` для этого достаточен — asyncify не нужен.

## `--disable-sigusr1` для `apps/api` и опция vitest

- `NODE_OPTIONS=--disable-sigusr1 node -e …` — флаг допускается в `NODE_OPTIONS` (код 0). Не выбран: `NODE_OPTIONS` наследуют все дочерние процессы API (серверы MCP по stdio), а в скриптах `package.json` переменная окружения на Windows требует `cross-env`.
- `nest start --exec "node --disable-sigusr1"` — работает. В `@nestjs/cli` 12.0.11 `--shell` по умолчанию `true`, и `start.action.js:spawnChildProcess` склеивает `[binaryToRun, ...processArgs].join(' ')` и запускает через оболочку. Проверено тем же вызовом: процесс получил `execArgv = ['--disable-sigusr1', '--enable-source-maps']`.
- **Выбранная форма** (для T1.1): `start` — `nest start --exec "node --disable-sigusr1"`; `start:dev` и `dev` — `nest start --watch --exec "node --disable-sigusr1"`; `start:prod` — `node --disable-sigusr1 dist/main`. `start:debug` не меняется.
- **vitest 4.1.12: `test.execArgv: ['--disable-sigusr1']`** (`InlineConfig.execArgv`, «Pass additional arguments to `node` process when spawning the worker»). Действует на пул `forks` — он по умолчанию, в конфигурациях репозитория `pool` не задан. Проверено: процесс-работник получает флаг, `_debugProcess(pid работника)` из другого процесса бросает `The system cannot find the file specified`; в контрольном прогоне без опции вызов проходит.

## Вердикт по утверждениям дизайна

| Утверждение | Вердикт |
|---|---|
| KD-1: QuickJS (bellard, `sync`) в WASM в отдельном процессе Node 26 с `--permission` | Подтверждено. Версия 0.32.0, пакеты core + `@jitl/quickjs-wasmfile-release-sync`. Запасной `isolated-vm` не нужен |
| KD-1: две преграды — язык без возможностей + процесс без сети, записи, процессов, потоков, аддонов, секретов | Подтверждено на Windows и Linux (таблица, строки (в)) |
| Constraints: Node 26 одной версией, сеть закрывается только с Node 25+ | Подтверждено: на 26.13.1 все сетевые пути — `ERR_ACCESS_DENIED`, `process.permission.has('net')` = `false` |
| Constraints: процесс API стартует с `--disable-sigusr1` | Подтверждено и нужно: без флага и без подготовки ребёнок открывает инспектор API на обеих ОС. Форма — выше |
| Подготовка удаляет `_debugProcess`, `dlopen`, `binding` | Подтверждено: после удаления пути к вызову нет. Только `_debugProcess` не закрыт моделью разрешений |
| Security Considerations: чтение только каталога исполнителя и пакета QuickJS | **Уточнено**: проверка пути — по написанию, ссылки внутри разрешённого каталога ведут наружу (сторож прочитан). Разрешать корень пакета с `node_modules` нельзя; разрешается `dist` без ссылок + записи хранилища QuickJS, QuickJS импортируется по абсолютному пути (раздел «Флаги»). Дописать в Security Considerations и ADR |
| Security Considerations: на Windows libuv добавляет системные переменные | Подтверждено, список точнее: 11 ключей (таблица, строка (а)); секретов и `NODE_OPTIONS` нет. В Linux окружение пустое |
| Risks: флаги на Windows ведут себя не по документации | Снят для сети, процессов, потоков, аддонов, инспектора, WASI, записи. Поведение ссылок — известное ограничение из документации Node ([Permissions](https://nodejs.org/api/permissions.html): символические ссылки проходят и за пределы разрешённых путей), на Windows (junction) и на Linux одинаково; закрыто выбором путей |
| Risks: QuickJS в WASM слишком медленный | Снят: p95 пустого скрипта 73 мс, 6,4 МБ — 0,21 с |
| `--allow-wasi` не нужен для WASM | Подтверждено: WASM компилируется без него, `new WASI()` — отказ |

Набор проб повторяет E2E-2 (task-05); там он доказывается окончательно, в том числе в CI на Linux.
