/**
 * Чистая часть проверки живых сессий по PID.
 *
 * SessionEnd приходит только на аккуратный выход: Claude молчит при закрытии окна терминала
 * или kill, Codex шлёт его лишь через 30 минут после закрытия вкладки. PID процесса агента
 * (из $PPID hook-команды) отражает реальное положение дел. Два промаха подряд защищают
 * от короткой гонки при переподключении клиента.
 */

/** Проверяет PID без сигнала процессу. Любая ошибка кроме ESRCH трактуется безопасно: жив. */
export function isProcessAlive(pid, probe = process.kill) {
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * @param {Record<string, object>} sessions
 * @param {Set<number>} alivePids
 * @param {Map<string, number>} missingSince
 * @param {number} now
 * @param {number} graceMs
 */
export function pruneClosedSessions(sessions, alivePids, missingSince, now, graceMs) {
  const nextMissing = new Map();
  let next = sessions;

  for (const [id, card] of Object.entries(sessions)) {
    if (!Number.isSafeInteger(card?.processPid)) continue;
    if (alivePids.has(card.processPid)) continue;

    const firstMiss = missingSince.get(id);
    if (firstMiss == null) {
      nextMissing.set(id, now);
      continue;
    }
    if (now - firstMiss < graceMs) {
      nextMissing.set(id, firstMiss);
      continue;
    }

    if (next === sessions) next = { ...sessions };
    delete next[id];
  }

  return { sessions: next, missingSince: nextMissing };
}
