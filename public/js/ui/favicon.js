let lastWaitingCount = -1;

export function updateFavicon(waitingCount) {
  if (waitingCount === lastWaitingCount) return;
  lastWaitingCount = waitingCount;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return;

  const center = size / 2;
  const accent = waitingCount ? '#ff5d63' : '#35d6c4';
  context.fillStyle = '#090c11';
  if (context.roundRect) {
    context.beginPath();
    context.roundRect(0, 0, size, size, 16);
    context.fill();
  } else {
    context.fillRect(0, 0, size, size);
  }
  context.strokeStyle = accent;
  context.globalAlpha = 0.5;
  context.lineWidth = 4;
  context.beginPath();
  context.arc(center, center, 15, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 0.22;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(center, center, 24, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 1;
  context.fillStyle = accent;
  context.beginPath();
  context.arc(center, center, 8, 0, Math.PI * 2);
  context.fill();

  if (waitingCount > 0) {
    const badgeX = size - 17;
    const badgeY = 17;
    context.fillStyle = '#ff3b41';
    context.beginPath();
    context.arc(badgeX, badgeY, 16, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = '#090c11';
    context.stroke();
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = 'bold 22px -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(waitingCount > 9 ? '9+' : String(waitingCount), badgeX, badgeY + 1);
  }

  try {
    const link = /** @type {HTMLLinkElement|null} */ (document.getElementById('favicon'));
    if (link) link.href = canvas.toDataURL('image/png');
  } catch {
    // Canvas may be unavailable in a restricted browser context; the static favicon remains.
  }
}
