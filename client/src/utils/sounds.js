let ctxRef = null;

function getCtx() {
  if (ctxRef) return ctxRef;
  const AC =
    typeof window !== 'undefined' &&
    (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  ctxRef = new AC();
  return ctxRef;
}

/** 新消息提示音：轻快两声“叮咚”，无需任何音频文件 */
export function playPing() {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const t0 = ctx.currentTime;
  [
    { f: 880, t: 0.0 },
    { f: 1174.66, t: 0.11 }
  ].forEach(({ f, t }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, t0 + t);
    gain.gain.setValueAtTime(0.0001, t0 + t);
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0 + t);
    osc.stop(t0 + t + 0.18);
  });
}