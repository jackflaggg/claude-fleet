/**
 * Entry локального дашборда: читает `.env` и окружение, собирает экземпляр через
 * `createFleet` (`src/fleet.js`, там все маршруты и состояние) и слушает порт.
 * На этот файл смотрят plist launchd и `npm start`, поэтому он остаётся в корне.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyEnvFile, loadConfig } from './src/config.js';
import { log } from './src/log.js';
import { createFleet } from './src/fleet.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Конфиг из .env (опционально) и окружения: имена переменных и дефолты живут в src/config.js.
applyEnvFile(join(ROOT, '.env'), { log, exists: existsSync });
const config = loadConfig(process.env, { log, exists: existsSync, root: ROOT });

const { server } = createFleet({ config, root: ROOT, log });

// Без своего обработчика ошибка listen всплывает необработанным исключением, launchd
// поднимает процесс заново - и так по кругу, а в логе только стопка стартовых строк.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`порт ${config.port} уже занят - борд уже запущен? (lsof -i :${config.port})`);
  } else {
    log(`сервер не поднялся: ${error.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log(`claude-fleet слушает http://${config.host}:${config.port}`);
});
