/**
 * Единственный писатель fleet.log. Каждая строка со временем: без него в логе стопка
 * одинаковых строк без понимания, когда. Канал ответа пишет тем же форматом в stderr
 * (stdout у него занят транспортом MCP), поэтому писатель и префикс приходят параметрами.
 */
export function createLog({
  write = (line) => process.stdout.write(line),
  prefix = '',
  clock = () => new Date(),
} = {}) {
  const head = prefix ? `${prefix} ` : '';
  return function log(message) {
    try {
      write(`${clock().toLocaleString('ru-RU')}  ${head}${message}\n`);
    } catch {
      // лог не должен ронять процесс: сломанный stdout (EPIPE) хуже потерянной строки
    }
  };
}

export const log = createLog();
