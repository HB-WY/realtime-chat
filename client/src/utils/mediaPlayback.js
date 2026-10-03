// client/src/utils/mediaPlayback.js
//
// 音视频的播放状态机（**纯函数，无 React / 无 DOM**）。
//
// 为什么单独拆出来：这段逻辑决定了「用户到底看到播放器、进度条、还是文件卡片」，
// 是转码功能里最容易出错的一环，而它本身完全不需要浏览器 —— 拆成纯函数就能在
// 隔离实例里直接断言（见 server/scripts/transcode_check.mjs 的状态机小节）。
//
// 四个阶段：
//   direct   先用原地址播 —— 绝大多数附件走这条，零额外开销
//   waiting  「原地址播不了」或「扩展名一看就不行」→ 去问后端（可能要转码）
//   play     用后端给的可播副本地址播
//   fallback 后端也救不了（转码失败 / 没装 ffmpeg / 不是媒体）→ 退回文件卡片
//
// ============================================================
// 转码提示（只是「提前判死刑」的启发式）
// ============================================================
// 这些容器浏览器**基本**都播不了。注意它只是「大概率」，不是判决：
//   · .mov/.mp4 里装 HEVC —— 扩展名看着没问题，实际照样播不了；
//   · .webm 里装 vp9+opus —— 名字不在下面，但浏览器能直接播。
// 真正的判决只有一个：问后端 /api/media/status（见 api/mediaApi.js）。
// 这里的作用仅仅是「省掉一次注定失败的加载」——让大 mkv 不必先下一段再报错。
//
// [NOTE] 这段刻意放在本模块而不是 utils/media.js：本文件必须**零 import**，
//        才能在 Node 里被回归脚本直接 import（Vite 能解析无扩展名导入，Node 不能）。
const TRANSCODE_HINT_RE =
  /\.(mkv|avi|flv|wmv|wma|rm|rmvb|asf|3gp|3g2|ts|m2ts|mts|mpg|mpeg|vob|ogm|ape|amr|ac3|dts|aiff|aif|mxf|divx)$/i;

/** 只是「提前判死刑」的启发式，返回 true 表示值得先去问后端 */
export function likelyNeedsTranscode(name) {
  return typeof name === 'string' && TRANSCODE_HINT_RE.test(name.trim());
}

export const PHASE_DIRECT = 'direct';
export const PHASE_WAITING = 'waiting';
export const PHASE_PLAY = 'play';
export const PHASE_FALLBACK = 'fallback';

/** 转码期间轮询间隔 */
export const POLL_MS = 2500;
/** 轮询次数上限（约 5 分钟）；之后停下并给「继续等待」按钮，不做无休止请求 */
export const POLL_MAX = 120;

/** 这条消息是不是「要内联播放的媒体」 */
export function isMediaMessage(message) {
  return (
    !message.isSticker &&
    !!message.fileUrl &&
    (message.fileType === 'video' || message.fileType === 'audio')
  );
}

export function initialMedia(message) {
  const base = {
    phase: PHASE_DIRECT,
    tried: false,        // 原地址是否已经真去播过并失败
    playUrl: null,
    progress: null,
    note: '',
    stalled: false,
    retryNonce: 0
  };
  if (!isMediaMessage(message)) return base;
  // 扩展名一看就是浏览器播不了的（mkv/avi/wma…）→ 别白下一段再报错，直接问后端。
  // 其余情况（含「.mp4 里装 HEVC」这种看不出来的）先试播，失败再问。
  return likelyNeedsTranscode(message.fileName)
    ? { ...base, phase: PHASE_WAITING, note: '正在检查是否需要转码…' }
    : base;
}

/**
 * 后端的一次回答 → 下一个状态。
 * @param {{phase:string, tried:boolean}} prev 当前状态（只看 phase / tried 两个字段，
 *        其余字段原样带回，所以调用方可以直接把整份 state 传进来）
 * @param {object|null} info GET /api/media/status 的响应；null = 这次查询失败
 */
export function nextMediaState(prev, info) {
  if (!info) {
    return { ...prev, phase: PHASE_WAITING, note: '正在查询转码状态…' };
  }
  if (info.status === 'ready' && info.playUrl) {
    return { ...prev, phase: PHASE_PLAY, playUrl: info.playUrl, progress: 1, note: '' };
  }
  if (info.status === 'pending') {
    return {
      ...prev,
      phase: PHASE_WAITING,
      progress: typeof info.progress === 'number' ? info.progress : null,
      note: info.reason || '正在用 ffmpeg 转码…'
    };
  }
  if (info.status === 'failed') {
    return { ...prev, phase: PHASE_FALLBACK, note: `转码失败：${info.error || '未知原因'}` };
  }
  // not_needed / unsupported / unavailable：后端认为不用转（或转不了）
  if (prev.tried) {
    return { ...prev, phase: PHASE_FALLBACK, note: '浏览器无法直接播放这个格式' };
  }
  return { ...prev, phase: PHASE_DIRECT, progress: null, note: '' };
}
